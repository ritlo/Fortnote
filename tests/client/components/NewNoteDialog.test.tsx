// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { FolderSummary } from "@client/api";
import { NewNoteDialog } from "@client/components/NewNoteDialog";

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

describe("NewNoteDialog", () => {
  it("renders with folder selector when open", () => {
    render(<NewNoteDialog folders={folders} open={true} onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
    expect(screen.getByText("New note")).toBeTruthy();
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("Personal")).toBeTruthy();
  });

  it("shows no folders option as default", () => {
    render(<NewNoteDialog folders={folders} open={true} onClose={vi.fn()} onCreate={vi.fn()} />);
    const select = screen.getByRole<HTMLSelectElement>("combobox");
    expect(select.value).toBe("");
  });

  it("calls onCreate with selected folderId on submit", () => {
    const onCreate = vi.fn();
    render(<NewNoteDialog folders={folders} open={true} onClose={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "folder-1" } });
    fireEvent.click(screen.getByText("Create"));
    expect(onCreate).toHaveBeenCalledWith("folder-1");
  });

  it("calls onCreate with null when no folder selected", () => {
    const onCreate = vi.fn();
    render(<NewNoteDialog folders={folders} open={true} onClose={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(screen.getByText("Create"));
    expect(onCreate).toHaveBeenCalledWith(null);
  });

  it("calls onClose on cancel", () => {
    const onClose = vi.fn();
    render(<NewNoteDialog folders={folders} open={true} onClose={onClose} onCreate={vi.fn()} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("returns focus to the trigger after closing", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const onCreate = vi.fn();
    const view = render(
      <NewNoteDialog
        folders={folders}
        open={true}
        onClose={onClose}
        onCreate={onCreate}
      />
    );
    screen.getByRole("combobox").focus();

    view.rerender(
      <NewNoteDialog
        folders={folders}
        open={false}
        onClose={onClose}
        onCreate={onCreate}
      />
    );

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("disables controls while submitting", () => {
    let resolveCreate!: () => void;
    const onCreate = vi.fn(() => new Promise<void>((resolve) => { resolveCreate = resolve; }));
    render(<NewNoteDialog folders={folders} open={true} onClose={vi.fn()} onCreate={onCreate} />);

    fireEvent.click(screen.getByText("Create"));
    expect(screen.getByText("Creating...")).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>("combobox").disabled).toBe(true);
    expect(screen.getByText("Cancel").getAttribute("disabled")).not.toBeNull();
    resolveCreate();
  });

  it("resets selected folder on close", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <NewNoteDialog folders={folders} open={true} onClose={onClose} onCreate={vi.fn()} />
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "folder-1" } });
    rerender(<NewNoteDialog folders={folders} open={false} onClose={onClose} onCreate={vi.fn()} />);
    rerender(<NewNoteDialog folders={folders} open={true} onClose={onClose} onCreate={vi.fn()} />);
    const select = screen.getByRole<HTMLSelectElement>("combobox");
    expect(select.value).toBe("");
  });

  it("restores focus after a note is created and the controlled dialog closes", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => { setOpen(true); }}>New note trigger</button>
          <NewNoteDialog
            folders={folders}
            open={open}
            onClose={() => { setOpen(false); }}
            onCreate={async (folderId) => {
              await onCreate(folderId);
              setOpen(false);
            }}
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "New note trigger" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(null);
      expect(document.activeElement).toBe(trigger);
    });
  });
});
