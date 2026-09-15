import { fromBase64 } from "@fortnote/shared";
import { useEffect, useRef } from "react";
import { isApiRequestError, updateNote } from "../api";
import { encryptNoteTitleV2 } from "../cryptoClient";
import { editCrdtNote } from "../realtime/crdt";
import { useAppStore, type DecryptedNote } from "../store/appStore";
import { loadDecryptedNotes } from "./useAppData";

type SaveResult = "saved" | "conflict" | "failed" | "skipped";

export function useNoteAutosave() {
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const setNotes = useAppStore((state) => state.setNotes);
  const setSelectedNoteId = useAppStore((state) => state.setSelectedNoteId);
  const setError = useAppStore((state) => state.setError);
  const setStatus = useAppStore((state) => state.setStatus);
  const reportOperationFailure = useAppStore((state) => state.reportOperationFailure);
  const autosave = useRef({
    inFlightNoteId: null as string | null,
    issues: new Map<
      string,
      { error: string; result: "conflict" | "failed"; status: string }
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

  function showSaveIssues(): boolean {
    const coordinator = autosave.current;
    const selectedId = useAppStore.getState().selectedNoteId;
    const selectedIssue = selectedId ? coordinator.issues.get(selectedId) : undefined;
    const issue =
      (selectedId && selectedIssue
        ? ([selectedId, selectedIssue] as const)
        : undefined) ??
      [...coordinator.issues.entries()].find(
        ([, value]) => value.result === "conflict"
      ) ??
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
    error: string,
    status = result === "conflict" ? "Save conflict" : "Save failed"
  ) {
    autosave.current.issues.set(noteId, {
      error,
      result,
      status
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
    if (!state.user || !state.rootKey || !noteToSave || noteToSave.role === "viewer") {
      return "skipped";
    }
    const operation = createNoteOperationFence(state.user.id, state.rootKey, noteToSave);

    autosave.current.issues.delete(noteId);
    if (!showSaveIssues() && state.selectedNoteId === noteId) {
      autosave.current.statusNoteId = noteId;
      setError(null);
      setStatus("Encrypting note");
    }
    try {
      const noteKey = fromBase64(noteToSave.noteKeyBase64);
      const encryptedTitle = await encryptNoteTitleV2({
        cryptoOwnerId: noteToSave.cryptoOwnerId,
        noteId: noteToSave.id,
        keyEpoch: noteToSave.keyEpoch,
        noteKey,
        title: noteToSave.title
      });
      if (!isCurrentNoteOperation(operation)) {
        finishSuccessfulSave(noteId);
        return "skipped";
      }
      const saved = await updateNote(noteToSave.id, {
        titleCipher: encryptedTitle.cipher,
        titleNonce: encryptedTitle.nonce,
        titleFormatVersion: 2,
        folderId: noteToSave.folderId,
        rootVersion: noteToSave.rootVersion ?? noteToSave.version,
        keyEpoch: noteToSave.keyEpoch
      });
      if (!isCurrentNoteOperation(operation)) {
        finishSuccessfulSave(noteId);
        return "skipped";
      }
      setNotes((current) =>
        current.map((note) =>
          note.id === noteToSave.id
            ? note.version > noteToSave.version
              ? note
              : {
                  ...note,
                  version: saved.version ?? note.version,
                  rootVersion: saved.rootVersion ?? note.rootVersion ?? note.version,
                  updatedAt: saved.updatedAt
                }
            : note
        )
      );
      finishSuccessfulSave(noteId);
      return "saved";
    } catch (saveError) {
      if (!isCurrentNoteOperation(operation)) {
        finishSuccessfulSave(noteId);
        return "skipped";
      }
      if (isApiRequestError(saveError) && saveError.code === "conflict") {
        await preserveDraftAfterSaveConflict(noteToSave.id, state.user.id, state.rootKey);
        return "conflict";
      }

      const failure = reportOperationFailure(
        saveError,
        saveError instanceof Error ? saveError.message : "Unable to save note",
        "Save failed"
      );
      recordSaveIssue(noteId, "failed", failure.message, failure.status);
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
      if (
        session.user &&
        session.rootKey &&
        isCurrentSession(session.user.id, session.rootKey)
      ) {
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

    const latestNote = useAppStore.getState().notes.find((note) => note.id === noteId);
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
        return queuedDraft ? mergeDraftAfterConflict(note, queuedDraft) : note;
      })
    );
    setSelectedNoteId(noteId);
    recordSaveIssue(
      noteId,
      "conflict",
      "Note changed elsewhere. Your draft is still open; review it before saving again."
    );
  }

  function updateSelectedNote(patch: Partial<Pick<DecryptedNote, "folderId" | "title">>) {
    if (!selectedNoteId) {
      return;
    }

    const note = useAppStore.getState().notes.find(({ id }) => id === selectedNoteId);
    if (
      !note ||
      ((patch.folderId === undefined || patch.folderId === note.folderId) &&
        (patch.title === undefined || patch.title === note.title))
    ) {
      return;
    }
    const canSave =
      note.role !== "viewer" && useAppStore.getState().notesView !== "trash";
    if (canSave && patch.title !== undefined) {
      editCrdtNote(note, { title: patch.title });
    }
    setNotes((current) =>
      current.map((item) => (item.id === selectedNoteId ? { ...item, ...patch } : item))
    );
    if (canSave) {
      scheduleAutosave(note.id);
    }
  }

  async function moveNoteToFolder(noteId: string, folderId: string | null) {
    const state = useAppStore.getState();
    const note = state.notes.find((n) => n.id === noteId);
    const validFolder =
      folderId === null || state.folders.some((folder) => folder.id === folderId);
    if (
      !note ||
      note.role === "viewer" ||
      state.notesView !== "notes" ||
      !validFolder ||
      note.folderId === folderId
    ) {
      return;
    }
    const previousFolderId = note.folderId;
    setNotes((current) => current.map((n) => (n.id === noteId ? { ...n, folderId } : n)));
    scheduleAutosave(noteId);
    const saveResult = await drainAutosave(noteId);
    if (saveResult === "failed" || saveResult === "conflict") {
      setNotes((current) =>
        current.map((n) => (n.id === noteId ? { ...n, folderId: previousFolderId } : n))
      );
      return;
    }
    const latestState = useAppStore.getState();
    if (
      latestState.selectedNoteId === noteId &&
      latestState.notesView === "notes" &&
      latestState.selectedFolderId !== null &&
      folderId !== latestState.selectedFolderId
    ) {
      const nextVisibleNote = latestState.notes.find(
        (candidate) =>
          candidate.id !== noteId && candidate.folderId === latestState.selectedFolderId
      );
      setSelectedNoteId(nextVisibleNote?.id ?? null);
    }
  }

  return { drainAutosave, showSaveIssues, updateSelectedNote, moveNoteToFolder };
}

export function isCurrentSession(userId: string, rootKey: Uint8Array): boolean {
  const state = useAppStore.getState();
  return state.user?.id === userId && state.rootKey === rootKey;
}

interface NoteOperationFence {
  userId: string;
  rootKey: Uint8Array;
  noteId: string;
  cryptoOwnerId: string;
  keyEpoch: number;
  version: number;
  rootVersion: number;
}

function createNoteOperationFence(
  userId: string,
  rootKey: Uint8Array,
  note: DecryptedNote
): NoteOperationFence {
  return {
    userId,
    rootKey,
    noteId: note.id,
    cryptoOwnerId: note.cryptoOwnerId,
    keyEpoch: note.keyEpoch,
    version: note.version,
    rootVersion: note.rootVersion ?? note.version
  };
}

function isCurrentNoteOperation(fence: NoteOperationFence): boolean {
  const state = useAppStore.getState();
  const note = state.notes.find((candidate) => candidate.id === fence.noteId);
  return (
    state.user?.id === fence.userId &&
    state.rootKey === fence.rootKey &&
    note?.cryptoOwnerId === fence.cryptoOwnerId &&
    note.keyEpoch === fence.keyEpoch &&
    note.version === fence.version &&
    (note.rootVersion ?? note.version) === fence.rootVersion
  );
}

export function mergeDraftAfterConflict(
  latestNote: DecryptedNote,
  draft: DecryptedNote
): DecryptedNote {
  return {
    ...latestNote,
    folderId: draft.folderId,
    title: draft.title
  };
}
