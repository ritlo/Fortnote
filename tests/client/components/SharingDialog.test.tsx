// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DecryptedNote } from "@client/store/appStore";
import { useAppStore } from "@client/store/appStore";
import { SharingDialog } from "@client/components/SharingDialog";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().resetVaultState("reset");
});

describe("SharingDialog", () => {
  it("renders SharingPanel when open", () => {
    render(<SharingDialog selectedNote={note()} open={true} onClose={vi.fn()} />);
    expect(screen.getByText("Share note")).toBeTruthy();
  });

  it("calls onClose when close button clicked", () => {
    const onClose = vi.fn();
    render(<SharingDialog selectedNote={note()} open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close sharing dialog" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not render when closed", () => {
    render(<SharingDialog selectedNote={note()} open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
  });

  it("calls onClose on dialog close event", () => {
    const onClose = vi.fn();
    render(<SharingDialog selectedNote={note()} open={true} onClose={onClose} />);
    act(() => {
      screen.getByRole("dialog", { hidden: true }).dispatchEvent(new Event("close"));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("returns focus to the Share trigger when closed", () => {
    const shareTrigger = document.createElement("button");
    document.body.append(shareTrigger);
    shareTrigger.focus();
    const returnFocusRef = { current: shareTrigger };
    render(
      <SharingDialog
        selectedNote={note()}
        open={true}
        onClose={vi.fn()}
        returnFocusRef={returnFocusRef}
      />
    );

    act(() => {
      screen.getByRole("dialog", { hidden: true }).dispatchEvent(new Event("close"));
    });
    expect(document.activeElement).toBe(shareTrigger);
    shareTrigger.remove();
  });
});

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    cryptoOwnerId: "alice",
    folderId: null,
    id: "note-1",
    isDeleted: false,
    keyEpoch: 1,
    noteKeyBase64: "key",
    ownerUserId: "alice",
    role: "owner",
    title: "Title",
    updatedAt: "2026-07-15T00:00:00.000Z",
    version: 1,
    ...overrides
  };
}
