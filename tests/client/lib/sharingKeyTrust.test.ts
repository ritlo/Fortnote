import { describe, expect, it } from "vitest";
import type { PublicSharingKey } from "@client/api";
import { createRegistrationCrypto, createUserSharingKey } from "@client/cryptoClient";
import {
  fingerprintPublicSharingKey,
  getSharingKeyTrustDecision,
  removeSharingKeyTrustRecords,
  trustSharingKey
} from "@client/lib/sharingKeyTrust";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("sharing key trust", () => {
  it("formats public key fingerprints stably", async () => {
    const alice = await createRegistrationCrypto("alice", "password");
    const key = await createUserSharingKey(alice.rootKey, 1, "bob_id");

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
    const bobKey = await createUserSharingKey(bob.rootKey, 1, "bob_id");
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
    const firstKey = await createUserSharingKey(bob.rootKey, 1, "bob_id");
    const changedKey = await createUserSharingKey(bob.rootKey, 1, "bob_id");
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
    const versionOne = await createUserSharingKey(bob.rootKey, 1, "bob_id");
    const versionTwo = await createUserSharingKey(bob.rootKey, 2, "bob_id");
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

  it("binds trust to the exact collaborator account and key version", async () => {
    const owner = await createRegistrationCrypto("alice", "password");
    const bob = await createRegistrationCrypto("bob", "password");
    const key = await createUserSharingKey(bob.rootKey, 1, "bob_id");
    const storage = new MemoryStorage();
    const trusted = publicSharingKey({
      userId: "bob_id",
      username: "bob",
      sharingKeyVersion: 1,
      publicKey: key.opened.publicKey
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
        publicKey: { ...trusted, userId: "mallory_id", username: "mallory" },
        storage
      })
    ).resolves.toMatchObject({ status: "untrusted" });
    await expect(
      getSharingKeyTrustDecision({
        ownerUserId: "alice_id",
        rootKey: owner.rootKey,
        publicKey: { ...trusted, sharingKeyVersion: 2 },
        storage
      })
    ).resolves.toMatchObject({ status: "untrusted" });
  });

  it("removes only the signed-out account's encrypted trust record", async () => {
    const alice = await createRegistrationCrypto("alice", "password");
    const charlie = await createRegistrationCrypto("charlie", "password");
    const bob = await createRegistrationCrypto("bob", "password");
    const bobKey = await createUserSharingKey(bob.rootKey, 1, "bob_id");
    const storage = new MemoryStorage();
    const publicKey = publicSharingKey({
      userId: "bob_id",
      username: "bob",
      sharingKeyVersion: 1,
      publicKey: bobKey.opened.publicKey
    });

    await trustSharingKey({
      ownerUserId: "alice_id",
      rootKey: alice.rootKey,
      publicKey,
      storage
    });
    await trustSharingKey({
      ownerUserId: "charlie_id",
      rootKey: charlie.rootKey,
      publicKey,
      storage
    });

    removeSharingKeyTrustRecords("alice_id", storage);

    await expect(
      getSharingKeyTrustDecision({
        ownerUserId: "alice_id",
        rootKey: alice.rootKey,
        publicKey,
        storage
      })
    ).resolves.toMatchObject({ status: "untrusted" });
    await expect(
      getSharingKeyTrustDecision({
        ownerUserId: "charlie_id",
        rootKey: charlie.rootKey,
        publicKey,
        storage
      })
    ).resolves.toMatchObject({ status: "trusted" });
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
