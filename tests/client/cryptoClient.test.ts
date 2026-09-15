import { describe, expect, it } from "vitest";
import {
  createAccountRecoveryCrypto,
  createEpochLinkV2,
  createUserSharingKey,
  createLoginAuthVerifier,
  createPasswordChangeCrypto,
  createProtectedNoteDraftV2,
  createRegistrationCrypto,
  createRecoveryRotationCrypto,
  decryptCrdtMessage,
  decryptAttachmentMetadataV2,
  decryptContentChunkV2,
  decryptContentChunksV2,
  decryptFolderNameV2,
  decryptNoteKeyEnvelopeV2,
  decryptNoteKeyShareV2,
  decryptNoteTitleV2,
  decryptRootKeyEnvelopeV2,
  decryptSharingPrivateKeyEnvelopeV2,
  encryptAttachmentMetadataV2,
  encryptContentChunkV2,
  encryptContentChunksV2,
  encryptCrdtMessage,
  encryptFolderNameV2,
  encryptNoteKeyEnvelopeV2,
  encryptNoteKeyShareV2,
  encryptNoteTitleV2,
  encryptRootKeyEnvelopeV2,
  encryptSharingPrivateKeyEnvelopeV2,
  noteKeyToBase64,
  openUserSharingKey,
  openVault,
  traverseEpochLinksBackward
} from "@client/cryptoClient";

