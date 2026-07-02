import {
  getCurrentSharingKey,
  listFolders,
  listNotes,
  storeCurrentSharingKey,
  type User
} from "../api";
import {
  createUserSharingKey,
  openUserSharingKey,
  type OpenedSharingKey
} from "../cryptoClient";
import { decryptNoteSummary } from "../lib/keyMaterial";
import { useAppStore } from "../store/appStore";

export async function loadDecryptedNotes(
  currentUser: User,
  currentRootKey: Uint8Array,
  deleted = false
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
  const nextNotes = decrypted.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );

  const { setAttachmentsByNote, setNotes, setSelectedNoteId, setTrashNotes } =
    useAppStore.getState();
  if (deleted) {
    setTrashNotes(nextNotes);
  } else {
    setNotes(nextNotes);
  }
  setSelectedNoteId(nextNotes[0]?.id ?? null);
  setAttachmentsByNote({});
}

export async function loadFolders() {
  const payload = await listFolders();
  useAppStore.getState().setFolders(payload.folders);
}

export async function ensureSharingKey(
  currentRootKey: Uint8Array
): Promise<OpenedSharingKey> {
  const { setOpenedSharingKey } = useAppStore.getState();
  try {
    const envelope = await getCurrentSharingKey();
    const opened = await openUserSharingKey({ rootKey: currentRootKey, envelope });
    setOpenedSharingKey(opened);
    return opened;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Sharing key not found")) {
      throw error;
    }
  }

  const created = await createUserSharingKey(currentRootKey);
  await storeCurrentSharingKey(created.payload);
  setOpenedSharingKey(created.opened);
  return created.opened;
}
