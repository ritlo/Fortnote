import {
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  isApiRequestError,
  permanentlyDeleteNote,
  restoreNote,
  updateNote
} from "../api";
import {
  createEncryptedNoteDraft,
  encryptExistingNoteBody,
  noteKeyToBase64
} from "../cryptoClient";
import { useEffect, useRef } from "react";
import { useAppStore, type DecryptedNote } from "../store/appStore";
import { checkpointCrdtNote } from "../realtime/crdt";
import { loadDecryptedNotes, loadFolders } from "./useAppData";

type SaveResult = "saved" | "conflict" | "failed" | "skipped";

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
  const autosave = useRef({
    inFlightNoteId: null as string | null,
    issues: new Map<
      string,
      { error: string; result: "conflict" | "failed"; status: "Save conflict" | "Save failed" }
    >(),
    pending: new Set<string>(),
    statusNoteId: null as string | null,
    timer: null as number | null,
    waiters: new Map<string, ((result: SaveResult) => void)[]>()
  });

  useEffect(
    () => () => {
      if (autosave.current.timer !== null) {
        window.clearTimeout(autosave.current.timer);
      }
    },
    []
  );

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
        keyEpoch: 1,
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

  function showSaveIssues(): boolean {
    const coordinator = autosave.current;
    const selectedId = useAppStore.getState().selectedNoteId;
    const selectedIssue = selectedId
      ? coordinator.issues.get(selectedId)
      : undefined;
    const issue =
      (selectedId && selectedIssue
        ? ([selectedId, selectedIssue] as const)
        : undefined) ??
      [...coordinator.issues.entries()].find(([, value]) => value.result === "conflict") ??
      coordinator.issues.entries().next().value;
    if (!issue) {
      return false;
    }
    const [noteId, value] = issue;
    coordinator.statusNoteId = noteId;
    setStatus(value.status);
    setError(value.error);
    return true;
  }

  function recordSaveIssue(
    noteId: string,
    result: "conflict" | "failed",
    error: string
  ) {
    autosave.current.issues.set(noteId, {
      error,
      result,
      status: result === "conflict" ? "Save conflict" : "Save failed"
    });
    showSaveIssues();
  }

  function finishSuccessfulSave(noteId: string) {
    const coordinator = autosave.current;
    coordinator.issues.delete(noteId);
    if (
      !showSaveIssues() &&
      coordinator.statusNoteId === noteId &&
      useAppStore.getState().status === "Encrypting note"
    ) {
      setStatus("Ready");
      setError(null);
    }
    if (coordinator.statusNoteId === noteId) {
      coordinator.statusNoteId = null;
    }
  }

  function resolveSaveWaiters(noteId: string, result: SaveResult) {
    const coordinator = autosave.current;
    if (coordinator.pending.has(noteId)) {
      return;
    }
    const waiters = coordinator.waiters.get(noteId) ?? [];
    coordinator.waiters.delete(noteId);
    waiters.forEach((resolve) => {
      resolve(result);
    });
  }

  async function saveNote(noteId: string): Promise<SaveResult> {
    const state = useAppStore.getState();
    const noteToSave = state.notes.find((note) => note.id === noteId);
    if (
      !state.user ||
      !state.rootKey ||
      !noteToSave ||
      noteToSave.role === "viewer"
    ) {
      return "skipped";
    }

    autosave.current.issues.delete(noteId);
    if (!showSaveIssues() && state.selectedNoteId === noteId) {
      autosave.current.statusNoteId = noteId;
      setError(null);
      setStatus("Encrypting note");
    }
    try {
      const encrypted = await encryptExistingNoteBody({
        userId: noteToSave.cryptoOwnerId,
        noteId: noteToSave.id,
        noteKeyBase64: noteToSave.noteKeyBase64,
        body: noteToSave.body
      });
      const saved = await updateNote(noteToSave.id, {
        title: noteToSave.title,
        folderId: noteToSave.folderId,
        version: noteToSave.version,
        ...encrypted
      });
      await checkpointCrdtNote({
        ...noteToSave,
        contentLength: encrypted.contentLength,
        updatedAt: saved.updatedAt,
        version: saved.version
      });
      if (!isCurrentSession(state.user.id, state.rootKey)) {
        return "skipped";
      }
      setNotes((current) =>
        current.map((note) =>
          note.id === noteToSave.id
            ? note.version > noteToSave.version
              ? note
              : {
                ...note,
                contentLength:
                  note.body === noteToSave.body
                    ? encrypted.contentLength
                    : new TextEncoder().encode(note.body).length,
                version: saved.version,
                updatedAt: saved.updatedAt
              }
            : note
        )
      );
      finishSuccessfulSave(noteId);
      return "saved";
    } catch (saveError) {
      if (!isCurrentSession(state.user.id, state.rootKey)) {
        return "skipped";
      }
      if (isApiRequestError(saveError) && saveError.code === "conflict") {
        await preserveDraftAfterSaveConflict(noteToSave.id, state.user.id, state.rootKey);
        return "conflict";
      }

      recordSaveIssue(
        noteId,
        "failed",
        saveError instanceof Error ? saveError.message : "Unable to save note"
      );
      return "failed";
    }
  }

  function scheduleAutosave(noteId: string) {
    const coordinator = autosave.current;
    coordinator.pending.add(noteId);
    if (coordinator.timer !== null) {
      window.clearTimeout(coordinator.timer);
    }
    if (!coordinator.inFlightNoteId) {
      coordinator.timer = window.setTimeout(() => {
        void flushAutosave();
      }, 500);
    }
  }

  async function flushAutosave() {
    const coordinator = autosave.current;
    const noteId = coordinator.pending.values().next().value;
    if (!noteId || coordinator.inFlightNoteId) {
      return;
    }

    coordinator.pending.delete(noteId);
    coordinator.timer = null;
    coordinator.inFlightNoteId = noteId;
    const session = useAppStore.getState();
    let result: SaveResult = "failed";
    try {
      result = await saveNote(noteId);
    } catch (saveError) {
      if (session.user && session.rootKey && isCurrentSession(session.user.id, session.rootKey)) {
        recordSaveIssue(
          noteId,
          "failed",
          saveError instanceof Error ? saveError.message : "Unable to save note"
        );
      }
    } finally {
      coordinator.inFlightNoteId = null;
    }

    if (result === "conflict") {
      coordinator.pending.delete(noteId);
    }
    resolveSaveWaiters(noteId, result);
    if (coordinator.pending.size > 0) {
      void flushAutosave();
    }
  }

  async function drainAutosave(noteId: string): Promise<SaveResult> {
    const coordinator = autosave.current;
    if (coordinator.timer !== null) {
      window.clearTimeout(coordinator.timer);
      coordinator.timer = null;
    }
    if (!coordinator.inFlightNoteId) {
      void flushAutosave();
    }
    if (coordinator.inFlightNoteId === noteId || coordinator.pending.has(noteId)) {
      return new Promise<SaveResult>((resolve) => {
        coordinator.waiters.set(noteId, [
          ...(coordinator.waiters.get(noteId) ?? []),
          resolve
        ]);
      });
    }
    return coordinator.issues.get(noteId)?.result ?? "saved";
  }

  async function preserveDraftAfterSaveConflict(
    noteId: string,
    userId: string,
    sessionRootKey: Uint8Array
  ) {
    const session = useAppStore.getState();
    const draft = session.notes.find((note) => note.id === noteId);
    const queuedDrafts = new Map(
      session.notes
        .filter((note) => autosave.current.pending.has(note.id) && note.id !== noteId)
        .map((note) => [note.id, note])
    );
    if (session.user?.id !== userId || session.rootKey !== sessionRootKey || !draft) {
      return;
    }

    autosave.current.statusNoteId = noteId;
    setStatus("Resolving save conflict");
    await loadDecryptedNotes(session.user, sessionRootKey, false);
    if (!isCurrentSession(userId, sessionRootKey)) {
      return;
    }

    const latestNote = useAppStore
      .getState()
      .notes.find((note) => note.id === noteId);
    if (!latestNote) {
      recordSaveIssue(
        noteId,
        "conflict",
        "Note changed elsewhere, but the latest copy could not be loaded."
      );
      return;
    }

    setNotes((current) =>
      current.map((note) => {
        if (note.id === noteId) {
          return mergeDraftAfterConflict(latestNote, draft);
        }
        const queuedDraft = queuedDrafts.get(note.id);
        return queuedDraft
          ? mergeDraftAfterConflict(note, queuedDraft)
          : note;
      })
    );
    setSelectedNoteId(noteId);
    recordSaveIssue(
      noteId,
      "conflict",
      "Note changed elsewhere. Your draft is still open; review it before saving again."
    );
  }

  function updateSelectedNote(
    patch: Partial<Pick<DecryptedNote, "folderId" | "title" | "body">>
  ) {
    if (!selectedNoteId) {
      return;
    }

    const note = useAppStore.getState().notes.find(({ id }) => id === selectedNoteId);
    if (
      !note ||
      ((patch.folderId === undefined || patch.folderId === note.folderId) &&
        (patch.title === undefined || patch.title === note.title) &&
        (patch.body === undefined || patch.body === note.body))
    ) {
      return;
    }
    setNotes((current) =>
      current.map((item) => (item.id === selectedNoteId ? { ...item, ...patch } : item))
    );
    if (note.role !== "viewer" && useAppStore.getState().notesView !== "trash") {
      scheduleAutosave(note.id);
    }
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
    openSharedNotes,
    openTrash,
    removeFolder,
    restoreSelectedNote,
    updateSelectedNote
  };
}

function isCurrentSession(userId: string, rootKey: Uint8Array): boolean {
  const state = useAppStore.getState();
  return state.user?.id === userId && state.rootKey === rootKey;
}

export function mergeDraftAfterConflict(
  latestNote: DecryptedNote,
  draft: DecryptedNote
): DecryptedNote {
  return {
    ...latestNote,
    body: draft.body,
    contentLength: new TextEncoder().encode(draft.body).length,
    folderId: draft.folderId,
    title: draft.title
  };
}
