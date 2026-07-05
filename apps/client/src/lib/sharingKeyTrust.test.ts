import { describe, expect, it } from "vitest";
import type { PublicSharingKey } from "../api";
import { createRegistrationCrypto, createUserSharingKey } from "../cryptoClient";
import {
  fingerprintPublicSharingKey,
  getSharingKeyTrustDecision,
  trustSharingKey
} from "./sharingKeyTrust";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("sharing key trust", () => {
  it("formats public key fingerprints stably", async () => {
    const alice = await createRegistrationCrypto("alice", "password");
    const key = await createUserSharingKey(alice.rootKey);

    const fingerprint = await fingerprintPublicSharingKey(key.opened.publicKey);

    await expect(fingerprintPublicSharingKey(key.opened.publicKey)).resolves.toBe(
      fingerprint
    );
    expect(fingerprint).toMatch(
      /^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/
    );
  });

  it("requires first-use confirmation before trusting a collaborator key", async () => {
    const owner = await createRegistrationCrypto("alice", "password");
    const bob = await createRegistrationCrypto("bob", "password");
    const bobKey = await createUserSharingKey(bob.rootKey);
    const storage = new MemoryStorage();
    const publicKey = publicSharingKey({
      userId: "bob_id",
      username: "bob",
      sharingKeyVersion: 1,
      publicKey: bobKey.opened.publicKey
    });

    const firstDecision = await getSharingKeyTrustDecision({
      ownerUserId: "alice_id",
      rootKey: owner.rootKey,
      publicKey,
      storage
    });
    expect(firstDecision.status).toBe("untrusted");

    const record = await trustSharingKey({
      ownerUserId: "alice_id",
      rootKey: owner.rootKey,
      publicKey,
      fingerprint: firstDecision.fingerprint,
      storage
    });

    await expect(
      getSharingKeyTrustDecision({
        ownerUserId: "alice_id",
        rootKey: owner.rootKey,
        publicKey,
        storage
      })
    ).resolves.toMatchObject({ status: "trusted", record });
    expect([...storage.values.values()].join("")).not.toContain("bob");
  });

  it("blocks a changed key for an already trusted user and version", async () => {
    const owner = await createRegistrationCrypto("alice", "password");
    const bob = await createRegistrationCrypto("bob", "password");
    const firstKey = await createUserSharingKey(bob.rootKey);
    const changedKey = await createUserSharingKey(bob.rootKey);
    const storage = new MemoryStorage();

    const trusted = publicSharingKey({
      userId: "bob_id",
      username: "bob",
      sharingKeyVersion: 1,
      publicKey: firstKey.opened.publicKey
    });
    await trustSharingKey({
      ownerUserId: "alice_id",
      rootKey: owner.rootKey,
      publicKey: trusted,
      storage
    });

    await expect(
      getSharingKeyTrustDecision({
        ownerUserId: "alice_id",
        rootKey: owner.rootKey,
        publicKey: {
          ...trusted,
          publicKey: changedKey.opened.publicKey
        },
        storage
      })
    ).resolves.toMatchObject({ status: "mismatch" });
  });

  it("requires confirmation for a new sharing key version", async () => {
    const owner = await createRegistrationCrypto("alice", "password");
    const bob = await createRegistrationCrypto("bob", "password");
    const versionOne = await createUserSharingKey(bob.rootKey, 1);
    const versionTwo = await createUserSharingKey(bob.rootKey, 2);
    const storage = new MemoryStorage();

    await trustSharingKey({
      ownerUserId: "alice_id",
      rootKey: owner.rootKey,
      publicKey: publicSharingKey({
        userId: "bob_id",
        username: "bob",
        sharingKeyVersion: 1,
        publicKey: versionOne.opened.publicKey
      }),
      storage
    });

    await expect(
      getSharingKeyTrustDecision({
        ownerUserId: "alice_id",
        rootKey: owner.rootKey,
        publicKey: publicSharingKey({
          userId: "bob_id",
          username: "bob",
          sharingKeyVersion: 2,
          publicKey: versionTwo.opened.publicKey
        }),
        storage
      })
    ).resolves.toMatchObject({ status: "untrusted" });
  });
});

function publicSharingKey(input: {
  userId: string;
  username: string;
  sharingKeyVersion: number;
  publicKey: string;
}): PublicSharingKey {
  return {
    ...input,
    formatVersion: 1,
    createdAt: new Date().toISOString()
  };
}
