import { describe, expect, it, vi } from "vitest";
import type { NoteMembership } from "../api";
import type { DecryptedNote } from "../store/appStore";
import {
  canConfirmSharingKeyTrust,
  pendingTrustMatchesNote,
  recoverCommittedRevocationAfterFailure,
  sharingKeyTrustInstruction
} from "./SharingPanel";

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

describe("pendingTrustMatchesNote", () => {
  it("rejects confirmation after selecting another note", () => {
    const pending = { noteId: "note-1", noteKeyBase64: "key-1" };

    expect(pendingTrustMatchesNote(pending, note({ id: "note-2" }))).toBe(false);
  });

  it("rejects confirmation after the note key rotates", () => {
    const pending = { noteId: "note-1", noteKeyBase64: "key-1" };

    expect(
      pendingTrustMatchesNote(
        pending,
        note({ id: "note-1", noteKeyBase64: "rotated-key" })
      )
    ).toBe(false);
  });

  it("accepts the originating note and key context", () => {
    const pending = { noteId: "note-1", noteKeyBase64: "key-1" };

    expect(pendingTrustMatchesNote(pending, note({ id: "note-1" }))).toBe(true);
  });
});

describe("sharing key confirmation", () => {
  it("requires explicit confirmation of the exact key", () => {
    expect(canConfirmSharingKeyTrust(false)).toBe(false);
    expect(canConfirmSharingKeyTrust(true)).toBe(true);
  });

  it("instructs users to compare the fingerprint independently", () => {
    const instruction = sharingKeyTrustInstruction("bob");

    expect(instruction).toContain("exact fingerprint");
    expect(instruction).toContain("bob");
    expect(instruction).toContain("independent channel");
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

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    body: "",
    contentLength: 0,
    cryptoOwnerId: "alice",
    folderId: null,
    id: "note-1",
    isDeleted: false,
    noteKeyBase64: "key-1",
    ownerUserId: "alice",
    role: "owner",
    title: "Title",
    updatedAt: "2026-07-10T00:00:00.000Z",
    version: 1,
    keyEpoch: 1,
    ...overrides
  };
}
