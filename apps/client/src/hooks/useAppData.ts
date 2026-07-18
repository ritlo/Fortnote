import {
  getCurrentSharingKey,
  getNote,
  listFolders,
  listNotes,
  storeCurrentSharingKey,
  updateFolder,
  type FolderSummary,
  type User
} from "../api";
import {
  createUserSharingKey,
  decryptFolderNameV2,
  encryptFolderNameV2,
  openUserSharingKey,
  type OpenedSharingKey
} from "../cryptoClient";
import {
  decryptNoteSummary,
  prepareSharingKeyEnvelopeMigrationV2
} from "../lib/keyMaterial";
import { preserveCrdtContent } from "../realtime/crdt";
import { useAppStore } from "../store/appStore";
import type { DecryptedNote } from "../store/appStore";

interface LoadDecryptedNotesOptions {
  preserveSelection?: boolean;
}

export async function loadDecryptedNotes(
  currentUser: User,
  currentRootKey: Uint8Array,
  deleted = false,
  options: LoadDecryptedNotesOptions = {}
) {
  const payload = await listNotes(deleted);
  const openedSharingKey = useAppStore.getState().openedSharingKey;
  const decrypted = await Promise.all(
    payload.notes
      .filter((note) => Boolean(note.isDeleted) === deleted)
      .map((note) =>
        decryptNoteSummary(currentUser, currentRootKey, note, openedSharingKey)
      )
  );
  const nextNotes = (deleted ? decrypted : decrypted.map(preserveCrdtContent)).sort(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt)
  );

  const state = useAppStore.getState();
  if (state.user?.id !== currentUser.id || state.rootKey !== currentRootKey) {
    return;
  }
  const { setAttachmentsByNote, setNotes, setSelectedNoteId, setTrashNotes } = state;
  if (deleted) {
    setTrashNotes(nextNotes);
  } else {
    setNotes(nextNotes);
  }
  const { notesView, selectedNoteId } = useAppStore.getState();
  const managesSelection = deleted
    ? notesView === "trash"
    : notesView === "notes" || notesView === "shared";
  if (!managesSelection) {
    return;
  }
  const nextSelectedNoteId =
    options.preserveSelection && nextNotes.some((note) => note.id === selectedNoteId)
      ? selectedNoteId
      : notesView === "shared"
        ? (nextNotes.find((note) => note.role !== "owner")?.id ?? null)
        : (nextNotes[0]?.id ?? null);
  setSelectedNoteId(nextSelectedNoteId);
  setAttachmentsByNote({});
}

export async function loadDecryptedNote(
  currentUser: User,
  currentRootKey: Uint8Array,
  noteId: string
): Promise<DecryptedNote | null> {
  const summary = await getNote(noteId);
  const openedSharingKey = useAppStore.getState().openedSharingKey;
  const decrypted = await decryptNoteSummary(
    currentUser,
    currentRootKey,
    summary,
    openedSharingKey
  );
  const nextNote = decrypted.isDeleted ? decrypted : preserveCrdtContent(decrypted);
  const state = useAppStore.getState();
  if (state.user?.id !== currentUser.id || state.rootKey !== currentRootKey) {
    return null;
  }
  if (nextNote.isDeleted) {
    state.setNotes((current) => current.filter((note) => note.id !== noteId));
    state.setTrashNotes((current) => upsertSortedNote(current, nextNote));
  } else {
    state.setTrashNotes((current) => current.filter((note) => note.id !== noteId));
    state.setNotes((current) => upsertSortedNote(current, nextNote));
  }
  reconcileTargetSelection(noteId);
  return nextNote;
}

export async function loadFolders() {
  const state = useAppStore.getState();
  if (!state.user || !state.rootKey) {
    return;
  }
  const currentUser = state.user;
  const currentRootKey = state.rootKey;
  const payload = await listFolders();
  const folders = await Promise.all(
    payload.folders.map(async (folder): Promise<FolderSummary> => {
      if (folder.nameFormatVersion !== 2) {
        let metadataMigration: FolderSummary["metadataMigration"];
        try {
          const encryptedName = await encryptFolderNameV2({
            userId: currentUser.id,
            folderId: folder.id,
            rootKey: currentRootKey,
            name: folder.name
          });
          await updateFolder(folder.id, {
            nameCipher: encryptedName.cipher,
            nameNonce: encryptedName.nonce,
            nameFormatVersion: 2,
            parentFolderId: folder.parentFolderId
          });
          metadataMigration = "current";
        } catch {
          metadataMigration = "retry-required";
        }
        return {
          id: folder.id,
          name: folder.name,
          parentFolderId: folder.parentFolderId,
          createdAt: folder.createdAt,
          updatedAt: folder.updatedAt,
          metadataMigration
        };
      }
      if (!folder.nameCipher || !folder.nameNonce) {
        throw new Error("Protected folder name is incomplete");
      }
      return {
        id: folder.id,
        name: await decryptFolderNameV2({
          userId: currentUser.id,
          folderId: folder.id,
          rootKey: currentRootKey,
          envelope: {
            cipher: folder.nameCipher,
            nonce: folder.nameNonce,
            formatVersion: 2
          }
        }),
        parentFolderId: folder.parentFolderId,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
        metadataMigration: "current"
      };
    })
  );
  const latest = useAppStore.getState();
  if (latest.user?.id === currentUser.id && latest.rootKey === currentRootKey) {
    latest.setFolders(folders);
  }
}

export async function ensureSharingKey(
  currentRootKey: Uint8Array
): Promise<OpenedSharingKey> {
  const { setOpenedSharingKey, user } = useAppStore.getState();
  try {
    const envelope = await getCurrentSharingKey();
    const opened = await openUserSharingKey({
      ...(user ? { userId: user.id } : {}),
      rootKey: currentRootKey,
      envelope
    });
    setOpenedSharingKey(opened);
    if (user) {
      const migration = await prepareSharingKeyEnvelopeMigrationV2({
        userId: user.id,
        rootKey: currentRootKey,
        envelope,
        opened
      });
      if (migration) {
        try {
          await storeCurrentSharingKey(migration);
        } catch {
          // The opened v1 key remains usable; retry the idempotent migration next unlock.
        }
      }
    }
    return opened;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Sharing key not found")) {
      throw error;
    }
  }

  if (!user) {
    throw new Error("Vault account is missing");
  }
  const created = await createUserSharingKey(currentRootKey, 1, user.id);
  await storeCurrentSharingKey(created.payload);
  setOpenedSharingKey(created.opened);
  return created.opened;
}

function upsertSortedNote(notes: DecryptedNote[], nextNote: DecryptedNote): DecryptedNote[] {
  return [nextNote, ...notes.filter((note) => note.id !== nextNote.id)].sort(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt)
  );
}

function reconcileTargetSelection(noteId: string): void {
  const state = useAppStore.getState();
  if (state.selectedNoteId !== noteId) {
    return;
  }
  const visibleNotes = state.notesView === "trash" ? state.trashNotes : state.notes;
  if (visibleNotes.some((note) => note.id === noteId)) {
    return;
  }
  state.setSelectedNoteId(
    state.notesView === "shared"
      ? (visibleNotes.find((note) => note.role !== "owner")?.id ?? null)
      : (visibleNotes[0]?.id ?? null)
  );
}
