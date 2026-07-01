import { listFolders, listNotes, type User } from "../api";
import { decryptNoteSummary } from "../lib/keyMaterial";
import { useAppStore } from "../store/appStore";

export async function loadDecryptedNotes(
  currentUser: User,
  currentRootKey: Uint8Array,
  deleted = false
) {
  const payload = await listNotes(deleted);
  const decrypted = await Promise.all(
    payload.notes
      .filter((note) => Boolean(note.isDeleted) === deleted)
      .map((note) => decryptNoteSummary(currentUser, currentRootKey, note))
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
