// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedNote } from "../store/appStore";
import { useAppStore } from "../store/appStore";

const mocks = vi.hoisted(() => ({
  deleteNote: vi.fn(),
  editCrdtNote: vi.fn(() => true),
  encrypt: vi.fn(),
  encryptNoteKey: vi.fn(),
  loadNotes: vi.fn(),
  updateNote: vi.fn()
}));

vi.mock("../api", () => ({
  createFolder: vi.fn(),
  createNote: vi.fn(),
  deleteFolder: vi.fn(),
  deleteNote: mocks.deleteNote,
  isApiRequestError: (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error,
  permanentlyDeleteNote: vi.fn(),
  restoreNote: vi.fn(),
  updateNote: mocks.updateNote
}));

vi.mock("../cryptoClient", () => ({
  createProtectedNoteDraftV2: vi.fn(),
  encryptFolderNameV2: vi.fn(),
  encryptNoteKeyEnvelopeV2: mocks.encryptNoteKey,
  encryptNoteTitleV2: mocks.encrypt,
  noteKeyToBase64: vi.fn()
}));

vi.mock("./useAppData", () => ({
  loadDecryptedNotes: mocks.loadNotes,
  loadFolders: vi.fn()
}));

vi.mock("../realtime/crdt", () => ({
  editCrdtNote: mocks.editCrdtNote
}));

import { mergeDraftAfterConflict, useNoteActions } from "./useNoteActions";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.encrypt.mockResolvedValue({
    cipher: "cipher",
    formatVersion: 2,
    nonce: "nonce"
  });
  mocks.encryptNoteKey.mockResolvedValue({
    cipher: "protected-note-key",
    formatVersion: 2,
    nonce: "protected-note-key-nonce"
  });
  mocks.updateNote.mockResolvedValue({
    id: "note_1",
    rootVersion: 2,
    version: 2,
    updatedAt: "2026-07-02T00:00:01.000Z"
  });
  mocks.deleteNote.mockResolvedValue(undefined);
  mocks.loadNotes.mockResolvedValue(undefined);
  useAppStore.setState({
    error: null,
    notes: [note()],
    notesView: "notes",
    rootKey: new Uint8Array([1]),
    selectedNoteId: "note_1",
    status: "Ready",
    user: { id: "alice", username: "alice" }
  });
});

afterEach(() => {
  vi.useRealTimers();
  useAppStore.getState().resetVaultState("reset");
});

