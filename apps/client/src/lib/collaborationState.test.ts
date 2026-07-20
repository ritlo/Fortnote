import { describe, expect, it } from "vitest";
import {
  defaultCollaborationDimensions,
  deriveCollaborationState,
  type CollaborationDimensions
} from "./collaborationState";

const derive = (overrides: Partial<CollaborationDimensions>) =>
  deriveCollaborationState({ ...defaultCollaborationDimensions, ...overrides });

describe("deriveCollaborationState", () => {
  it.each([
    [{ access: "removed" }, "You no longer have access", "alert"],
    [{ protection: "undecryptable" }, "This note cannot be decrypted", "alert"],
    [{ recovery: "conflict", draftRetained: true }, "Changes need review", "alert"],
    [{ durability: "local-full", draftRetained: true }, "Local storage full — changes need attention", "alert"],
    [{ durability: "server-full", draftRetained: true }, "Server storage full — changes kept on this device", "alert"],
    [{ protection: "stale", draftRetained: true }, "Access changed — refreshing protection", "assertive"],
    [{ protection: "preparing" }, "Securing access — editing paused", "assertive"],
    [{ protection: "activated" }, "Access revoked and protection updated", "polite"],
    [{ protection: "aborted" }, "Access change not completed", "alert"],
    [{ access: "viewer" }, "View only", "polite"],
    [{ access: "trash" }, "In trash — view only", "polite"],
    [{ section: "opening" }, "Opening encrypted note…", "polite"],
    [{ section: "loading" }, "Loading section…", "polite"],
    [{ connection: "offline", durability: "pending" }, "Offline — changes kept on this device", "assertive"],
    [{ connection: "reconnecting", durability: "pending" }, "Reconnecting…", "polite"],
    [{ durability: "memory" }, "Preserving changes…", "polite"],
    [{ durability: "pending" }, "Synchronizing…", "polite"],
    [{ durability: "saving" }, "Saving encrypted note…", "polite"],
    [{ durability: "uploading" }, "Uploading encrypted changes…", "polite"],
    [{ durability: "compacting" }, "Synchronizing paused — optimizing history", "polite"],
    [{ vault: "loading", section: "idle" }, "Loading vault…", "polite"],
    [{ vault: "empty", section: "idle" }, "No notes yet", "none"]
  ] as const)("maps %o to its truthful label", (overrides, label, announcement) => {
    expect(derive(overrides)).toMatchObject({ label, announcement });
  });

  it("applies security and recovery precedence before connectivity and saving", () => {
    expect(derive({ access: "removed", protection: "undecryptable", recovery: "conflict", connection: "offline", durability: "saving" }).id).toBe("removed");
    expect(derive({ protection: "undecryptable", recovery: "conflict", connection: "offline", durability: "saving" }).id).toBe("undecryptable");
    expect(derive({ recovery: "conflict", connection: "offline", durability: "saving" }).id).toBe("review");
    expect(derive({ connection: "offline", durability: "saving" }).id).toBe("offline");
  });

  it("offers only the recovery actions appropriate to retained work", () => {
    expect(derive({ durability: "local-full", draftRetained: true })).toEqual({
      announcement: "alert",
      actions: ["retry", "encrypted-export", "split-section", "cleanup"],
      draftRetained: true,
      editing: true,
      id: "local-full",
      label: "Local storage full — changes need attention",
      saved: false,
      synchronized: false
    });
    expect(derive({ durability: "server-full", draftRetained: true })).toEqual({
      announcement: "alert",
      actions: ["retry", "encrypted-export"],
      draftRetained: true,
      editing: true,
      id: "server-full",
      label: "Server storage full — changes kept on this device",
      saved: false,
      synchronized: false
    });
    expect(derive({ recovery: "divergent", draftRetained: true }).actions).toEqual([
      "review-draft",
      "encrypted-export",
      "reapply"
    ]);
  });

  it("never claims saved from a socket alone or while visible work is retained", () => {
    expect(derive({ connection: "connected", durability: "pending" })).toMatchObject({ saved: false, synchronized: false });
    expect(derive({ recovery: "divergent", durability: "clean", draftRetained: true })).toMatchObject({ saved: false, synchronized: false });
    expect(derive({ section: "ready", durability: "clean" })).toMatchObject({ saved: true, synchronized: true });
  });

  it("disables writes for viewer, trash, removed, repair, and protection transitions", () => {
    for (const overrides of [
      { access: "viewer" },
      { access: "trash" },
      { access: "removed" },
      { protection: "undecryptable" },
      { protection: "stale" },
      { protection: "preparing" }
    ] satisfies Partial<CollaborationDimensions>[]) {
      expect(derive(overrides).editing).toBe(false);
    }
  });
});
