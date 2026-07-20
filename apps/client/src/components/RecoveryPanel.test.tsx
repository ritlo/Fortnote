// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveCollaborationState, defaultCollaborationDimensions } from "../lib/collaborationState";
import { RecoveryPanel, type RecoveryCallbacks } from "./RecoveryPanel";

afterEach(cleanup);

describe("RecoveryPanel", () => {
  it("offers retry, encrypted export, split, and cleanup for local storage pressure", () => {
    const callbacks = recoveryCallbacks();
    renderPanel({ durability: "local-full", draftRetained: true }, callbacks);

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Retry",
      "Encrypted export",
      "Split section",
      "Clean up"
    ]);
    click("Retry");
    click("Encrypted export");
    click("Split section");
    click("Clean up");
    expect(callbacks.retry).toHaveBeenCalledOnce();
    expect(callbacks.encryptedExport).toHaveBeenCalledOnce();
    expect(callbacks.splitSection).toHaveBeenCalledOnce();
    expect(callbacks.cleanup).toHaveBeenCalledOnce();
  });

  it("offers review, export, and reapply while retaining a divergent draft", () => {
    const callbacks = recoveryCallbacks();
    renderPanel({ recovery: "divergent", draftRetained: true }, callbacks);

    expect(screen.getByText("Your encrypted draft is retained until you explicitly discard it.")).toBeTruthy();
    click("Review draft");
    click("Encrypted export");
    click("Reapply");
    expect(callbacks.reviewDraft).toHaveBeenCalledOnce();
    expect(callbacks.encryptedExport).toHaveBeenCalledOnce();
    expect(callbacks.reapply).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  });

  it("does not expose actions absent from the derived state", () => {
    renderPanel({}, recoveryCallbacks());
    expect(screen.queryByRole("region", { name: "Recovery actions" })).toBeNull();
  });

  it("requires review before offering copy and explicit discard", () => {
    const callbacks = recoveryCallbacks();
    renderPanel({ recovery: "reviewing", draftRetained: true }, callbacks);

    click("Copy encrypted draft");
    click("Discard draft");
    expect(callbacks.copy).toHaveBeenCalledOnce();
    expect(callbacks.discard).toHaveBeenCalledOnce();
  });
});

function renderPanel(
  overrides: Partial<typeof defaultCollaborationDimensions>,
  callbacks: RecoveryCallbacks
) {
  return render(
    <RecoveryPanel
      state={deriveCollaborationState({ ...defaultCollaborationDimensions, ...overrides })}
      callbacks={callbacks}
    />
  );
}

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
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
