import { describe, expect, it } from "vitest";
import {
  createAccountRecoveryCrypto,
  createEncryptedNoteDraft,
  createUserSharingKey,
  createLoginAuthVerifier,
  createRegistrationCrypto,
  decryptNoteKeyShare,
  decryptNote,
  decryptCrdtMessage,
  encryptCrdtMessage,
  encryptNoteKeyShare,
  noteKeyToBase64,
  openUserSharingKey,
  openVault
} from "./cryptoClient";

describe("client crypto workflows", () => {
  it("registers, opens the vault, and decrypts a note", async () => {
    const registration = await createRegistrationCrypto(
      "alice",
      "correct horse battery staple"
    );
    const opened = await openVault(
      "correct horse battery staple",
      registration.payload.authKdf,
      registration.payload.vaultKdf,
      registration.payload.encryptedRootKey,
      registration.payload.rootKeyNonce
    );

    expect(opened.authVerifier).toBe(registration.payload.authVerifier);

    const draft = await createEncryptedNoteDraft({
      userId: "user_a",
      rootKey: opened.rootKey,
      title: "Note",
      body: "Secret body"
    });
    const decrypted = await decryptNote({
      userId: "user_a",
      rootKey: opened.rootKey,
      noteId: draft.id,
      encryptedNoteKey: {
        cipher: draft.encryptedNoteKey,
        nonce: draft.noteKeyNonce,
        formatVersion: 1
      },
      encryptedBody: {
        cipher: draft.contentCipher,
        nonce: draft.contentNonce,
        formatVersion: 1
      }
    });

    expect(decrypted.body).toBe("Secret body");
  });

  it("recovers the root key and creates a new password envelope", async () => {
    const registration = await createRegistrationCrypto("alice", "old password");
    const recovery = await createAccountRecoveryCrypto({
      recoverySecret: registration.recoverySecret,
      recoveryKdf: registration.payload.recoveryKdf,
      recoveryEncryptedRootKey: registration.payload.recoveryEncryptedRootKey,
      recoveryRootKeyNonce: registration.payload.recoveryRootKeyNonce,
      newPassword: "new password"
    });
    const opened = await openVault(
      "new password",
      recovery.passwordChange.authKdf,
      recovery.passwordChange.vaultKdf,
      recovery.passwordChange.encryptedRootKey,
      recovery.passwordChange.rootKeyNonce
    );
    const newVerifier = await createLoginAuthVerifier(
      "new password",
      recovery.passwordChange.authKdf
    );

    expect(opened.rootKey).toEqual(registration.rootKey);
    expect(newVerifier).toBe(recovery.passwordChange.authVerifier);
  });

  it("wraps sharing keys with the root key", async () => {
    const registration = await createRegistrationCrypto("alice", "password");
    const sharingKey = await createUserSharingKey(registration.rootKey);

    const opened = await openUserSharingKey({
      rootKey: registration.rootKey,
      envelope: {
        ...sharingKey.payload,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });

    expect(opened).toEqual(sharingKey.opened);
  });

  it("encrypts note key shares for one collaborator", async () => {
    const alice = await createRegistrationCrypto("alice", "password");
    const bob = await createRegistrationCrypto("bob", "password");
    const carol = await createRegistrationCrypto("carol", "password");
    const bobSharingKey = await createUserSharingKey(bob.rootKey);
    const carolSharingKey = await createUserSharingKey(carol.rootKey);
    const note = await createEncryptedNoteDraft({
      userId: "alice_user",
      rootKey: alice.rootKey,
      title: "Shared",
      body: "Shared body"
    });
    const noteKeyBase64 = noteKeyToBase64(note.noteKey);

    const encryptedShare = await encryptNoteKeyShare({
      noteKeyBase64,
      recipientPublicKey: bobSharingKey.opened.publicKey
    });

    await expect(
      decryptNoteKeyShare({
        encryptedNoteKey: encryptedShare,
        publicKey: carolSharingKey.opened.publicKey,
        privateKey: carolSharingKey.opened.privateKey
      })
    ).rejects.toThrow();

    await expect(
      decryptNoteKeyShare({
        encryptedNoteKey: encryptedShare,
        publicKey: bobSharingKey.opened.publicKey,
        privateKey: bobSharingKey.opened.privateKey
      })
    ).resolves.toBe(noteKeyBase64);
  });

  it("round-trips encrypted CRDT checkpoints", async () => {
    const registration = await createRegistrationCrypto("alice", "password");
    const note = await createEncryptedNoteDraft({
      userId: "alice_user",
      rootKey: registration.rootKey,
      title: "Shared",
      body: "Shared body"
    });
    const input = {
      type: "crdt-checkpoint" as const,
      formatVersion: 1,
      cryptoOwnerId: "alice_user",
      noteId: note.id,
      noteKeyBase64: noteKeyToBase64(note.noteKey),
      keyEpoch: 1,
      updateId: crypto.randomUUID(),
      compactedUpdateIds: [crypto.randomUUID()],
      update: new Uint8Array([1, 2, 3])
    };
    const encrypted = await encryptCrdtMessage(input);

    await expect(
      decryptCrdtMessage({
        ...input,
        ...encrypted
      })
    ).resolves.toEqual(input.update);
  });
});
