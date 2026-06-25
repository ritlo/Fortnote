import type { KdfParams, RegisterPayload } from "./api";

function fakeBase64(label: string): string {
  return btoa(`${label}:${crypto.randomUUID()}`);
}

function kdfParams(label: string): KdfParams {
  return {
    salt: fakeBase64(`${label}:salt`),
    opsLimit: 4,
    memLimit: 67108864,
    version: 1
  };
}

export function fakeVerifier(password: string, label: string): string {
  return btoa(`${label}:${password}`);
}

export function createRegisterPayload(
  username: string,
  password: string
): RegisterPayload {
  return {
    username,
    authVerifier: fakeVerifier(password, "auth"),
    authKdf: kdfParams("auth"),
    vaultKdf: kdfParams("vault"),
    encryptedRootKey: fakeBase64("root-key"),
    rootKeyNonce: fakeBase64("root-nonce"),
    recoveryAuthVerifier: fakeBase64("recovery-auth"),
    recoveryKdf: kdfParams("recovery"),
    recoveryEncryptedRootKey: fakeBase64("recovery-root-key"),
    recoveryRootKeyNonce: fakeBase64("recovery-root-nonce")
  };
}
