import { describe, expect, it } from "vitest";
import {
  createAccountRecoveryCrypto,
  createEncryptedNoteDraft,
  createEpochLinkV2,
  createUserSharingKey,
  createLoginAuthVerifier,
  createRegistrationCrypto,
  decryptNoteKeyShare,
  decryptNote,
  decryptCrdtMessage,
  decryptAttachmentMetadataV2,
  decryptContentChunkV2,
  decryptFolderNameV2,
  decryptNoteKeyEnvelopeV2,
  decryptNoteKeyShareV2,
  decryptNoteTitleV2,
  decryptRootKeyEnvelopeV2,
  decryptSharingPrivateKeyEnvelopeV2,
  encryptAttachmentMetadataV2,
  encryptContentChunkV2,
  encryptCrdtMessage,
  encryptFolderNameV2,
  encryptNoteKeyEnvelopeV2,
  encryptNoteKeyShareV2,
  encryptNoteTitleV2,
  encryptRootKeyEnvelopeV2,
  encryptSharingPrivateKeyEnvelopeV2,
  encryptNoteKeyShare,
  noteKeyToBase64,
  openUserSharingKey,
  openVault,
  traverseEpochLinksBackward
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

  it("binds protected display metadata to its exact v2 context", async () => {
    const rootKey = key(1);
    const noteKey = key(2);
    const title = await encryptNoteTitleV2({
      cryptoOwnerId: "owner-a",
      noteId: "note-a",
      keyEpoch: 2,
      noteKey,
      title: "Private title"
    });
    await expect(
      decryptNoteTitleV2({
        cryptoOwnerId: "owner-a",
        noteId: "note-a",
        keyEpoch: 2,
        noteKey,
        envelope: title
      })
    ).resolves.toBe("Private title");
    await expect(
      decryptNoteTitleV2({
        cryptoOwnerId: "owner-a",
        noteId: "note-b",
        keyEpoch: 2,
        noteKey,
        envelope: title
      })
    ).rejects.toThrow();

    const folder = await encryptFolderNameV2({
      userId: "owner-a",
      folderId: "folder-a",
      rootKey,
      name: "Private folder"
    });
    await expect(
      decryptFolderNameV2({
        userId: "owner-a",
        folderId: "folder-a",
        rootKey,
        envelope: folder
      })
    ).resolves.toBe("Private folder");

    const metadata = await encryptAttachmentMetadataV2({
      cryptoOwnerId: "owner-a",
      noteId: "note-a",
      attachmentId: "attachment-a",
      keyEpoch: 2,
      noteKey,
      filename: "private-plan.pdf",
      mimeType: "application/pdf"
    });
    await expect(
      decryptAttachmentMetadataV2({
        cryptoOwnerId: "owner-a",
        noteId: "note-a",
        attachmentId: "attachment-a",
        keyEpoch: 2,
        noteKey,
        envelope: metadata
      })
    ).resolves.toEqual({
      filename: "private-plan.pdf",
      mimeType: "application/pdf"
    });
  });

  it("binds root, private-sharing, and note-key envelopes and rejects v1 downgrade", async () => {
    const wrappingKey = key(3);
    const rootKey = key(4);
    const noteKey = key(5);
    const privateKey = key(6);
    const rootEnvelope = await encryptRootKeyEnvelopeV2({
      userId: "owner-a",
      keyMaterialVersion: 3,
      rootKey,
      wrappingKey
    });
    await expect(
      decryptRootKeyEnvelopeV2({
        userId: "owner-a",
        keyMaterialVersion: 3,
        wrappingKey,
        envelope: rootEnvelope
      })
    ).resolves.toEqual(rootKey);
    await expect(
      decryptRootKeyEnvelopeV2({
        userId: "owner-a",
        keyMaterialVersion: 3,
        wrappingKey,
        envelope: { ...rootEnvelope, formatVersion: 1 }
      })
    ).rejects.toThrow("downgrade");

    const privateEnvelope = await encryptSharingPrivateKeyEnvelopeV2({
      userId: "owner-a",
      sharingKeyVersion: 4,
      rootKey,
      privateKey
    });
    await expect(
      decryptSharingPrivateKeyEnvelopeV2({
        userId: "owner-a",
        sharingKeyVersion: 4,
        rootKey,
        envelope: privateEnvelope
      })
    ).resolves.toEqual(privateKey);

    const noteEnvelope = await encryptNoteKeyEnvelopeV2({
      cryptoOwnerId: "owner-a",
      noteId: "note-a",
      keyEpoch: 2,
      rootKey,
      noteKey
    });
    await expect(
      decryptNoteKeyEnvelopeV2({
        cryptoOwnerId: "owner-a",
        noteId: "note-a",
        keyEpoch: 2,
        rootKey,
        envelope: noteEnvelope
      })
    ).resolves.toEqual(noteKey);
  });

  it("validates the exact note-share account, key version, note, and epoch", async () => {
    const recipient = await createUserSharingKey(key(7), 5);
    const context = {
      cryptoOwnerId: "owner-a",
      noteId: "note-a",
      keyEpoch: 4,
      recipientUserId: "recipient-a",
      recipientSharingKeyVersion: 5
    };
    const encryptedNoteKey = await encryptNoteKeyShareV2({
      ...context,
      noteKey: key(8),
      recipientPublicKey: recipient.opened.publicKey
    });
    await expect(
      decryptNoteKeyShareV2({
        ...context,
        encryptedNoteKey,
        publicKey: recipient.opened.publicKey,
        privateKey: recipient.opened.privateKey
      })
    ).resolves.toEqual(key(8));
    await expect(
      decryptNoteKeyShareV2({
        ...context,
        recipientSharingKeyVersion: 6,
        encryptedNoteKey,
        publicKey: recipient.opened.publicKey,
        privateKey: recipient.opened.privateKey
      })
    ).rejects.toThrow("context mismatch");
  });

  it("authenticates each bounded chunk independently", async () => {
    const context = {
      cryptoOwnerId: "owner-a",
      noteId: "note-a",
      sectionId: "section-a",
      keyEpoch: 2,
      updateId: crypto.randomUUID(),
      uploadId: crypto.randomUUID(),
      chunkIndex: 0,
      chunkCount: 2,
      totalCipherBytes: 128,
      kind: "update" as const,
      noteKey: key(9)
    };
    const envelope = await encryptContentChunkV2({
      ...context,
      plaintext: new Uint8Array([1, 2, 3])
    });
    await expect(decryptContentChunkV2({ ...context, envelope })).resolves.toEqual(
      new Uint8Array([1, 2, 3])
    );
    await expect(
      decryptContentChunkV2({ ...context, chunkIndex: 1, envelope })
    ).rejects.toThrow();
  });

  it("traverses only adjacent authenticated epoch links backward", async () => {
    const first = key(10);
    const second = key(11);
    const third = key(12);
    const firstLink = await createEpochLinkV2({
      cryptoOwnerId: "owner-a",
      noteId: "note-a",
      sourceEpoch: 1,
      targetEpoch: 2,
      sourceNoteKey: first,
      targetNoteKey: second
    });
    const secondLink = await createEpochLinkV2({
      cryptoOwnerId: "owner-a",
      noteId: "note-a",
      sourceEpoch: 2,
      targetEpoch: 3,
      sourceNoteKey: second,
      targetNoteKey: third
    });

    await expect(
      traverseEpochLinksBackward({
        cryptoOwnerId: "owner-a",
        noteId: "note-a",
        currentEpoch: 3,
        targetEpoch: 1,
        currentNoteKey: third,
        links: [firstLink, secondLink]
      })
    ).resolves.toEqual(first);
    await expect(
      traverseEpochLinksBackward({
        cryptoOwnerId: "owner-a",
        noteId: "note-a",
        currentEpoch: 3,
        targetEpoch: 1,
        currentNoteKey: third,
        links: [firstLink]
      })
    ).rejects.toThrow("Missing adjacent");
  });
});

function key(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256);
}
