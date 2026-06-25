import { describe, expect, it } from "vitest";
import {
  attachmentAssociatedData,
  createKdfParams,
  decryptBytes,
  deriveAuthVerifier,
  deriveRecoveryAuthVerifier,
  deriveRecoveryWrappingKey,
  deriveVaultWrappingKey,
  encryptBytes,
  fromBase64,
  generateRecoverySecret,
  noteAssociatedData,
  randomBytes,
  toBase64,
  utf8
} from "./crypto.js";

describe("crypto helpers", () => {
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

  it("derives separate recovery auth and vault keys", async () => {
    const secret = generateRecoverySecret();
    const params = createKdfParams();
    const auth = await deriveRecoveryAuthVerifier(secret, params);
    const vault = await deriveRecoveryWrappingKey(secret, params);

    expect(toBase64(auth)).not.toEqual(toBase64(vault));
    expect(fromBase64(toBase64(auth))).toHaveLength(32);
  });
});
