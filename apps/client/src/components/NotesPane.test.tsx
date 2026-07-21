// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FolderSummary } from "../api";
import type { DecryptedNote } from "../store/appStore";
import { NotesPane, roleLabel } from "./NotesPane";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  });
});

afterEach(cleanup);

const folders: FolderSummary[] = [
  { id: "folder-1", name: "Work", parentFolderId: null, createdAt: "", updatedAt: "" },
  { id: "folder-2", name: "Personal", parentFolderId: null, createdAt: "", updatedAt: "" }
];

describe("NotesPane role labels", () => {
  it("formats note roles for list badges", () => {
    expect(roleLabel("owner")).toBe("Owner");
    expect(roleLabel("editor")).toBe("Editor");
    expect(roleLabel("viewer")).toBe("Viewer");
  });
});

describe("NotesPane drag and move", () => {
  it("renders note cards as draggable", () => {
    renderNotesPane({ filteredNotes: [note()] });
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.getAttribute("draggable")).toBe("true");
  });

  it("sets note id as drag data on drag start", () => {
    renderNotesPane({ filteredNotes: [note({ id: "note-drag" })] });
    const card = screen.getByText("Title").closest("li")!;
    const event = new Event("dragstart", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { setData: vi.fn(), effectAllowed: "" }
    });
    card.dispatchEvent(event);
    const dt = (event as unknown as { dataTransfer: { setData: ReturnType<typeof vi.fn>; effectAllowed: string } }).dataTransfer;
    expect(dt.setData).toHaveBeenCalledWith("text/note-id", "note-drag");
    expect(dt.effectAllowed).toBe("move");
  });

  it("does not render move button for viewer notes", () => {
    renderNotesPane({ filteredNotes: [note({ role: "viewer" })] });
    expect(screen.queryByText("Move")).toBeNull();
  });

  it("shows move button for owner notes", () => {
    renderNotesPane({ filteredNotes: [note()] });
    expect(screen.getByText("Move")).toBeTruthy();
  });

  it("opens folder list on Move click and calls moveNoteToFolder", () => {
    const moveNoteToFolder = vi.fn();
    renderNotesPane({ filteredNotes: [note({ id: "note-move" })], moveNoteToFolder });
    fireEvent.click(screen.getByText("Move"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    expect(moveNoteToFolder).toHaveBeenCalledWith("note-move", "folder-1");
  });

  it("hides folder list on Cancel", () => {
    renderNotesPane({ filteredNotes: [note({ id: "hide-cancel" })] });
    const toggle = screen.getByRole("button", { name: /^Move/ });
    fireEvent.click(toggle);
    expect(screen.getByRole("menuitem", { name: "Work" })).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});

describe("NotesPane new note dialog", () => {
  it("opens dialog when New note button clicked", () => {
    renderNotesPane();
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
  });

  it("creates note with folder id via dialog", async () => {
    const addNote = vi.fn().mockResolvedValue(undefined);
    renderNotesPane({ addNote });
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "folder-1" } });
    fireEvent.click(screen.getByText("Create"));
    await vi.waitFor(() => expect(addNote).toHaveBeenCalledWith("folder-1"));
  });
});

interface NotesPaneTestOverrides {
  addNote?: () => Promise<void>;
  filteredNotes?: DecryptedNote[];
  moveNoteToFolder?: (noteId: string, folderId: string | null) => void;
  notesView?: "notes" | "shared" | "trash" | "settings";
}

function renderNotesPane(overrides: NotesPaneTestOverrides = {}) {
  return render(
    <NotesPane
      addNote={overrides.addNote !== undefined ? overrides.addNote : vi.fn()}
      error={null}
      filteredNotes={overrides.filteredNotes !== undefined ? overrides.filteredNotes : [note()]}
      folders={folders}
      moveNoteToFolder={overrides.moveNoteToFolder !== undefined ? overrides.moveNoteToFolder : vi.fn()}
      notesView={overrides.notesView !== undefined ? overrides.notesView : "notes"}
      realtimeStatus="connected"
      recoverySecret={null}
      retrySearchIndex={vi.fn()}
      search=""
      searchCoverage={null}
      searchIndexError={null}
      searchIndexStatus="ready"
      searchMatches={[]}
      selectSearchMatch={vi.fn()}
      selectedNoteId={null}
      setSearch={vi.fn()}
      setSelectedNoteId={vi.fn()}
      status="Ready"
    />
  );
}

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    contentLength: 1024, cryptoOwnerId: "alice", folderId: null, id: "note-1",
    isDeleted: false, keyEpoch: 1, noteKeyBase64: "key", ownerUserId: "alice",
    role: "owner", rootSectionId: "root", title: "Title",
    updatedAt: "2026-07-15T00:00:00.000Z", version: 1, ...overrides
  };
}
