import {
  getCurrentSharingKey,
  getLegacyNoteContent,
  getNote,
  initializeNoteSection,
  listFolders,
  listNotes,
  reserveLegacyRootSection,
  storeCurrentSharingKey,
  updateFolder,
  type FolderSummary,
  type User
} from "../api";
import {
  createUserSharingKey,
  decryptNoteBodyWithKey,
  decryptFolderNameV2,
  encryptFolderNameV2,
  openUserSharingKey,
  type OpenedSharingKey
} from "../cryptoClient";
import { randomUuid } from "@fortnote/shared";
import {
  decryptNoteSummary,
  prepareSharingKeyEnvelopeMigrationV2
} from "../lib/keyMaterial";
import {
  createCrdtSectionInitializationManifest,
  editCrdtNote,
  openCrdtSection,
  preserveCrdtContent,
  replaceCrdtSectionOrder,
  seedLegacyCrdtSection,
  waitForCrdtSectionDurable,
  waitForCrdtSectionReady
} from "../realtime/crdt";
import { useAppStore } from "../store/appStore";
import type { DecryptedNote } from "../store/appStore";

interface LoadDecryptedNotesOptions {
  preserveSelection?: boolean;
}

const legacyMigrationSectionIds = new Map<string, string>();

export async function ensureLegacyNoteMigrated(
  note: DecryptedNote,
  signal?: AbortSignal
): Promise<void> {
  if (!note.legacyContentAvailable) {
    return;
  }
  const legacy = await getLegacyNoteContent(note.id);
  throwIfAborted(signal);
  if (legacy.keyEpoch !== note.keyEpoch) {
    throw new Error("Note key changed during legacy migration");
  }
  const body = await decryptNoteBodyWithKey({
    cryptoOwnerId: note.cryptoOwnerId,
    noteId: note.id,
    noteKeyBase64: note.noteKeyBase64,
    encryptedBody: {
      cipher: legacy.contentCipher,
      nonce: legacy.contentNonce,
      formatVersion: 1
    }
  });
  throwIfAborted(signal);
  if (note.isDeleted || note.role === "viewer") {
    seedLegacyCrdtSection(note, "root", body);
    updateMigratingNote(note, {
      contentLength: legacy.contentLength,
      legacyBodyLoaded: true,
      rootVersion: legacy.rootVersion,
      version: legacy.version
    });
    return;
  }

  const requestedSectionId =
    legacyMigrationSectionIds.get(note.id) ?? randomUuid();
  legacyMigrationSectionIds.set(note.id, requestedSectionId);
  let expectedRootVersion = legacy.rootVersion;
  for (;;) {
    throwIfAborted(signal);
    const reservation = await reserveLegacyRootSection(note.id, {
      sectionId: requestedSectionId,
      expectedKeyEpoch: note.keyEpoch,
      expectedRootVersion
    });
    expectedRootVersion = reservation.rootVersion;
    if (reservation.status === "complete") {
      finishLegacyMigration(note, reservation);
      legacyMigrationSectionIds.delete(note.id);
      return;
    }
    if (reservation.manifestId) {
      const initialized = await initializeCurrentSection(
        note,
        reservation.sectionId,
        reservation.manifestId,
        reservation.rootVersion
      );
      finishLegacyMigration(note, {
        ...reservation,
        rootVersion: initialized.rootVersion,
        version: initialized.version
      });
      legacyMigrationSectionIds.delete(note.id);
      return;
    }
    if (reservation.status === "pending") {
      await abortableDelay(1_500, signal);
      continue;
    }

    const migratingNote: DecryptedNote = {
      ...note,
      contentLength: legacy.contentLength,
      legacyBodyLoaded: true,
      rootSectionId: reservation.sectionId,
      rootVersion: reservation.rootVersion,
      version: reservation.version
    };
    openCrdtSection(migratingNote, "root");
    await waitForCrdtSectionReady(note.id, note.keyEpoch, "root", {
      ...(signal ? { signal } : {})
    });
    if (!replaceCrdtSectionOrder(note.id, [reservation.sectionId])) {
      throw new Error("Encrypted section order was not ready for migration");
    }
    const latestTitle = useAppStore.getState().notes.find(
      (candidate) => candidate.id === note.id && candidate.keyEpoch === note.keyEpoch
    )?.title;
    if (latestTitle !== undefined) {
      editCrdtNote(note, { title: latestTitle });
    }
    await waitForCrdtSectionDurable(note.id, note.keyEpoch, "root");
    seedLegacyCrdtSection(migratingNote, reservation.sectionId, body);
    openCrdtSection(migratingNote, reservation.sectionId);
    await waitForCrdtSectionReady(
      note.id,
      note.keyEpoch,
      reservation.sectionId,
      { ...(signal ? { signal } : {}) }
    );
    const manifest = await createCrdtSectionInitializationManifest(
      note.id,
      note.keyEpoch,
      reservation.sectionId
    );
    const initialized = await initializeCurrentSection(
      note,
      reservation.sectionId,
      manifest.manifestId,
      reservation.rootVersion
    );
    finishLegacyMigration(note, {
      ...reservation,
      rootVersion: initialized.rootVersion,
      version: initialized.version
    });
    legacyMigrationSectionIds.delete(note.id);
    return;
  }
}