describe("client crypto workflows", () => {
  it("registers, opens the vault, and unwraps a note key", async () => {
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

    const draft = await createProtectedNoteDraftV2({
      cryptoOwnerId: "user_a",
      rootKey: opened.rootKey,
      title: "Note"
    });
    await expect(
      decryptNoteKeyEnvelopeV2({
        cryptoOwnerId: "user_a",
        noteId: draft.id,
        keyEpoch: 1,
        rootKey: opened.rootKey,
        envelope: {
          cipher: draft.encryptedNoteKey,
          nonce: draft.noteKeyNonce,
          formatVersion: 2
        }
      })
    ).resolves.toEqual(draft.noteKey);
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

  it("opens context-bound password and recovery root envelopes", async () => {
    const registration = await createRegistrationCrypto("alice", "old password");
    const passwordChange = await createPasswordChangeCrypto(
      registration.rootKey,
      "new password",
      { userId: "user-a", keyMaterialVersion: 2 }
    );
    const opened = await openVault(
      "new password",
      passwordChange.authKdf,
      passwordChange.vaultKdf,
      passwordChange.encryptedRootKey,
      passwordChange.rootKeyNonce,
      { userId: "user-a", formatVersion: 2, contextVersion: 2 }
    );
    expect(opened.rootKey).toEqual(registration.rootKey);

    const recoveryRotation = await createRecoveryRotationCrypto(registration.rootKey, {
      userId: "user-a",
      keyMaterialVersion: 3
    });
    const recovered = await createAccountRecoveryCrypto({
      recoverySecret: recoveryRotation.recoverySecret,
      recoveryKdf: recoveryRotation.recoveryKdf,
      recoveryEncryptedRootKey: recoveryRotation.recoveryEncryptedRootKey,
      recoveryRootKeyNonce: recoveryRotation.recoveryRootKeyNonce,
      recoveryRootKeyFormatVersion: 2,
      recoveryRootKeyContextVersion: 3,
      userId: "user-a",
      nextKeyMaterialVersion: 4,
      newPassword: "recovered password"
    });
    expect(recovered.rootKey).toEqual(registration.rootKey);
    expect(recovered.passwordChange).toMatchObject({
      rootKeyFormatVersion: 2,
      rootKeyContextVersion: 4
    });
  });

  it("wraps sharing keys with the root key", async () => {
    const registration = await createRegistrationCrypto("alice", "password");
    const sharingKey = await createUserSharingKey(registration.rootKey, 1, "alice_user");

    const opened = await openUserSharingKey({
      userId: "alice_user",
      rootKey: registration.rootKey,
      envelope: {
        ...sharingKey.payload,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });

    expect(opened).toEqual(sharingKey.opened);
  });

  it("round-trips section-bound v2 CRDT checkpoints", async () => {
    const input = {
      type: "crdt-checkpoint" as const,
      formatVersion: 2 as const,
      cryptoOwnerId: "alice_user",
      noteId: crypto.randomUUID(),
      sectionId: crypto.randomUUID(),
      noteKeyBase64: noteKeyToBase64(key(13)),
      keyEpoch: 1,
      updateId: crypto.randomUUID(),
      kind: "checkpoint" as const,
      checkpointSequenceCutoff: 7,
      update: new Uint8Array([1, 2, 3])
    };
    const encrypted = await encryptCrdtMessage(input);

    expect(encrypted.formatVersion).toBe(2);
    await expect(
      decryptCrdtMessage({
        ...input,
        cipher: encrypted.cipher,
        nonce: encrypted.nonce
      })
    ).resolves.toEqual(input.update);
    await expect(
      decryptCrdtMessage({
        ...input,
        sectionId: crypto.randomUUID(),
        cipher: encrypted.cipher,
        nonce: encrypted.nonce
      })
    ).rejects.toThrow();
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
      publicKey: "public-key-a",
      rootKey,
      privateKey
    });
    await expect(
      decryptSharingPrivateKeyEnvelopeV2({
        userId: "owner-a",
        sharingKeyVersion: 4,
        publicKey: "public-key-a",
        rootKey,
        envelope: privateEnvelope
      })
    ).resolves.toEqual(privateKey);
    await expect(
      decryptSharingPrivateKeyEnvelopeV2({
        userId: "owner-a",
        sharingKeyVersion: 4,
        publicKey: "public-key-b",
        rootKey,
        envelope: privateEnvelope
      })
    ).rejects.toThrow();

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
    const recipient = await createUserSharingKey(key(7), 5, "recipient-a");
    const context = {
      cryptoOwnerId: "owner-a",
      noteId: "note-a",
      keyEpoch: 4,
      recipientUserId: "recipient-a",
      recipientSharingKeyVersion: 5,
      senderUserId: "owner-a"
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
    for (const changed of [
      { cryptoOwnerId: "owner-b" },
      { noteId: "note-b" },
      { sectionId: "section-b" },
      { keyEpoch: 3 },
      { updateId: crypto.randomUUID() },
      { uploadId: crypto.randomUUID() },
      { chunkCount: 3 },
      { totalCipherBytes: 129 },
      { kind: "root-update" as const }
    ]) {
      await expect(
        decryptContentChunkV2({ ...context, ...changed, envelope })
      ).rejects.toThrow();
    }

    const checkpointContext = {
      ...context,
      kind: "checkpoint" as const,
      checkpointSequenceCutoff: 7
    };
    const checkpoint = await encryptContentChunkV2({
      ...checkpointContext,
      plaintext: new Uint8Array([4, 5, 6])
    });
    await expect(
      decryptContentChunkV2({
        ...checkpointContext,
        checkpointSequenceCutoff: 8,
        envelope: checkpoint
      })
    ).rejects.toThrow();
  });

  it("encrypts bounded chunks and verifies the complete set before decryption", async () => {
    const plaintext = Uint8Array.from({ length: 37 }, (_, index) => index);
    const prepared = await encryptContentChunksV2({
      cryptoOwnerId: "owner-a",
      noteId: "note-a",
      sectionId: "section-a",
      keyEpoch: 2,
      updateId: crypto.randomUUID(),
      uploadId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      kind: "update",
      noteKey: key(10),
      plaintext,
      maxCipherChunkBytes: 32
    });

    expect(prepared.chunkCount).toBe(3);
    expect(prepared.totalCipherBytes).toBe(plaintext.byteLength + 3 * 16);
    expect(prepared.chunks.every((chunk) => chunk.cipherBytes.byteLength <= 32)).toBe(
      true
    );
    expect(new Set(prepared.chunks.map((chunk) => chunk.nonce)).size).toBe(3);
    await expect(
      decryptContentChunksV2({
        ...prepared,
        noteKey: key(10),
        chunks: [...prepared.chunks].reverse()
      })
    ).resolves.toEqual(plaintext);

    await expect(
      decryptContentChunksV2({
        ...prepared,
        noteKey: key(10),
        chunks: prepared.chunks.slice(1)
      })
    ).rejects.toThrow("incomplete");
    const corrupted = prepared.chunks.map((chunk) => ({
      ...chunk,
      cipherBytes: chunk.cipherBytes.slice()
    }));
    const corruptedByte = corrupted[1]?.cipherBytes[0];
    if (corruptedByte === undefined) {
      throw new Error("Expected a second encrypted chunk");
    }
    corrupted[1]!.cipherBytes[0] = corruptedByte ^ 1;
    await expect(
      decryptContentChunksV2({
        ...prepared,
        noteKey: key(10),
        chunks: corrupted
      })
    ).rejects.toThrow("hash mismatch");
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
