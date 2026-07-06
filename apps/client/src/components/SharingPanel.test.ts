import { describe, expect, it, vi } from "vitest";
import type { NoteMembership } from "../api";
import { recoverCommittedRevocationAfterFailure } from "./SharingPanel";

describe("recoverCommittedRevocationAfterFailure", () => {
  it("rotates keys when the revoked membership is already committed", async () => {
    const memberships = [
      membership({ userId: "owner", username: "alice", role: "owner" }),
      membership({ userId: "bob", username: "bob", status: "revoked" })
    ];
    const setMemberships = vi.fn();
    const finishRotation = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      recoverCommittedRevocationAfterFailure({
        finishRotation,
        listMemberships: vi.fn().mockResolvedValue({ memberships }),
        memberUserId: "bob",
        noteId: "note-1",
        setMemberships
      })
    ).resolves.toBe(true);

    expect(setMemberships).toHaveBeenCalledWith(memberships);
    expect(finishRotation).toHaveBeenCalledWith(memberships);
  });

  it("leaves ordinary revoke failures for the caller", async () => {
    const memberships = [
      membership({ userId: "owner", username: "alice", role: "owner" }),
      membership({ userId: "bob", username: "bob", status: "active" })
    ];
    const setMemberships = vi.fn();
    const finishRotation = vi.fn<() => Promise<void>>();

    await expect(
      recoverCommittedRevocationAfterFailure({
        finishRotation,
        listMemberships: vi.fn().mockResolvedValue({ memberships }),
        memberUserId: "bob",
        noteId: "note-1",
        setMemberships
      })
    ).resolves.toBe(false);

    expect(setMemberships).not.toHaveBeenCalled();
    expect(finishRotation).not.toHaveBeenCalled();
  });
});

function membership(overrides: Partial<NoteMembership>): NoteMembership {
  return {
    createdAt: "2026-07-06T00:00:00.000Z",
    role: "editor",
    status: "active",
    updatedAt: "2026-07-06T00:00:00.000Z",
    userId: "user-1",
    username: "user",
    ...overrides
  };
}
