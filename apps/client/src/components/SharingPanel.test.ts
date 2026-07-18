import { describe, expect, it } from "vitest";
import type { DecryptedNote } from "../store/appStore";
import {
  canConfirmSharingKeyTrust,
  pendingTrustMatchesNote,
  sharingKeyTrustInstruction
} from "./SharingPanel";

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
