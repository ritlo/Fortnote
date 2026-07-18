import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptRootKeyEnvelopeV2 } from "../cryptoClient";

const mocks = vi.hoisted(() => ({
  updateKeyMaterial: vi.fn()
}));

vi.mock("../api", () => ({
  getNoteKeyShare: vi.fn(),
  getSharingKeyVersion: vi.fn(),
  updateKeyMaterial: mocks.updateKeyMaterial
}));

import { migrateRootKeyEnvelopeV2 } from "./keyMaterial";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateKeyMaterial.mockResolvedValue({ keyMaterialVersion: 4 });
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
