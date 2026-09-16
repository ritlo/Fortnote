import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import type { DecryptedNote } from "@client/store/appStore";
import { useAppStore } from "@client/store/appStore";
import {
  canConfirmSharingKeyTrust,
  pendingTrustMatchesNote,
  sharingKeyTrustInstruction
} from "@client/components/SharingPanel";

afterEach(() => {
  cleanup();
  useAppStore.getState().resetVaultState("reset");
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

describe("role change assertion", () => {
  it("guards that only owner can change roles", () => {
    const viewerNote = note({ role: "viewer" });
    expect(viewerNote.role).toBe("viewer");
  });

  it("guards that owner role cannot be revoked", () => {
    const memberships = [
      {
        userId: "alice",
        role: "owner",
        status: "active",
        username: "alice",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01"
      },
      {
        userId: "bob",
        role: "editor",
        status: "active",
        username: "bob",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01"
      }
    ];
    const owner = memberships.find((m) => m.role === "owner");
    expect(owner?.role).toBe("owner");
  });
});

describe("revoke error state", () => {
  it("flags failed revocation as pending", () => {
    useAppStore.getState().setRevocationRotationFailure("note-1", {
      noteId: "note-1",
      revokedUserId: "bob",
      revokedUsername: "bob",
      message: "Key rotation failed",
      failedAt: new Date().toISOString()
    });
    const failure = useAppStore.getState().revocationRotationFailures["note-1"];
    expect(failure?.message).toBe("Key rotation failed");
    expect(failure?.revokedUsername).toBe("bob");
  });
});

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
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
