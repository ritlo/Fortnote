// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveCollaborationState, defaultCollaborationDimensions } from "../lib/collaborationState";
import { RecoveryDialog } from "./RecoveryDialog";
import type { RecoveryCallbacks } from "./RecoveryPanel";

HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
  this.open = true;
});
HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
  this.open = false;
});

afterEach(cleanup);

describe("RecoveryDialog", () => {
  it("renders nothing when closed", () => {
    renderDialog(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders recovery actions inside a labelled dialog when open", () => {
    renderDialog(true);
    expect(screen.getByRole("dialog", { name: "Recovery actions" })).toBeTruthy();
    expect(screen.getByText("Recovery")).toBeTruthy();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    renderDialog(true, onClose);
    fireEvent.click(screen.getByRole("button", { name: "Close recovery dialog" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders recovery actions from collaboration state", () => {
    const callbacks = recoveryCallbacks();
    render(
      <RecoveryDialog
        state={deriveCollaborationState({
          ...defaultCollaborationDimensions,
          durability: "local-full",
          draftRetained: true
        })}
        callbacks={callbacks}
        open={true}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("Retry")).toBeTruthy();
    expect(screen.getByText("Encrypted export")).toBeTruthy();
  });

  it("does not render recovery actions row inside editor when dialog is closed", () => {
    const callbacks = recoveryCallbacks();
    const { container } = render(
      <RecoveryDialog
        state={deriveCollaborationState({
          ...defaultCollaborationDimensions,
          recovery: "divergent",
          draftRetained: true
        })}
        callbacks={callbacks}
        open={false}
        onClose={vi.fn()}
      />
    );
    expect(container.innerHTML).toBe("");
  });
});

function renderDialog(open: boolean, onClose = vi.fn()) {
  return render(
    <RecoveryDialog
      state={deriveCollaborationState(defaultCollaborationDimensions)}
      callbacks={recoveryCallbacks()}
      open={open}
      onClose={onClose}
    />
  );
}

function recoveryCallbacks(): RecoveryCallbacks {
  return {
    cleanup: vi.fn(),
    copy: vi.fn(),
    discard: vi.fn(),
    encryptedExport: vi.fn(),
    reapply: vi.fn(),
    repairAccess: vi.fn(),
    retry: vi.fn(),
    reviewAccess: vi.fn(),
    reviewDraft: vi.fn(),
    splitSection: vi.fn(),
    tryAgain: vi.fn()
  };
}
