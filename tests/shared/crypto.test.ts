import { beforeAll, describe, expect, it } from "vitest";
import {
  associatedDataV2,
  attachmentAssociatedData,
  contentChunkAssociatedData,
  crdtBinaryAssociatedData,
  createKdfParams,
  cryptoReady,
  createSharingKeyPair,
  decryptBytes,
  deriveAuthVerifier,
  deriveRecoveryAuthVerifier,
  deriveRecoveryWrappingKey,
  deriveVaultWrappingKey,
  encryptBytes,
  encryptBytesV2,
  epochLinkAssociatedData,
  fromBase64,
  fromCanonicalBase64,
  generateRecoverySecret,
  hkdfSha256,
  openSealedBytes,
  randomBytes,
  sealBytes,
  toBase64,
  utf8,
  validateEncryptedPayload
} from "@shared/crypto.js";

describe("crypto helpers", () => {
  beforeAll(async () => {
    await cryptoReady();
  });

  it("derives separate auth and vault keys from one password", async () => {
    const params = createKdfParams();
    const auth = await deriveAuthVerifier("correct horse", params);
    const vault = await deriveVaultWrappingKey("correct horse", params);

    expect(toBase64(auth)).not.toEqual(toBase64(vault));
  });

  it("matches the RFC 5869 HKDF-SHA-256 test vector", async () => {
    const hex = (value: string) =>
      Uint8Array.from(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
    const derived = await hkdfSha256(
      hex("0b".repeat(22)),
      hex("000102030405060708090a0b0c"),
      hex("f0f1f2f3f4f5f6f7f8f9"),
      42
    );

    expect(toBase64(derived)).toEqual(
      toBase64(
        hex(
          "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        )
      )
    );
  });

  it("rejects attachment ciphertext moved to another note", async () => {
    const key = randomBytes(32);
    const encrypted = await encryptBytes(
      utf8("file bytes"),
      key,
      attachmentAssociatedData({
        userId: "user_a",
        noteId: "note_a",
        attachmentId: "attachment_a",
        formatVersion: 1
      })
    );

    await expect(
      decryptBytes(
        encrypted,
        key,
        attachmentAssociatedData({
          userId: "user_a",
          noteId: "note_b",
          attachmentId: "attachment_a",
          formatVersion: 1
        })
      )
    ).rejects.toThrow();
  });

  it("binds binary CRDT ciphertext to its section and checkpoint cutoff", async () => {
    const key = randomBytes(32);
    const input = {
      cryptoOwnerId: "user_a",
      noteId: "note_a",
      sectionId: "section_a",
      keyEpoch: 2,
      updateId: "checkpoint_a",
      kind: "checkpoint" as const,
      checkpointSequenceCutoff: 12,
      formatVersion: 2
    };
    const encrypted = await encryptBytesV2(
      utf8("section checkpoint"),
      key,
      crdtBinaryAssociatedData(input)
    );

    await expect(
      decryptBytes(
        encrypted,
        key,
        crdtBinaryAssociatedData({ ...input, sectionId: "section_b" })
      )
    ).rejects.toThrow();
    await expect(
      decryptBytes(
        encrypted,
        key,
        crdtBinaryAssociatedData({ ...input, checkpointSequenceCutoff: 13 })
      )
    ).rejects.toThrow();
  });

  it("derives separate recovery auth and vault keys", async () => {
    const secret = generateRecoverySecret();
    const params = createKdfParams();
    const auth = await deriveRecoveryAuthVerifier(secret, params);
    const vault = await deriveRecoveryWrappingKey(secret, params);

    expect(toBase64(auth)).not.toEqual(toBase64(vault));
    expect(fromBase64(toBase64(auth))).toHaveLength(32);
  });

  it("seals bytes to a recipient sharing key", async () => {
    const alice = await createSharingKeyPair();
    const bob = await createSharingKeyPair();
    const sealed = await sealBytes(utf8("shared note key"), bob.publicKey);

    const opened = await openSealedBytes({
      cipher: sealed,
      publicKey: bob.publicKey,
      privateKey: bob.privateKey
    });
    expect(toBase64(opened)).toEqual(toBase64(utf8("shared note key")));

    await expect(
      openSealedBytes({
        cipher: sealed,
        publicKey: alice.publicKey,
        privateKey: alice.privateKey
      })
    ).rejects.toThrow();
  });

  it("reads v1 payloads while new protected writes use v2", async () => {
    const key = randomBytes(32);
    const aad = associatedDataV2("note-title", {
      cryptoOwnerId: "owner-a",
      keyEpoch: 2,
      noteId: "note-a",
      rootVersion: 7
    });
    const legacy = await encryptBytes(utf8("legacy"), key, aad);
    const current = await encryptBytesV2(utf8("current"), key, aad);

    expect(legacy.formatVersion).toBe(1);
    expect(current.formatVersion).toBe(2);
    expect(toBase64(await decryptBytes(legacy, key, aad))).toBe(toBase64(utf8("legacy")));
    expect(toBase64(await decryptBytes(current, key, aad))).toBe(
      toBase64(utf8("current"))
    );
  });

  it("rejects protected metadata moved to another context", async () => {
    const key = randomBytes(32);
    const context = {
      cryptoOwnerId: "owner-a",
      keyEpoch: 2,
      noteId: "note-a",
      rootVersion: 7
    };
    const encrypted = await encryptBytesV2(
      utf8("private title"),
      key,
      associatedDataV2("note-title", context)
    );

    await expect(
      decryptBytes(
        encrypted,
        key,
        associatedDataV2("note-title", { ...context, noteId: "note-b" })
      )
    ).rejects.toThrow();
    await expect(
      decryptBytes(encrypted, key, associatedDataV2("attachment-metadata", context))
    ).rejects.toThrow();
  });

  it("requires canonical Base64 and exact XChaCha nonce length", () => {
    const canonical = toBase64(randomBytes(32));
    expect(toBase64(fromCanonicalBase64(canonical))).toBe(canonical);
    expect(() => fromCanonicalBase64(` ${canonical}`)).toThrow("canonical Base64");
    expect(() => fromCanonicalBase64(canonical.replace(/=+$/, ""))).toThrow(
      "canonical Base64"
    );
    expect(() =>
      validateEncryptedPayload({
        cipher: toBase64(randomBytes(16)),
        nonce: toBase64(randomBytes(23)),
        formatVersion: 2
      })
    ).toThrow("nonce");
  });

  it("binds every chunk coordinate and total into its AAD", async () => {
    const key = randomBytes(32);
    const input = {
      cryptoOwnerId: "owner-a",
      noteId: "note-a",
      sectionId: "section-a",
      keyEpoch: 3,
      updateId: "update-a",
      uploadId: "upload-a",
      chunkIndex: 0,
      chunkCount: 40,
      totalCipherBytes: 10_485_760,
      kind: "checkpoint" as const,
      checkpointSequenceCutoff: 17,
      formatVersion: 2 as const
    };
    const encrypted = await encryptBytesV2(
      utf8("chunk"),
      key,
      contentChunkAssociatedData(input)
    );

    await expect(
      decryptBytes(
        encrypted,
        key,
        contentChunkAssociatedData({ ...input, chunkIndex: 1 })
      )
    ).rejects.toThrow();
    await expect(
      decryptBytes(
        encrypted,
        key,
        contentChunkAssociatedData({ ...input, totalCipherBytes: 10_485_761 })
      )
    ).rejects.toThrow();
    await expect(
      decryptBytes(
        encrypted,
        key,
        contentChunkAssociatedData({ ...input, checkpointSequenceCutoff: 18 })
      )
    ).rejects.toThrow();
  });

  it("binds a backward epoch link to adjacent source and target epochs", async () => {
    const key = randomBytes(32);
    const input = {
      cryptoOwnerId: "owner-a",
      noteId: "note-a",
      sourceEpoch: 3,
      targetEpoch: 4,
      formatVersion: 2 as const
    };
    const encrypted = await encryptBytesV2(
      randomBytes(32),
      key,
      epochLinkAssociatedData(input)
    );

    await expect(
      decryptBytes(
        encrypted,
        key,
        epochLinkAssociatedData({ ...input, sourceEpoch: 2, targetEpoch: 3 })
      )
    ).rejects.toThrow();
    expect(() => epochLinkAssociatedData({ ...input, targetEpoch: 5 })).toThrow(
      "adjacent"
    );
  });
});
