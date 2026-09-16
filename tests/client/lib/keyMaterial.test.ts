import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromBase64 } from "@fortnote/shared";
import {
  decryptNoteTitleV2,
  decryptNoteKeyEnvelopeV2,
  noteKeyToBase64
} from "@client/cryptoClient";
import type { DecryptedNote } from "@client/store/appStore";

vi.mock("@client/api", () => ({
  getNoteKeyShare: vi.fn(),
  getSharingKeyVersion: vi.fn()
}));

import {
  linkedEpochPreparationMatches,
  prepareLinkedEpochRotation,
  resolveNoteKeyAtEpoch
} from "@client/lib/keyMaterial";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("linked epoch preparation", () => {
  it("activates a fresh key while preserving a backward-only link", async () => {
    const rootKey = key(20);
    const sourceNoteKey = key(30);
    const note = decryptedNote({ noteKeyBase64: noteKeyToBase64(sourceNoteKey) });

    const preparation = await prepareLinkedEpochRotation({
      note,
      revokedUserId: "user-revoked",
      rootKey
    });

    const targetNoteKey = await decryptNoteKeyEnvelopeV2({
      cryptoOwnerId: note.cryptoOwnerId,
      noteId: note.id,
      keyEpoch: 2,
      rootKey,
      envelope: {
        cipher: preparation.encryptedNoteKey,
        nonce: preparation.noteKeyNonce,
        formatVersion: 2
      }
    });
    expect(targetNoteKey).toEqual(fromBase64(preparation.targetNoteKeyBase64));
    await expect(
      decryptNoteTitleV2({
        cryptoOwnerId: note.cryptoOwnerId,
        noteId: note.id,
        keyEpoch: 2,
        noteKey: targetNoteKey,
        envelope: {
          cipher: preparation.titleCipher,
          nonce: preparation.titleNonce,
          formatVersion: 2
        }
      })
    ).resolves.toBe(note.title);
    await expect(
      resolveNoteKeyAtEpoch({
        note: {
          ...note,
          keyEpoch: 2,
          noteKeyBase64: preparation.targetNoteKeyBase64
        },
        targetEpoch: 1,
        links: [
          {
            sourceEpoch: 1,
            targetEpoch: 2,
            previousKeyCipher: preparation.previousKeyCipher,
            nonce: preparation.previousKeyNonce,
            formatVersion: 2,
            createdAt: "2026-07-18T00:00:00.000Z"
          }
        ]
      })
    ).resolves.toEqual(sourceNoteKey);
    expect(
      linkedEpochPreparationMatches({
        preparation,
        note,
        revokedUserId: "user-revoked"
      })
    ).toBe(true);
  });
});

function key(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => seed + index);
}

function decryptedNote(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    id: "note-a",
    folderId: null,
    title: "Title",
    noteKeyBase64: noteKeyToBase64(key(30)),
    version: 1,
    rootVersion: 1,
    rootSectionId: "section-a",
    keyEpoch: 1,
    isDeleted: false,
    updatedAt: "2026-07-18T00:00:00.000Z",
    ownerUserId: "owner-a",
    cryptoOwnerId: "owner-a",
    role: "owner",
    ...overrides
  };
}
