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
  it("uses human note metadata instead of encrypted byte counts", () => {
    renderNotesPane({ filteredNotes: [note({ contentLength: 1024, folderId: "folder-1" })] });
    expect(screen.getByText(/Updated/)).toBeTruthy();
    expect(screen.getByText(/Updated .*Work/)).toBeTruthy();
    expect(screen.queryByText(/encrypted bytes/)).toBeNull();
    expect(screen.getByRole("list", { name: "Notes" })).toBeTruthy();
  });

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
    fireEvent.contextMenu(screen.getByText("Title"));
    expect(screen.getByRole("menuitem", { name: "Attachments" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Move to folder" })).toBeNull();
  });

  it("shows a note actions menu for owner notes", () => {
    renderNotesPane({ filteredNotes: [note()] });
    expect(screen.getByRole("button", { name: "Open note menu" })).toBeTruthy();
  });

  it("opens folder list from the note actions menu and calls moveNoteToFolder", () => {
    const moveNoteToFolder = vi.fn();
    renderNotesPane({ filteredNotes: [note({ id: "note-move" })], moveNoteToFolder });
    fireEvent.click(screen.getByRole("button", { name: "Open note menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to folder" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Work" }));
    expect(moveNoteToFolder).toHaveBeenCalledWith("note-move", "folder-1");
  });

  it("can move a note back to All notes from the actions menu", () => {
    const moveNoteToFolder = vi.fn();
    renderNotesPane({ filteredNotes: [note({ id: "note-root" })], moveNoteToFolder });
    fireEvent.click(screen.getByRole("button", { name: "Open note menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to folder" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "All notes" }));
    expect(moveNoteToFolder).toHaveBeenCalledWith("note-root", null);
  });

  it("supports keyboard navigation in the note actions menu", () => {
    renderNotesPane({ filteredNotes: [note()] });
    fireEvent.click(screen.getByRole("button", { name: "Open note menu" }));
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("opens the note actions menu on right click", () => {
    renderNotesPane({ filteredNotes: [note()] });
    fireEvent.contextMenu(screen.getByText("Title"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Attachments" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Move to folder" })).toBeTruthy();
  });

  it("opens the attachment dialog for the note from its actions menu", () => {
    const openAttachments = vi.fn();
    renderNotesPane({ filteredNotes: [note({ id: "note-attachments" })], openAttachments });
    fireEvent.contextMenu(screen.getByText("Title"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Attachments" }));
    expect(openAttachments).toHaveBeenCalledWith(expect.objectContaining({ id: "note-attachments" }));
  });

  it("opens the note actions menu with the context-menu key", () => {
    renderNotesPane({ filteredNotes: [note()] });
    fireEvent.keyDown(screen.getByText("Title"), { key: "ContextMenu" });
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes the note actions menu on Escape", () => {
    renderNotesPane({ filteredNotes: [note({ id: "hide-cancel" })] });
    const toggle = screen.getByRole("button", { name: "Open note menu" });
    fireEvent.click(toggle);
    expect(screen.getByRole("menuitem", { name: "Move to folder" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
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
    await vi.waitFor(() => { expect(addNote).toHaveBeenCalledWith("folder-1"); });
  });

  it("keeps the new-note dialog open when creation reports a failure", async () => {
    const addNote = vi.fn().mockResolvedValue(false);
    renderNotesPane({ addNote });
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await vi.waitFor(() => {
      expect(addNote).toHaveBeenCalledWith(null);
      expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
    });
  });
});

interface NotesPaneTestOverrides {
  addNote?: () => Promise<boolean | undefined>;
  filteredNotes?: DecryptedNote[];
  moveNoteToFolder?: (noteId: string, folderId: string | null) => Promise<void>;
  notesView?: "notes" | "shared" | "trash" | "settings";
  openAttachments?: (note: DecryptedNote) => void;
}

function renderNotesPane(overrides: NotesPaneTestOverrides = {}) {
  return render(
    <NotesPane
      addNote={overrides.addNote ?? vi.fn()}
      error={null}
      filteredNotes={overrides.filteredNotes ?? [note()]}
      folders={folders}
      moveNoteToFolder={overrides.moveNoteToFolder ?? (() => Promise.resolve())}
      notesView={overrides.notesView ?? "notes"}
      openAttachments={overrides.openAttachments ?? vi.fn()}
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
