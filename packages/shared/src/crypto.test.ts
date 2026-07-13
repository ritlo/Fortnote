import { beforeAll, describe, expect, it } from "vitest";
import {
  attachmentAssociatedData,
  createKdfParams,
  cryptoReady,
  createSharingKeyPair,
  decryptBytes,
  deriveAuthVerifier,
  deriveRecoveryAuthVerifier,
  deriveRecoveryWrappingKey,
  deriveVaultWrappingKey,
  encryptBytes,
  fromBase64,
  generateRecoverySecret,
  noteAssociatedData,
  openSealedBytes,
  randomBytes,
  sealBytes,
  toBase64,
  utf8
} from "./crypto.js";
import { crdtUpdateAssociatedData } from "./crdt.js";

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

  it("round-trips note ciphertext with associated data", async () => {
    const key = randomBytes(32);
    const aad = noteAssociatedData({
      userId: "user_a",
      noteId: "note_a",
      formatVersion: 1
    });

    const encrypted = await encryptBytes(utf8("private note"), key, aad);
    const decrypted = await decryptBytes(encrypted, key, aad);

    expect(toBase64(decrypted)).toEqual(toBase64(utf8("private note")));
  });

  it("rejects ciphertext moved to another note", async () => {
    const key = randomBytes(32);
    const encrypted = await encryptBytes(
      utf8("private note"),
      key,
      noteAssociatedData({
        userId: "user_a",
        noteId: "note_a",
        formatVersion: 1
      })
    );

    await expect(
      decryptBytes(
        encrypted,
        key,
        noteAssociatedData({
          userId: "user_a",
          noteId: "note_b",
          formatVersion: 1
        })
      )
    ).rejects.toThrow();
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

  it("binds CRDT updates to their note, epoch, owner, and identity", async () => {
    const key = randomBytes(32);
    const input = {
      cryptoOwnerId: "user_a",
      noteId: "note_a",
      keyEpoch: 1,
      updateId: "update_a",
      formatVersion: 1
    };
    const encrypted = await encryptBytes(
      utf8("crdt update"),
      key,
      crdtUpdateAssociatedData(input)
    );

    await expect(
      decryptBytes(
        encrypted,
        key,
        crdtUpdateAssociatedData({ ...input, updateId: "update_b" })
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
});
