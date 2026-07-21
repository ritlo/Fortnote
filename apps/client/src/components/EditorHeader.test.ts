// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresenceUser } from "../api";
import type { DecryptedNote } from "../store/appStore";
import { useAppStore } from "../store/appStore";
import type { CollaborationAction } from "../lib/collaborationState";
import { EditorHeader, formatLastSaved, formatPresenceSummary } from "./EditorHeader";

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
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Delete" }).disabled).toBe(true);
  });

  it("allows only owners to restore or permanently delete trash notes", () => {
    renderHeader({ notesView: "trash", selectedNote: { ...note(), role: "viewer", isDeleted: true } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Restore" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Delete forever" }).disabled).toBe(true);
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
    expect(screen.getByRole("button", { name: "Open recovery actions" })).toBeTruthy();
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

describe("EditorHeader simplified display", () => {
  it("does not show key material version text", () => {
    renderHeader();
    expect(screen.queryByText(/key material/)).toBeNull();
    expect(screen.queryByText(/root key in memory/)).toBeNull();
  });
});

function renderHeader(overrides: Partial<Parameters<typeof EditorHeader>[0]> = {}) {
  return render(
    createElement(EditorHeader, {
      deleteSelectedForever: vi.fn(),
      keyMaterialVersion: null,
      lockVault: vi.fn(),
      moveSelectedToTrash: vi.fn(),
      notesView: "notes",
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
    contentLength: 0,
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