describe("note autosave", () => {
  it("coalesces real changes and encrypts the latest snapshot after 500 ms", async () => {
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "First" });
      result.current.updateSelectedNote({ title: "Latest" });
      result.current.updateSelectedNote({ title: "Latest" });
    });
    expect(mocks.editCrdtNote).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "note_1", title: "First" }),
      { title: "Latest" }
    );
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(mocks.updateNote).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.updateNote).toHaveBeenCalledOnce();
    expect(mocks.encrypt).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Latest", noteId: "note_1" })
    );
    expect(mocks.updateNote).toHaveBeenCalledWith(
      "note_1",
      expect.objectContaining({
        titleCipher: "cipher",
        titleNonce: "nonce",
        rootVersion: 1
      })
    );
  });

  it("saves every note edited before the debounce expires", async () => {
    useAppStore.setState({ notes: [note(), note({ id: "note_2", title: "Second" })] });
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "First draft" });
      useAppStore.getState().setSelectedNoteId("note_2");
    });
    act(() => {
      result.current.updateSelectedNote({ title: "Second draft" });
    });
    await advanceAutosave();

    expect(mocks.updateNote).toHaveBeenNthCalledWith(1, "note_1", expect.any(Object));
    expect(mocks.updateNote).toHaveBeenNthCalledWith(2, "note_2", expect.any(Object));
  });

  it("does not autosave identical, viewer, or trash updates", async () => {
    const { result, rerender } = renderHook(
      ({ selected }) => useNoteActions(selected),
      { initialProps: { selected: note() } }
    );

    act(() => {
      result.current.updateSelectedNote({ title: "Title" });
    });
    await advanceAutosave();

    useAppStore.setState({ notes: [note({ role: "viewer" })] });
    rerender({ selected: note({ role: "viewer" }) });
    act(() => {
      result.current.updateSelectedNote({ title: "Viewer edit" });
    });
    await advanceAutosave();

    useAppStore.setState({ notes: [note()], notesView: "trash" });
    rerender({ selected: note() });
    act(() => {
      result.current.updateSelectedNote({ title: "Trash edit" });
    });
    await advanceAutosave();

    expect(mocks.updateNote).not.toHaveBeenCalled();
  });

  it("finishes a pending active-note save after opening trash", async () => {
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Pending draft" });
      useAppStore.getState().setNotesView("trash");
    });
    await advanceAutosave();

    expect(mocks.updateNote).toHaveBeenCalledWith(
      "note_1",
      expect.objectContaining({ titleCipher: "cipher" })
    );
  });

  it("saves a pending draft before moving its note to trash", async () => {
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Draft before delete" });
    });
    await act(async () => result.current.moveSelectedToTrash());

    expect(mocks.updateNote).toHaveBeenCalledOnce();
    expect(mocks.deleteNote).toHaveBeenCalledWith("note_1");
    expect(mocks.updateNote.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteNote.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("serializes saves and follows an in-flight save with the latest draft", async () => {
    let finishFirst!: (value: {
      id: string;
      rootVersion: number;
      version: number;
      updatedAt: string;
    }) => void;
    mocks.updateNote
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishFirst = resolve;
        })
      )
      .mockResolvedValueOnce({
        id: "note_1",
        rootVersion: 3,
        version: 3,
        updatedAt: "2026-07-02T00:00:02.000Z"
      });
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "First" });
    });
    await advanceAutosave();
    expect(mocks.updateNote).toHaveBeenCalledOnce();
    act(() => {
      result.current.updateSelectedNote({ title: "Latest" });
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(mocks.updateNote).toHaveBeenCalledOnce();

    act(() => {
      finishFirst({
        id: "note_1",
        rootVersion: 2,
        version: 2,
        updatedAt: "2026-07-02T00:00:01.000Z"
      });
    });
    await waitForAssertion(() => {
      expect(mocks.updateNote).toHaveBeenCalledTimes(2);
    });
    expect(mocks.updateNote.mock.calls[1]?.[1]).toMatchObject({
      rootVersion: 2,
      titleCipher: "cipher"
    });
    expect(useAppStore.getState().notes[0]?.title).toBe("Latest");
  });

  it("does not downgrade metadata advanced by realtime during a save", async () => {
    let finishSave!: (value: {
      id: string;
      rootVersion: number;
      version: number;
      updatedAt: string;
    }) => void;
    mocks.updateNote.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishSave = resolve;
      })
    );
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Local draft" });
    });
    await advanceAutosave();
    act(() => {
      useAppStore.setState({
        notes: [note({ title: "Converged draft", updatedAt: "2026-07-03T00:00:00.000Z", version: 3 })]
      });
      finishSave({
        id: "note_1",
        rootVersion: 2,
        version: 2,
        updatedAt: "2026-07-02T00:00:01.000Z"
      });
    });
    await waitForAssertion(() => {
      expect(useAppStore.getState().status).toBe("Ready");
    });

    expect(useAppStore.getState().notes[0]).toMatchObject({
      title: "Converged draft",
      updatedAt: "2026-07-03T00:00:00.000Z",
      version: 3
    });
  });

  it("does not overwrite an old epoch after realtime replaces the note", async () => {
    let finishSave!: (value: {
      id: string;
      rootVersion: number;
      version: number;
      updatedAt: string;
    }) => void;
    mocks.updateNote.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishSave = resolve;
      })
    );
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Old epoch draft" });
    });
    await advanceAutosave();
    act(() => {
      useAppStore.setState({
        notes: [note({
          keyEpoch: 2,
          noteKeyBase64: "replacement-key",
          rootVersion: 2,
          title: "New epoch title",
          version: 2
        })]
      });
      finishSave({
        id: "note_1",
        rootVersion: 2,
        version: 2,
        updatedAt: "2026-07-03T00:00:00.000Z"
      });
    });
    await waitForAssertion(() => {
      expect(useAppStore.getState().status).toBe("Ready");
    });

    expect(useAppStore.getState().notes[0]).toMatchObject({
      keyEpoch: 2,
      noteKeyBase64: "replacement-key",
      title: "New epoch title",
      version: 2
    });
  });

  it("does not retry conflicts until another edit", async () => {
    mocks.updateNote.mockRejectedValueOnce({ code: "conflict" });
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Conflicting draft" });
    });
    await advanceAutosave();
    await waitForAssertion(() => {
      expect(useAppStore.getState().status).toBe("Save conflict");
    });
    await act(async () => vi.runAllTimersAsync());
    expect(mocks.updateNote).toHaveBeenCalledOnce();
    expect(useAppStore.getState().notes[0]?.title).toBe("Conflicting draft");
    expect(useAppStore.getState().status).toBe("Save conflict");

    act(() => {
      result.current.updateSelectedNote({ title: "Edited again" });
    });
    await advanceAutosave();
    expect(mocks.updateNote).toHaveBeenCalledTimes(2);
  });

  it("keeps quota-rejected edits local without reporting them saved", async () => {
    mocks.updateNote.mockRejectedValueOnce({
      code: "quota_exceeded",
      message: "internal quota detail",
      status: 413
    });
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Retained draft" });
    });
    await advanceAutosave();

    expect(useAppStore.getState()).toMatchObject({
      status: "Server storage full — changes kept on this device",
      error: "Encrypted changes remain on this device until server storage is available.",
      serverStorageCapacity: { status: "full", availableBytes: 0 }
    });
    expect(useAppStore.getState().notes[0]?.title).toBe("Retained draft");
  });

  it("distinguishes server maintenance from quota pressure", async () => {
    mocks.updateNote.mockRejectedValueOnce({ code: "internal_error", status: 503 });
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Pending maintenance" });
    });
    await advanceAutosave();

    expect(useAppStore.getState()).toMatchObject({
      status: "Synchronizing paused — server unavailable",
      serverStorageCapacity: { status: "error" }
    });
  });

  it("preserves edits made while a conflicting save is in flight", async () => {
    let rejectSave!: (reason: unknown) => void;
    mocks.updateNote.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        rejectSave = reject;
      })
    );
    mocks.loadNotes.mockImplementationOnce(() => {
      useAppStore.setState({ notes: [note({ title: "Server title", version: 2 })] });
    });
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Saving draft" });
    });
    await advanceAutosave();
    act(() => {
      result.current.updateSelectedNote({ title: "Newest draft" });
      rejectSave({ code: "conflict" });
    });
    await waitForAssertion(() => {
      expect(useAppStore.getState().notes[0]?.version).toBe(2);
    });

    expect(useAppStore.getState().notes[0]).toMatchObject({
      title: "Newest draft",
      version: 2
    });
  });

  it("continues autosaving after conflict recovery throws", async () => {
    mocks.updateNote.mockRejectedValueOnce({ code: "conflict" });
    mocks.loadNotes.mockRejectedValueOnce(new Error("reload failed"));
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Conflicting draft" });
    });
    await advanceAutosave();
    act(() => {
      result.current.updateSelectedNote({ title: "Retry draft" });
    });
    await advanceAutosave();

    expect(mocks.updateNote).toHaveBeenCalledTimes(2);
  });

  it("saves a newly selected note after the previous note conflicts", async () => {
    let rejectSave!: (reason: unknown) => void;
    mocks.updateNote
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => {
          rejectSave = reject;
        })
      )
      .mockResolvedValueOnce({
        id: "note_2",
        version: 2,
        updatedAt: "2026-07-02T00:00:01.000Z"
      });
    mocks.loadNotes.mockImplementationOnce(() => {
      useAppStore.setState({
        notes: [note({ title: "Server first", version: 2 }), note({ id: "note_2", title: "Server second" })]
      });
    });
    useAppStore.setState({ notes: [note(), note({ id: "note_2", title: "Second" })] });
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "First draft" });
    });
    await advanceAutosave();
    act(() => {
      useAppStore.getState().setSelectedNoteId("note_2");
    });
    act(() => {
      result.current.updateSelectedNote({ title: "Second draft" });
      rejectSave({ code: "conflict" });
    });
    await waitForAssertion(() => {
      expect(mocks.updateNote).toHaveBeenCalledTimes(2);
    });

    expect(mocks.updateNote.mock.calls[1]?.[0]).toBe("note_2");
    expect(mocks.updateNote.mock.calls[1]?.[1]).toMatchObject({
      titleCipher: "cipher"
    });
    expect(useAppStore.getState().status).toBe("Save conflict");
    expect(useAppStore.getState().error).toContain("Your draft is still open");
  });

  it("does not recover a conflict after the vault session is replaced", async () => {
    let rejectSave!: (reason: unknown) => void;
    mocks.updateNote.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        rejectSave = reject;
      })
    );
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Draft" });
    });
    await advanceAutosave();
    act(() => {
      useAppStore.getState().resetVaultState("Vault locked");
      rejectSave({ code: "conflict" });
      useAppStore.setState({
        notes: [note({ title: "Fresh session" })],
        rootKey: new Uint8Array([2]),
        selectedNoteId: "note_1",
        status: "Ready",
        user: { id: "alice", username: "alice" }
      });
    });
    act(() => {
      result.current.updateSelectedNote({ title: "Fresh session edit" });
    });
    await advanceAutosave();
    await waitForAssertion(() => {
      expect(mocks.updateNote).toHaveBeenCalledTimes(2);
    });

    expect(mocks.loadNotes).not.toHaveBeenCalled();
    expect(useAppStore.getState().notes[0]?.title).toBe("Fresh session edit");
  });

  it("keeps failed metadata drafts and retries only after a later edit", async () => {
    mocks.updateNote.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Unsaved draft" });
    });
    await advanceAutosave();
    await waitForAssertion(() => {
      expect(useAppStore.getState().status).toBe("Save failed");
    });
    await act(async () => vi.runAllTimersAsync());
    expect(mocks.updateNote).toHaveBeenCalledOnce();
    expect(useAppStore.getState().notes[0]?.title).toBe("Unsaved draft");
    expect(useAppStore.getState().status).toBe("Save failed");

    act(() => {
      result.current.updateSelectedNote({ title: "Retry draft" });
    });
    await advanceAutosave();
    expect(mocks.updateNote).toHaveBeenCalledTimes(2);
  });

  it("upgrades owned legacy metadata and note-key envelopes without plaintext", async () => {
    useAppStore.setState({
      notes: [
        note({
          metadataMigration: "write-v2-pending",
          rootSectionId: null
        })
      ]
    });
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.updateSelectedNote({ title: "Migrated private title" });
    });
    await advanceAutosave();

    expect(mocks.updateNote).toHaveBeenCalledWith(
      "note_1",
      expect.objectContaining({
        encryptedNoteKey: "protected-note-key",
        noteKeyFormatVersion: 2,
        rootSectionId: expect.any(String),
        titleCipher: "cipher"
      })
    );
    expect(mocks.updateNote.mock.calls[0]?.[1]).not.toHaveProperty("title");
    expect(useAppStore.getState().notes[0]?.metadataMigration).toBe("current");
  });
});

