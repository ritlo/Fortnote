// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppStore } from "@client/store/appStore";
import {
  mocks,
  note,
  advanceAutosave,
  waitForAssertion
} from "./useNoteActions.fixtures";
import { useNoteActions } from "@client/hooks/useNoteActions";

describe("note lifecycle actions", () => {
  it("keeps an explicit No folder choice instead of falling back to the active folder", async () => {
    useAppStore.setState({ selectedFolderId: "folder-1" });
    const { result } = renderHook(() => useNoteActions(null));

    await act(async () => result.current.addNote(null));

    expect(mocks.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: null })
    );
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

  it("selects the next note from the active folder after moving a note to trash", async () => {
    const current = note({ id: "note-current", folderId: "folder-1" });
    const outsideFolder = note({ id: "note-outside", folderId: "folder-2" });
    const nextInFolder = note({ id: "note-next", folderId: "folder-1" });
    useAppStore.setState({
      notes: [current, outsideFolder, nextInFolder],
      selectedFolderId: "folder-1",
      selectedNoteId: current.id
    });
    const { result } = renderHook(() => useNoteActions(current));

    await act(async () => result.current.moveSelectedToTrash());

    expect(useAppStore.getState().selectedNoteId).toBe(nextInFolder.id);
  });

  it("shows a trashed note when trash opened before the move finished", async () => {
    const current = note({ id: "note-current" });
    const other = note({ id: "note-other" });
    useAppStore.setState({
      notes: [current, other],
      selectedFolderId: null,
      selectedNoteId: current.id,
      trashNotes: []
    });
    let finishDelete!: () => void;
    mocks.deleteNote.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishDelete = () => {
            resolve(undefined);
          };
        })
    );
    const { result } = renderHook(() => useNoteActions(current));

    let moving!: Promise<void>;
    act(() => {
      moving = result.current.moveSelectedToTrash();
    });
    await waitForAssertion(() => {
      expect(mocks.deleteNote).toHaveBeenCalledWith(current.id);
    });
    // The trash list loads while the delete is still in flight, so it cannot
    // include the note, and this tab's own trash event is never replayed to it.
    await act(async () => result.current.openTrash());
    await act(async () => {
      finishDelete();
      await moving;
    });

    const state = useAppStore.getState();
    expect(state.notes.map(({ id }) => id)).toEqual([other.id]);
    expect(state.trashNotes).toEqual([
      expect.objectContaining({ id: current.id, isDeleted: true })
    ]);
    expect(state.selectedNoteId).toBe(current.id);
  });

  it("selects the next visible note when moving the selected note out of its folder", async () => {
    const current = note({ id: "note-current", folderId: "folder-1" });
    const nextInFolder = note({ id: "note-next", folderId: "folder-1" });
    useAppStore.setState({
      notes: [current, nextInFolder],
      selectedFolderId: "folder-1",
      selectedNoteId: current.id
    });
    const { result } = renderHook(() => useNoteActions(current));

    await act(async () => result.current.moveNoteToFolder(current.id, null));

    expect(useAppStore.getState().selectedNoteId).toBe(nextInFolder.id);
  });

  it("reloads notes after confirming folder deletion", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const current = note({ id: "note-in-folder", folderId: "folder-1" });
    useAppStore.setState({
      folders: [
        {
          id: "folder-1",
          name: "Work",
          parentFolderId: null,
          createdAt: "",
          updatedAt: ""
        }
      ],
      notes: [current],
      selectedFolderId: "folder-1"
    });
    const { result } = renderHook(() => useNoteActions(current));

    await act(async () => result.current.removeFolder("folder-1"));

    expect(confirm).toHaveBeenCalledWith(
      'Delete folder "Work"? Notes will move to its parent or All notes.'
    );
    expect(mocks.deleteFolder).toHaveBeenCalledWith("folder-1");
    expect(mocks.loadNotes).toHaveBeenCalledWith(
      expect.objectContaining({ id: "alice" }),
      expect.any(Uint8Array),
      false,
      { preserveSelection: true }
    );
    expect(useAppStore.getState().selectedFolderId).toBeNull();
  });

  it("does not delete a folder when confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result } = renderHook(() => useNoteActions(note()));

    await act(async () => result.current.removeFolder("folder-1"));

    expect(mocks.deleteFolder).not.toHaveBeenCalled();
  });

  it("requires confirmation before permanently deleting a note", async () => {
    useAppStore.setState({
      notes: [],
      trashNotes: [note({ id: "trash-note", isDeleted: true })],
      notesView: "trash",
      selectedNoteId: "trash-note"
    });
    const { result } = renderHook(() =>
      useNoteActions(note({ id: "trash-note", isDeleted: true }))
    );
    vi.spyOn(window, "confirm").mockReturnValue(false);

    await act(async () => result.current.deleteSelectedForever());

    expect(mocks.permanentlyDeleteNote).not.toHaveBeenCalled();
  });
});

describe("moveNoteToFolder", () => {
  it("updates the note folder id in state", async () => {
    useAppStore.setState({ notes: [note()] });
    const { result } = renderHook(() => useNoteActions(note()));

    await act(async () => {
      await result.current.moveNoteToFolder("note_1", "folder-1");
    });

    expect(useAppStore.getState().notes[0]?.folderId).toBe("folder-1");
  });

  it("skips update when folder id is unchanged", async () => {
    useAppStore.setState({ notes: [note({ folderId: "folder-1" })] });
    const { result } = renderHook(() => useNoteActions(note({ folderId: "folder-1" })));

    await act(async () => {
      await result.current.moveNoteToFolder("note_1", "folder-1");
    });

    expect(useAppStore.getState().notes[0]?.folderId).toBe("folder-1");
    expect(mocks.updateNote).not.toHaveBeenCalled();
  });

  it("schedules autosave when the selected note is moved", async () => {
    useAppStore.setState({ notes: [note()], selectedNoteId: "note_1" });
    const { result } = renderHook(() => useNoteActions(note()));

    await act(async () => {
      await result.current.moveNoteToFolder("note_1", "folder-2");
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(mocks.updateNote).toHaveBeenCalledOnce();
  });

  it("persists folder changes for non-selected notes", async () => {
    useAppStore.setState({
      notes: [note(), note({ id: "note_2", title: "Second" })],
      selectedNoteId: "note_1"
    });
    const { result } = renderHook(() => useNoteActions(note()));

    await act(async () => {
      await result.current.moveNoteToFolder("note_2", "folder-2");
    });
    await waitForAssertion(() => {
      expect(mocks.updateNote).toHaveBeenCalledWith(
        "note_2",
        expect.objectContaining({ folderId: "folder-2" })
      );
    });
  });

  it("ignores invalid folder targets without changing the note", async () => {
    useAppStore.setState({ notes: [note()], selectedNoteId: "note_1" });
    const { result } = renderHook(() => useNoteActions(note()));

    await act(async () => {
      await result.current.moveNoteToFolder("note_1", "missing-folder");
    });

    expect(useAppStore.getState().notes[0]?.folderId).toBeNull();
    expect(mocks.updateNote).not.toHaveBeenCalled();
  });

  it("rolls back a local folder move when saving fails", async () => {
    mocks.updateNote.mockRejectedValueOnce(new Error("offline"));
    useAppStore.setState({ notes: [note()], selectedNoteId: "note_1" });
    const { result } = renderHook(() => useNoteActions(note()));

    await act(async () => {
      await result.current.moveNoteToFolder("note_1", "folder-2");
    });

    expect(useAppStore.getState().notes[0]?.folderId).toBeNull();
    expect(mocks.updateNote).toHaveBeenCalledOnce();
  });
});
