import {
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  permanentlyDeleteNote,
  restoreNote
} from "../api";
import {
  createProtectedNoteDraftV2,
  encryptFolderNameV2,
  noteKeyToBase64
} from "../cryptoClient";
import { randomUuid } from "@fortnote/shared";
import { useAppStore, type DecryptedNote } from "../store/appStore";
import { loadDecryptedNotes, loadFolders } from "./useAppData";
import { isCurrentSession, useNoteAutosave } from "./useNoteAutosave";

export { mergeDraftAfterConflict } from "./useNoteAutosave";

export function useNoteActions(selectedNote: DecryptedNote | null) {
  const user = useAppStore((state) => state.user);
  const rootKey = useAppStore((state) => state.rootKey);
  const notes = useAppStore((state) => state.notes);
  const trashNotes = useAppStore((state) => state.trashNotes);
  const folders = useAppStore((state) => state.folders);
  const selectedFolderId = useAppStore((state) => state.selectedFolderId);
  const setNotes = useAppStore((state) => state.setNotes);
  const setTrashNotes = useAppStore((state) => state.setTrashNotes);
  const setNotesView = useAppStore((state) => state.setNotesView);
  const setSelectedFolderId = useAppStore((state) => state.setSelectedFolderId);
  const setSelectedNoteId = useAppStore((state) => state.setSelectedNoteId);
  const setError = useAppStore((state) => state.setError);
  const setStatus = useAppStore((state) => state.setStatus);
  const reportOperationFailure = useAppStore((state) => state.reportOperationFailure);
  const { drainAutosave, showSaveIssues, updateSelectedNote, moveNoteToFolder } =
    useNoteAutosave();

  async function addNote(chosenFolderId?: string | null): Promise<boolean> {
    if (!user || !rootKey) {
      return false;
    }

    const sessionUserId = user.id;
    const sessionRootKey = rootKey;
    const targetFolderId =
      chosenFolderId === undefined ? selectedFolderId : chosenFolderId;
    setError(null);
    setStatus("Encrypting note");
    try {
      const draft = await createProtectedNoteDraftV2({
        cryptoOwnerId: user.id,
        rootKey,
        title: "Untitled note"
      });
      if (!isCurrentSession(sessionUserId, sessionRootKey)) {
        return false;
      }
      const created = await createNote({
        id: draft.id,
        folderId: targetFolderId,
        rootSectionId: draft.rootSectionId,
        titleCipher: draft.titleCipher,
        titleNonce: draft.titleNonce,
        titleFormatVersion: 2,
        encryptedNoteKey: draft.encryptedNoteKey,
        noteKeyNonce: draft.noteKeyNonce,
        noteKeyFormatVersion: 2
      });
      if (!isCurrentSession(sessionUserId, sessionRootKey)) {
        return false;
      }
      // Fence any note-list request that started before this local create while
      // keeping the new editor responsive. The response merges the local note
      // if it was captured before the create committed.
      void loadDecryptedNotes(user, rootKey, false, { preserveSelection: true }).catch(
        () => undefined
      );
      const note: DecryptedNote = {
        id: draft.id,
        folderId: targetFolderId,
        title: "Untitled note",
        noteKeyBase64: noteKeyToBase64(draft.noteKey),
        version: created.version,
        keyEpoch: 1,
        isDeleted: false,
        updatedAt: new Date().toISOString(),
        ownerUserId: user.id,
        cryptoOwnerId: user.id,
        role: "owner",
        rootVersion: created.rootVersion,
        rootSectionId: created.rootSectionId
      };
      setNotes((current) => [
        note,
        ...current.filter((candidate) => candidate.id !== note.id)
      ]);
      setSelectedNoteId(note.id);
      setStatus("Note encrypted and saved");
      return true;
    } catch (noteError) {
      if (!isCurrentSession(sessionUserId, sessionRootKey)) {
        return false;
      }
      reportOperationFailure(
        noteError,
        noteError instanceof Error ? noteError.message : "Unable to create note",
        "Save failed"
      );
      return false;
    }
  }

  async function addFolder(parentFolderId: string | null = null) {
    if (!user || !rootKey) {
      return;
    }
    const name = window.prompt("Folder name");
    if (!name?.trim()) {
      return;
    }

    setError(null);
    try {
      const id = randomUuid();
      const encryptedName = await encryptFolderNameV2({
        userId: user.id,
        folderId: id,
        rootKey,
        name: name.trim()
      });
      await createFolder({
        id,
        nameCipher: encryptedName.cipher,
        nameNonce: encryptedName.nonce,
        nameFormatVersion: 2,
        parentFolderId
      });
      await loadFolders();
      setStatus("Folder created");
    } catch (folderError) {
      setStatus("Folder failed");
      setError(
        folderError instanceof Error ? folderError.message : "Unable to create folder"
      );
    }
  }

  async function removeFolder(folderId: string) {
    const folder = folders.find(({ id }) => id === folderId);
    const folderName = folder?.name ?? "this folder";
    if (
      !window.confirm(
        `Delete folder "${folderName}"? Notes will move to its parent or All notes.`
      )
    ) {
      return;
    }
    setError(null);
    try {
      await deleteFolder(folderId);
      await loadFolders();
      if (selectedFolderId === folderId) {
        setSelectedFolderId(null);
      }
      if (user && rootKey) {
        await loadDecryptedNotes(user, rootKey, false, { preserveSelection: true });
      }
      setStatus("Folder deleted");
    } catch (folderError) {
      setStatus("Folder failed");
      setError(
        folderError instanceof Error ? folderError.message : "Unable to delete folder"
      );
    }
  }

  async function openTrash() {
    if (!user || !rootKey) {
      return;
    }

    setNotesView("trash");
    setSelectedFolderId(null);
    await loadDecryptedNotes(user, rootKey, true);
  }

  function openNotes(folderId: string | null = selectedFolderId) {
    setNotesView("notes");
    setSelectedFolderId(folderId);
    const nextNotes = folderId
      ? notes.filter((note) => note.folderId === folderId)
      : notes;
    setSelectedNoteId(nextNotes[0]?.id ?? null);
  }

  function openSharedNotes() {
    setNotesView("shared");
    setSelectedFolderId(null);
    setSelectedNoteId(notes.find((note) => note.role !== "owner")?.id ?? null);
  }

  async function moveSelectedToTrash() {
    if (!selectedNote) {
      return;
    }

    try {
      const saveResult = await drainAutosave(selectedNote.id);
      if (saveResult !== "saved") {
        showSaveIssues();
        return;
      }
      setError(null);
      await deleteNote(selectedNote.id);
      setNotes((current) => current.filter((note) => note.id !== selectedNote.id));
      const activeFolderId = useAppStore.getState().selectedFolderId;
      const nextVisibleNote = useAppStore
        .getState()
        .notes.find(
          (note) =>
            note.id !== selectedNote.id &&
            (activeFolderId === null || note.folderId === activeFolderId)
        );
      setSelectedNoteId(nextVisibleNote?.id ?? null);
      setStatus("Note moved to trash");
    } catch (deleteError) {
      setStatus("Delete failed");
      setError(
        deleteError instanceof Error ? deleteError.message : "Unable to delete note"
      );
    }
  }

  async function restoreSelectedNote() {
    if (!user || !rootKey || !selectedNote) {
      return;
    }

    setError(null);
    try {
      await restoreNote(selectedNote.id);
      await loadDecryptedNotes(user, rootKey, true);
      await loadDecryptedNotes(user, rootKey, false);
      setStatus("Note restored");
    } catch (restoreError) {
      setStatus("Restore failed");
      setError(
        restoreError instanceof Error ? restoreError.message : "Unable to restore note"
      );
    }
  }

  async function deleteSelectedForever() {
    if (!selectedNote) {
      return;
    }
    if (
      !window.confirm(
        `Permanently delete "${selectedNote.title}"? This cannot be undone.`
      )
    ) {
      return;
    }

    setError(null);
    try {
      await permanentlyDeleteNote(selectedNote.id);
      const nextTrash = trashNotes.filter((note) => note.id !== selectedNote.id);
      setTrashNotes(nextTrash);
      setSelectedNoteId(nextTrash[0]?.id ?? null);
      setStatus("Note permanently deleted");
    } catch (deleteError) {
      setStatus("Delete failed");
      setError(
        deleteError instanceof Error ? deleteError.message : "Unable to delete note"
      );
    }
  }

  return {
    addFolder,
    addNote,
    deleteSelectedForever,
    moveNoteToFolder,
    moveSelectedToTrash,
    openNotes,
    openSharedNotes,
    openTrash,
    removeFolder,
    restoreSelectedNote,
    updateSelectedNote
  };
}