describe("note save conflict handling", () => {
  it("keeps the local metadata draft while adopting latest server state", () => {
    const latestNote = note({
      folderId: "server-folder",
      role: "viewer",
      title: "Server title",
      updatedAt: "2026-07-02T10:00:00.000Z",
      version: 4
    });
    const localDraft = note({
      folderId: "local-folder",
      role: "editor",
      title: "Local title",
      updatedAt: "2026-07-02T09:00:00.000Z",
      version: 3
    });

    const merged = mergeDraftAfterConflict(latestNote, localDraft);

    expect(merged).toMatchObject({
      folderId: "local-folder",
      role: "viewer",
      title: "Local title",
      updatedAt: "2026-07-02T10:00:00.000Z",
      version: 4
    });
    expect(merged.contentLength).toBe(latestNote.contentLength);
  });
});

describe("moveNoteToFolder", () => {
  it("updates the note folder id in state", () => {
    useAppStore.setState({ notes: [note()] });
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.moveNoteToFolder("note_1", "folder-1");
    });

    expect(useAppStore.getState().notes[0]?.folderId).toBe("folder-1");
  });

  it("skips update when folder id is unchanged", () => {
    useAppStore.setState({ notes: [note({ folderId: "folder-1" })] });
    const { result } = renderHook(() => useNoteActions(note({ folderId: "folder-1" })));

    act(() => {
      result.current.moveNoteToFolder("note_1", "folder-1");
    });

    expect(useAppStore.getState().notes[0]?.folderId).toBe("folder-1");
    expect(mocks.updateNote).not.toHaveBeenCalled();
  });

  it("schedules autosave when the selected note is moved", async () => {
    useAppStore.setState({ notes: [note()], selectedNoteId: "note_1" });
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.moveNoteToFolder("note_1", "folder-2");
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(mocks.updateNote).toHaveBeenCalledOnce();
  });

  it("does not schedule autosave for non-selected notes", () => {
    useAppStore.setState({ notes: [note(), note({ id: "note_2", title: "Second" })], selectedNoteId: "note_1" });
    const { result } = renderHook(() => useNoteActions(note()));

    act(() => {
      result.current.moveNoteToFolder("note_2", "folder-2");
    });
    act(() => { vi.advanceTimersByTime(500); });

    expect(mocks.updateNote).not.toHaveBeenCalled();
  });
});

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    contentLength: 0,
    cryptoOwnerId: "alice",
    folderId: null,
    id: "note_1",
    isDeleted: false,
    metadataMigration: "current",
    noteKeyBase64: "AQIDBA==",
    ownerUserId: "alice",
    role: "owner",
    rootSectionId: "section_1",
    rootVersion: 1,
    title: "Title",
    updatedAt: "2026-07-02T00:00:00.000Z",
    version: 1,
    keyEpoch: 1,
    ...overrides
  };
}

async function advanceAutosave(): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(500));
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}
