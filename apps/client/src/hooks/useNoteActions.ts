import {
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  permanentlyDeleteNote,
  restoreNote,
  updateNote
} from "../api";
import {
  createEncryptedNoteDraft,
  encryptExistingNoteBody,
  noteKeyToBase64
} from "../cryptoClient";
import { useAppStore, type DecryptedNote } from "../store/appStore";
import { loadDecryptedNotes, loadFolders } from "./useAppData";

export function useNoteActions(selectedNote: DecryptedNote | null) {
  const user = useAppStore((state) => state.user);
  const rootKey = useAppStore((state) => state.rootKey);
  const notes = useAppStore((state) => state.notes);
  const trashNotes = useAppStore((state) => state.trashNotes);
  const selectedFolderId = useAppStore((state) => state.selectedFolderId);
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const setNotes = useAppStore((state) => state.setNotes);
  const setTrashNotes = useAppStore((state) => state.setTrashNotes);
  const setNotesView = useAppStore((state) => state.setNotesView);
  const setSelectedFolderId = useAppStore((state) => state.setSelectedFolderId);
  const setSelectedNoteId = useAppStore((state) => state.setSelectedNoteId);
  const setError = useAppStore((state) => state.setError);
  const setStatus = useAppStore((state) => state.setStatus);

  async function addNote() {
    if (!user || !rootKey) {
      return;
    }

    setError(null);
    setStatus("Encrypting note");
    try {
      const draft = await createEncryptedNoteDraft({
        userId: user.id,
        rootKey,
        title: "Untitled note",
        body: ""
      });
      const created = await createNote({
        id: draft.id,
        folderId: selectedFolderId,
        title: draft.title,
        encryptedNoteKey: draft.encryptedNoteKey,
        noteKeyNonce: draft.noteKeyNonce,
        contentCipher: draft.contentCipher,
        contentNonce: draft.contentNonce,
        contentLength: draft.contentLength
      });
      const note: DecryptedNote = {
        id: draft.id,
        folderId: selectedFolderId,
        title: draft.title,
        body: "",
        noteKeyBase64: noteKeyToBase64(draft.noteKey),
        contentLength: draft.contentLength,
        version: created.version,
        isDeleted: false,
        updatedAt: new Date().toISOString(),
        ownerUserId: user.id,
        cryptoOwnerId: user.id,
        role: "owner"
      };
      setNotes((current) => [note, ...current]);
      setSelectedNoteId(note.id);
      setStatus("Note encrypted and saved");
    } catch (noteError) {
      setStatus("Save failed");
      setError(noteError instanceof Error ? noteError.message : "Unable to create note");
    }
  }

  async function saveSelectedNote() {
    if (!user || !selectedNote) {
      return;
    }

    setError(null);
    setStatus("Encrypting note");
    try {
      const encrypted = await encryptExistingNoteBody({
        userId: selectedNote.cryptoOwnerId,
        noteId: selectedNote.id,
        noteKeyBase64: selectedNote.noteKeyBase64,
        body: selectedNote.body
      });
      const saved = await updateNote(selectedNote.id, {
        title: selectedNote.title,
        folderId: selectedNote.folderId,
        version: selectedNote.version,
        ...encrypted
      });
      setNotes((current) =>
        current.map((note) =>
          note.id === selectedNote.id
            ? {
                ...note,
                contentLength: encrypted.contentLength,
                version: saved.version,
                updatedAt: new Date().toISOString()
              }
            : note
        )
      );
      setStatus("Note encrypted and saved");
    } catch (saveError) {
      setStatus("Save failed");
      setError(saveError instanceof Error ? saveError.message : "Unable to save note");
    }
  }

  function updateSelectedNote(
    patch: Partial<Pick<DecryptedNote, "folderId" | "title" | "body">>
  ) {
    if (!selectedNoteId) {
      return;
    }

    setNotes((current) =>
      current.map((note) => (note.id === selectedNoteId ? { ...note, ...patch } : note))
    );
  }

  async function addFolder(parentFolderId: string | null = null) {
    const name = window.prompt("Folder name");
    if (!name?.trim()) {
      return;
    }

    setError(null);
    try {
      await createFolder({ name: name.trim(), parentFolderId });
      await loadFolders();
      setStatus("Folder created");
    } catch (folderError) {
      setStatus("Folder failed");
      setError(folderError instanceof Error ? folderError.message : "Unable to create folder");
    }
  }

  async function removeFolder(folderId: string) {
    setError(null);
    try {
      await deleteFolder(folderId);
      await loadFolders();
      if (selectedFolderId === folderId) {
        setSelectedFolderId(null);
      }
      setStatus("Folder deleted");
    } catch (folderError) {
      setStatus("Folder failed");
      setError(folderError instanceof Error ? folderError.message : "Unable to delete folder");
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
    const nextNotes = folderId ? notes.filter((note) => note.folderId === folderId) : notes;
    setSelectedNoteId(nextNotes[0]?.id ?? null);
  }

  async function moveSelectedToTrash() {
    if (!selectedNote) {
      return;
    }

    setError(null);
    try {
      await deleteNote(selectedNote.id);
      setNotes((current) => current.filter((note) => note.id !== selectedNote.id));
      setSelectedNoteId(notes.find((note) => note.id !== selectedNote.id)?.id ?? null);
      setStatus("Note moved to trash");
    } catch (deleteError) {
      setStatus("Delete failed");
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete note");
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
      setError(restoreError instanceof Error ? restoreError.message : "Unable to restore note");
    }
  }

  async function deleteSelectedForever() {
    if (!selectedNote) {
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
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete note");
    }
  }

  return {
    addFolder,
    addNote,
    deleteSelectedForever,
    moveSelectedToTrash,
    openNotes,
    openTrash,
    removeFolder,
    restoreSelectedNote,
    saveSelectedNote,
    updateSelectedNote
  };
}