async function initializeCurrentSection(
  note: DecryptedNote,
  sectionId: string,
  manifestId: string,
  expectedRootVersion: number
) {
  return initializeNoteSection(note.id, sectionId, {
    manifestId,
    expectedKeyEpoch: note.keyEpoch,
    expectedRootVersion
  });
}

function finishLegacyMigration(
  note: DecryptedNote,
  migrated: { sectionId: string; rootVersion: number; version: number }
): void {
  updateMigratingNote(note, {
    contentLength: 0,
    legacyBodyLoaded: false,
    legacyContentAvailable: false,
    rootSectionId: migrated.sectionId,
    rootVersion: migrated.rootVersion,
    version: migrated.version
  });
}

function updateMigratingNote(
  note: DecryptedNote,
  patch: Partial<DecryptedNote>
): void {
  const state = useAppStore.getState();
  if (
    state.user === null ||
    !state.notes.some(
      (candidate) => candidate.id === note.id && candidate.keyEpoch === note.keyEpoch
    )
  ) {
    return;
  }
  state.setNotes((notes) =>
    notes.map((candidate) =>
      candidate.id === note.id && candidate.keyEpoch === note.keyEpoch
        ? { ...candidate, ...patch }
        : candidate
    )
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Legacy migration canceled", "AbortError");
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("Legacy migration canceled", "AbortError")
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

export async function loadDecryptedNotes(
  currentUser: User,
  currentRootKey: Uint8Array,
  deleted = false,
  options: LoadDecryptedNotesOptions = {}
) {
  const requestScope = `decrypted-notes:${deleted ? "trash" : "active"}`;
  const initialNoteIds = new Set(
    (deleted ? useAppStore.getState().trashNotes : useAppStore.getState().notes).map(
      (note) => note.id
    )
  );
  const requestToken = useAppStore.getState().beginRequest(requestScope);
  try {
    const payload = await listNotes(deleted);
    const openedSharingKey = useAppStore.getState().openedSharingKey;
    const decrypted = await Promise.all(
      payload.notes
        .filter((note) => Boolean(note.isDeleted) === deleted)
        .map((note) =>
          decryptNoteSummary(currentUser, currentRootKey, note, openedSharingKey)
        )
    );
    const loadedNotes = deleted ? decrypted : decrypted.map(preserveCrdtContent);
    const state = useAppStore.getState();
    const locallyAddedNotes = (deleted ? state.trashNotes : state.notes).filter(
      (note) => !initialNoteIds.has(note.id) && !loadedNotes.some(({ id }) => id === note.id)
    );
    const nextNotes = [...loadedNotes, ...locallyAddedNotes].sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt)
    );

    if (
      state.user?.id !== currentUser.id ||
      state.rootKey !== currentRootKey ||
      !state.isCurrentRequest(requestScope, requestToken)
    ) {
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
  } finally {
    useAppStore.getState().finishRequest(requestScope, requestToken);
  }
}

export async function loadDecryptedNote(
  currentUser: User,
  currentRootKey: Uint8Array,
  noteId: string,
  options: {
    beforeCommit?: () => void;
    preserveRealtimeContent?: boolean;
  } = {}
): Promise<DecryptedNote | null> {
  const summary = await getNote(noteId);
  const openedSharingKey = useAppStore.getState().openedSharingKey;
  const decrypted = await decryptNoteSummary(
    currentUser,
    currentRootKey,
    summary,
    openedSharingKey
  );
  const nextNote =
    decrypted.isDeleted || options.preserveRealtimeContent === false
      ? decrypted
      : preserveCrdtContent(decrypted);
  const state = useAppStore.getState();
  if (state.user?.id !== currentUser.id || state.rootKey !== currentRootKey) {
    return null;
  }
  options.beforeCommit?.();
  if (!isCurrentVaultSession(currentUser.id, currentRootKey)) {
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

function isCurrentVaultSession(userId: string, rootKey: Uint8Array): boolean {
  const state = useAppStore.getState();
  return state.user?.id === userId && state.rootKey === rootKey;
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
