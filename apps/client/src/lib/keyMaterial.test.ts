import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromBase64 } from "@fortnote/shared";
import {
  decryptNoteTitleV2,
  decryptNoteKeyEnvelopeV2,
  decryptRootKeyEnvelopeV2,
  noteKeyToBase64
} from "../cryptoClient";
import type { DecryptedNote } from "../store/appStore";

const mocks = vi.hoisted(() => ({
  updateKeyMaterial: vi.fn()
}));

vi.mock("../api", () => ({
  getNoteKeyShare: vi.fn(),
  getSharingKeyVersion: vi.fn(),
  updateKeyMaterial: mocks.updateKeyMaterial
}));

import {
  linkedEpochPreparationMatches,
  migrateRootKeyEnvelopeV2,
  prepareLinkedEpochRotation,
  resolveNoteKeyAtEpoch
} from "./keyMaterial";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateKeyMaterial.mockResolvedValue({ keyMaterialVersion: 4 });
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

describe("root key envelope migration", () => {
  it("writes v2 against the atomically activated material version", async () => {
    const rootKey = key(1);
    const vaultKey = key(2);

    await expect(
      migrateRootKeyEnvelopeV2({
        userId: "user-a",
        rootKey,
        vaultKey,
        vaultKdf: { salt: "salt", opsLimit: 4, memLimit: 67_108_864, version: 1 },
        keyMaterialVersion: 3,
        rootKeyFormatVersion: 1
      })
    ).resolves.toBe(4);

    expect(mocks.updateKeyMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        rootKeyFormatVersion: 2,
        rootKeyContextVersion: 4,
        keyMaterialVersion: 3
      })
    );
    const payload = mocks.updateKeyMaterial.mock.calls[0]![0];
    await expect(
      decryptRootKeyEnvelopeV2({
        userId: "user-a",
        keyMaterialVersion: 4,
        wrappingKey: vaultKey,
        envelope: {
          cipher: payload.encryptedRootKey,
          nonce: payload.rootKeyNonce,
          formatVersion: payload.rootKeyFormatVersion
        }
      })
    ).resolves.toEqual(rootKey);
  });

  it("does not rewrite an envelope that is already v2", async () => {
    await expect(
      migrateRootKeyEnvelopeV2({
        userId: "user-a",
        rootKey: key(1),
        vaultKey: key(2),
        vaultKdf: { salt: "salt", opsLimit: 4, memLimit: 67_108_864, version: 1 },
        keyMaterialVersion: 5,
        rootKeyFormatVersion: 2
      })
    ).resolves.toBe(5);

    expect(mocks.updateKeyMaterial).not.toHaveBeenCalled();
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
    body: "Body",
    noteKeyBase64: noteKeyToBase64(key(30)),
    contentLength: 4,
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
