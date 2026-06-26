import { describe, expect, it } from "vitest";
import {
  createAccountRecoveryCrypto,
  createEncryptedNoteDraft,
  createLoginAuthVerifier,
  createRegistrationCrypto,
  decryptNote,
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
});
