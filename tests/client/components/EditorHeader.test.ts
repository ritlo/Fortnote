// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresenceUser } from "@client/api";
import type { DecryptedNote } from "@client/store/appStore";
import { useAppStore } from "@client/store/appStore";
import type { CollaborationAction } from "@client/lib/collaborationState";
import {
  EditorHeader,
  formatLastSaved,
  formatPresenceSummary
} from "@client/components/EditorHeader";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAppStore.getState().resetVaultState("reset");
});

describe("EditorHeader presence summary", () => {
  it("formats active collaborator states", () => {
    expect(
      formatPresenceSummary([
        presence({ username: "bob", state: "editing" }),
        presence({ username: "carol", state: "idle" })
      ])
    ).toBe("bob editing, carol idle");
  });

  it("returns an empty summary without collaborators", () => {
    expect(formatPresenceSummary([])).toBe("");
  });
});

describe("EditorHeader last-saved feedback", () => {
  it("formats elapsed seconds, minutes, hours, and days", () => {
    const savedAt = "2026-07-15T00:00:00.000Z";
    expect(formatLastSaved(savedAt, Date.parse("2026-07-15T00:00:05.000Z"))).toBe(
      "Last saved 5 seconds ago"
    );
    expect(formatLastSaved(savedAt, Date.parse("2026-07-15T00:02:00.000Z"))).toBe(
      "Last saved 2 minutes ago"
    );
    expect(formatLastSaved(savedAt, Date.parse("2026-07-15T03:00:00.000Z"))).toBe(
      "Last saved 3 hours ago"
    );
    expect(formatLastSaved(savedAt, Date.parse("2026-07-17T00:00:00.000Z"))).toBe(
      "Last saved 2 days ago"
    );
  });

  it("falls back when the saved timestamp is invalid", () => {
    expect(formatLastSaved("not-a-date", Date.parse("2026-07-15T00:00:05.000Z"))).toBe(
      "Last saved recently"
    );
  });

  it("refreshes each second and hides only the relative label for collaborators", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-15T00:00:05.000Z");
    useAppStore.setState({ presenceByNote: {} });
    renderHeader();
    expect(screen.getByText("Last saved 5 seconds ago")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("Last saved 6 seconds ago")).toBeTruthy();

    act(() => {
      useAppStore.getState().setNotePresence("note-1", [presence({ userId: "bob" })]);
    });
    expect(screen.queryByText(/^Last saved/)).toBeNull();
    expect(screen.getByText("alice idle")).toBeTruthy();
  });
});

describe("EditorHeader role affordances", () => {
  it("allows only owners to delete active notes", () => {
    renderHeader({ selectedNote: { ...note(), role: "viewer" } });
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More note actions" }));
    expect(
      screen.getByRole<HTMLButtonElement>("menuitem", { name: "Move to trash" }).disabled
    ).toBe(true);
  });

  it("allows only owners to restore or permanently delete trash notes", () => {
    renderHeader({
      notesView: "trash",
      selectedNote: { ...note(), role: "viewer", isDeleted: true }
    });
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete forever" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More note actions" }));
    expect(
      screen.getByRole<HTMLButtonElement>("menuitem", { name: "Restore" }).disabled
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("menuitem", { name: "Delete forever" }).disabled
    ).toBe(true);
  });
});

describe("EditorHeader recovery trigger", () => {
  it("shows recovery button when collaboration state has actions", () => {
    const collaborationState = {
      actions: ["retry" as CollaborationAction],
      announcement: "assertive" as const,
      draftRetained: false,
      editing: false,
      id: "error",
      label: "Error",
      saved: false,
      synchronized: false
    };
    renderHeader({ collaborationState });
    expect(screen.queryByRole("button", { name: "Open recovery actions" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More note actions" }));
    expect(screen.getByRole("menuitem", { name: "Open recovery actions" })).toBeTruthy();
  });

  it("does not show recovery button when no actions exist", () => {
    const collaborationState = {
      actions: [],
      announcement: "none" as const,
      draftRetained: false,
      editing: false,
      id: "saved",
      label: "Saved and synchronized",
      saved: true,
      synchronized: true
    };
    renderHeader({ collaborationState });
    expect(screen.queryByRole("button", { name: "Open recovery actions" })).toBeNull();
  });
});

describe("EditorHeader Share action", () => {
  it("renders Share button when canShare is true", () => {
    renderHeader({ canShare: true });
    expect(screen.getByRole("button", { name: "Share note" })).toBeTruthy();
  });

  it("does not render Share button when canShare is false", () => {
    renderHeader({ canShare: false });
    expect(screen.queryByRole("button", { name: "Share note" })).toBeNull();
  });

  it("calls onShare when clicked", () => {
    const onShare = vi.fn();
    renderHeader({ canShare: true, onShare });
    screen.getByRole("button", { name: "Share note" }).click();
    expect(onShare).toHaveBeenCalledOnce();
  });

  it("does not render Share button in settings view", () => {
    renderHeader({ canShare: true, notesView: "settings" });
    expect(screen.queryByRole("button", { name: "Share note" })).toBeNull();
  });

  it("does not render Share button in trash view", () => {
    renderHeader({ canShare: true, notesView: "trash" });
    expect(screen.queryByRole("button", { name: "Share note" })).toBeNull();
  });

  it("renders Share alongside presence and last-saved status", () => {
    renderHeader({ canShare: true });
    expect(screen.getByRole("button", { name: "Share note" })).toBeTruthy();
    expect(screen.getByText(/^Last saved/)).toBeTruthy();
  });

  it("keeps the note title in the document instead of duplicating it in the top bar", () => {
    renderHeader({ canShare: true });
    expect(screen.queryByRole("heading", { name: "Title" })).toBeNull();
    expect(screen.getByRole("banner").className).toContain("editor-header");
  });
});

describe("EditorHeader menu keyboard behavior", () => {
  it("focuses the first action and moves through menu items with the keyboard", () => {
    renderHeader({
      collaborationState: {
        actions: ["retry"],
        announcement: "polite",
        draftRetained: false,
        editing: false,
        id: "recoverable",
        label: "Recovery needed",
        saved: false,
        synchronized: false
      }
    });

    fireEvent.click(screen.getByRole("button", { name: "More note actions" }));
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[1]);
  });
});

function renderHeader(overrides: Partial<Parameters<typeof EditorHeader>[0]> = {}) {
  return render(
    createElement(EditorHeader, {
      canShare: true,
      deleteSelectedForever: vi.fn(),
      lockVault: vi.fn(),
      moveSelectedToTrash: vi.fn(),
      notesView: "notes",
      onShare: vi.fn(),
      restoreSelectedNote: vi.fn(),
      selectedNote: note(),
      user: { id: "current-user", username: "current" },
      ...overrides
    })
  );
}

function presence(overrides: Partial<PresenceUser>): PresenceUser {
  return {
    state: "idle",
    updatedAt: "2026-07-03T00:00:00.000Z",
    userId: "user_1",
    username: "alice",
    ...overrides
  };
}

function note(): DecryptedNote {
  return {
    cryptoOwnerId: "current-user",
    folderId: null,
    id: "note-1",
    isDeleted: false,
    keyEpoch: 1,
    noteKeyBase64: "key",
    ownerUserId: "current-user",
    role: "owner",
    title: "Title",
    updatedAt: "2026-07-15T00:00:00.000Z",
    version: 1
  };
}
