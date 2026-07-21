// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FolderSummary } from "../api";
import { Sidebar } from "./Sidebar";

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
  { id: "folder-2", name: "Personal", parentFolderId: null, createdAt: "", updatedAt: "" },
  { id: "folder-3", name: "Projects", parentFolderId: "folder-1", createdAt: "", updatedAt: "" }
];

describe("Sidebar folder navigation", () => {
  it("renders root folders and child folders", () => {
    renderSidebar();
    expect(screen.getByText("All notes")).toBeTruthy();
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();
  });

  it("calls openNotes with folder id on folder click", () => {
    const openNotes = vi.fn();
    renderSidebar({ openNotes });
    fireEvent.click(screen.getByText("Work"));
    expect(openNotes).toHaveBeenCalledWith("folder-1");
  });

  it("calls openNotes with null on All notes click", () => {
    const openNotes = vi.fn();
    renderSidebar({ openNotes, selectedFolderId: "folder-1" });
    fireEvent.click(screen.getByText("All notes"));
    expect(openNotes).toHaveBeenCalledWith(null);
  });

  it("highlights the selected folder", () => {
    renderSidebar({ selectedFolderId: "folder-1" });
    const workBtn = screen.getByText("Work").closest("button")!;
    expect(workBtn.className).toContain("active");
  });

  it("calls openSharedNotes on Shared click", () => {
    const openSharedNotes = vi.fn();
    renderSidebar({ openSharedNotes });
    fireEvent.click(screen.getByText("Shared"));
    expect(openSharedNotes).toHaveBeenCalledOnce();
  });

  it("calls openSettings on Settings click", () => {
    const openSettings = vi.fn();
    renderSidebar({ openSettings });
    fireEvent.click(screen.getByText("Settings"));
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("calls openTrash on Trash click", () => {
    const openTrash = vi.fn();
    renderSidebar({ openTrash });
    fireEvent.click(screen.getByText("Trash"));
    expect(openTrash).toHaveBeenCalledOnce();
  });
});

describe("Sidebar folder management", () => {
  it("calls addFolder with parent id for child folder button", () => {
    const addFolder = vi.fn();
    renderSidebar({ addFolder });
    fireEvent.click(screen.getByLabelText("Add child folder to Work"));
    expect(addFolder).toHaveBeenCalledWith("folder-1");
  });

  it("calls addFolder with no parent for New folder button", () => {
    const addFolder = vi.fn();
    renderSidebar({ addFolder });
    fireEvent.click(screen.getByText("New folder"));
    expect(addFolder).toHaveBeenCalledWith();
  });

  it("calls removeFolder on delete button", () => {
    const removeFolder = vi.fn();
    renderSidebar({ removeFolder });
    fireEvent.click(screen.getByLabelText("Delete Work"));
    expect(removeFolder).toHaveBeenCalledWith("folder-1");
  });

  it("calls submitLogout on Logout click", () => {
    const submitLogout = vi.fn();
    renderSidebar({ submitLogout });
    fireEvent.click(screen.getByText("Logout"));
    expect(submitLogout).toHaveBeenCalledOnce();
  });
});

describe("Sidebar drop targets", () => {
  it("moves note to folder on drop over All notes", () => {
    const moveNoteToFolder = vi.fn();
    renderSidebar({ moveNoteToFolder });
    const allNotes = screen.getByText("All notes").closest("div")!;
    const event = createDragEvent("drop", "note-id-1");
    fireEvent(allNotes, event);
    expect(moveNoteToFolder).toHaveBeenCalledWith("note-id-1", null);
  });

  it("moves note to specific folder on drop over a folder", () => {
    const moveNoteToFolder = vi.fn();
    renderSidebar({ moveNoteToFolder });
    const folder = screen.getByText("Work").closest("div")!;
    const event = createDragEvent("drop", "note-drag-id");
    fireEvent(folder, event);
    expect(moveNoteToFolder).toHaveBeenCalledWith("note-drag-id", "folder-1");
  });

  function workDropTarget(): Element {
    const folderRow = screen.getByText("Work").closest("div")!;
    return folderRow.parentElement!;
  }

  it("shows drop target highlight when dragging a note over a folder", () => {
    renderSidebar();
    const target = workDropTarget();
    const event = createDragEvent("dragover", "note-id");
    fireEvent(target, event);
    expect(target.className).toBe("drop-target-over");
  });

  it("removes highlight on drag leave", () => {
    renderSidebar();
    const target = workDropTarget();
    fireEvent(target, createDragEvent("dragover", "note-id"));
    fireEvent(target, new Event("dragleave", { bubbles: true }));
    expect(target.className).not.toBe("drop-target-over");
  });

  it("ignores drops that do not carry note data", () => {
    const moveNoteToFolder = vi.fn();
    renderSidebar({ moveNoteToFolder });
    const folder = screen.getByText("Work").closest("div")!;
    const event = new Event("drop", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { getData: () => "", types: [] }
    });
    fireEvent(folder, event);
    expect(moveNoteToFolder).not.toHaveBeenCalled();
  });
});

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return render(
    <Sidebar
      addFolder={vi.fn()}
      folders={folders}
      moveNoteToFolder={vi.fn()}
      notesView="notes"
      openNotes={vi.fn()}
      openSharedNotes={vi.fn()}
      openSettings={vi.fn()}
      openTrash={vi.fn()}
      removeFolder={vi.fn()}
      selectedFolderId={null}
      submitLogout={vi.fn()}
      {...overrides}
    />
  );
}

function createDragEvent(type: string, noteId: string): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      getData: (fmt: string) => (fmt === "text/note-id" ? noteId : ""),
      types: ["text/note-id"]
    }
  });
  if (type === "dragover" || type === "drop") {
    event.preventDefault = vi.fn();
  }
  return event;
}
