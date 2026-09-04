import {
  createKdfParams,
  cryptoReady,
  decryptBytes,
  deriveAuthVerifier,
  deriveRecoveryAuthVerifier,
  deriveRecoveryWrappingKey,
  deriveVaultWrappingKey,
  encryptBytes,
  generateRecoverySecret,
  randomBytes,
  toBase64,
  utf8,
  type KdfParams
} from "@fortnote/shared";
import type { RegisterPayload } from "../api/contracts";
import {
  decryptRootKeyEnvelopeV2,
  encryptRootKeyEnvelopeV2
} from "./protected";

const ROOT_KEY_AAD = utf8("fortnote:root-key:v1");

export interface RegistrationCrypto {
  payload: RegisterPayload;
  rootKey: Uint8Array;
  vaultKey: Uint8Array;
  recoverySecret: string;
}

export interface OpenedVault {
  authVerifier: string;
  vaultKey: Uint8Array;
  rootKey: Uint8Array;
}

export interface PasswordChangeCrypto {
  authVerifier: string;
  authKdf: KdfParams;
  vaultKdf: KdfParams;
  encryptedRootKey: string;
  rootKeyNonce: string;
  rootKeyFormatVersion: 1 | 2;
  rootKeyContextVersion: number;
}

export interface RecoveryRotationCrypto {
  recoverySecret: string;
  recoveryAuthVerifier: string;
  recoveryKdf: KdfParams;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryRootKeyFormatVersion: 1 | 2;
  recoveryRootKeyContextVersion: number;
}

export interface AccountRecoveryCrypto {
  rootKey: Uint8Array;
  recoveryAuthVerifier: string;
  passwordChange: PasswordChangeCrypto;
}

export async function createRegistrationCrypto(
  username: string,
  password: string
): Promise<RegistrationCrypto> {
  await cryptoReady();
  const authKdf = createKdfParams();
  const vaultKdf = createKdfParams();
  const recoveryKdf = createKdfParams();
  const rootKey = randomBytes(32);
  const recoverySecret = generateRecoverySecret();

  const authVerifier = await deriveAuthVerifier(password, authKdf);
  const vaultKey = await deriveVaultWrappingKey(password, vaultKdf);
  const recoveryAuthVerifier = await deriveRecoveryAuthVerifier(
    recoverySecret,
    recoveryKdf
  );
  const recoveryWrappingKey = await deriveRecoveryWrappingKey(
    recoverySecret,
    recoveryKdf
  );
  const encryptedRoot = await encryptBytes(rootKey, vaultKey, ROOT_KEY_AAD);
  const recoveryEncryptedRoot = await encryptBytes(
    rootKey,
    recoveryWrappingKey,
    ROOT_KEY_AAD
  );

  return {
    rootKey,
    vaultKey,
    recoverySecret,
    payload: {
      username,
      authVerifier: toBase64(authVerifier),
      authKdf,
      vaultKdf,
      encryptedRootKey: encryptedRoot.cipher,
      rootKeyNonce: encryptedRoot.nonce,
      recoveryAuthVerifier: toBase64(recoveryAuthVerifier),
      recoveryKdf,
      recoveryEncryptedRootKey: recoveryEncryptedRoot.cipher,
      recoveryRootKeyNonce: recoveryEncryptedRoot.nonce
    }
  };
}

export async function openVault(
  password: string,
  authKdf: KdfParams,
  vaultKdf: KdfParams,
  encryptedRootKey: string,
  rootKeyNonce: string,
  context?: {
    userId: string;
    formatVersion: number;
    contextVersion: number;
  }
): Promise<OpenedVault> {
  const authVerifier = await deriveAuthVerifier(password, authKdf);
  const vaultKey = await deriveVaultWrappingKey(password, vaultKdf);
  const envelope = {
    cipher: encryptedRootKey,
    nonce: rootKeyNonce,
    formatVersion: context?.formatVersion ?? 1
  };
  const rootKey = context?.formatVersion === 2
    ? await decryptRootKeyEnvelopeV2({
        userId: context.userId,
        keyMaterialVersion: context.contextVersion,
        wrappingKey: vaultKey,
        envelope
      })
    : await decryptBytes(envelope, vaultKey, ROOT_KEY_AAD);

  return {
    authVerifier: toBase64(authVerifier),
    vaultKey,
    rootKey
  };
}

export async function createLoginAuthVerifier(
  password: string,
  authKdf: KdfParams
): Promise<string> {
  return toBase64(await deriveAuthVerifier(password, authKdf));
}

export async function createPasswordChangeCrypto(
  rootKey: Uint8Array,
  newPassword: string,
  context?: { userId: string; keyMaterialVersion: number }
): Promise<PasswordChangeCrypto> {
  await cryptoReady();
  const authKdf = createKdfParams();
  const vaultKdf = createKdfParams();
  const authVerifier = await deriveAuthVerifier(newPassword, authKdf);
  const vaultKey = await deriveVaultWrappingKey(newPassword, vaultKdf);
  const encryptedRoot = context
    ? await encryptRootKeyEnvelopeV2({
        userId: context.userId,
        keyMaterialVersion: context.keyMaterialVersion,
        rootKey,
        wrappingKey: vaultKey
      })
    : await encryptBytes(rootKey, vaultKey, ROOT_KEY_AAD);

  return {
    authVerifier: toBase64(authVerifier),
    authKdf,
    vaultKdf,
    encryptedRootKey: encryptedRoot.cipher,
    rootKeyNonce: encryptedRoot.nonce,
    rootKeyFormatVersion: context ? 2 : 1,
    rootKeyContextVersion: context?.keyMaterialVersion ?? 1
  };
}

export async function createRecoveryRotationCrypto(
  rootKey: Uint8Array,
  context?: { userId: string; keyMaterialVersion: number }
): Promise<RecoveryRotationCrypto> {
  await cryptoReady();
  const recoverySecret = generateRecoverySecret();
  const recoveryKdf = createKdfParams();
  const recoveryAuthVerifier = await deriveRecoveryAuthVerifier(
    recoverySecret,
    recoveryKdf
  );
  const recoveryWrappingKey = await deriveRecoveryWrappingKey(
    recoverySecret,
    recoveryKdf
  );
  const recoveryEncryptedRoot = context
    ? await encryptRootKeyEnvelopeV2({
        userId: context.userId,
        keyMaterialVersion: context.keyMaterialVersion,
        rootKey,
        wrappingKey: recoveryWrappingKey
      })
    : await encryptBytes(rootKey, recoveryWrappingKey, ROOT_KEY_AAD);

  return {
    recoverySecret,
    recoveryAuthVerifier: toBase64(recoveryAuthVerifier),
    recoveryKdf,
    recoveryEncryptedRootKey: recoveryEncryptedRoot.cipher,
    recoveryRootKeyNonce: recoveryEncryptedRoot.nonce,
    recoveryRootKeyFormatVersion: context ? 2 : 1,
    recoveryRootKeyContextVersion: context?.keyMaterialVersion ?? 1
  };
}

export async function createAccountRecoveryCrypto(input: {
  recoverySecret: string;
  recoveryKdf: KdfParams;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryRootKeyFormatVersion?: number;
  recoveryRootKeyContextVersion?: number;
  userId?: string;
  nextKeyMaterialVersion?: number;
  newPassword: string;
}): Promise<AccountRecoveryCrypto> {
  const recoveryAuthVerifier = await deriveRecoveryAuthVerifier(
    input.recoverySecret,
    input.recoveryKdf
  );
  const recoveryWrappingKey = await deriveRecoveryWrappingKey(
    input.recoverySecret,
    input.recoveryKdf
  );
  const recoveryEnvelope = {
    cipher: input.recoveryEncryptedRootKey,
    nonce: input.recoveryRootKeyNonce,
    formatVersion: input.recoveryRootKeyFormatVersion ?? 1
  };
  const rootKey = input.recoveryRootKeyFormatVersion === 2
    ? await decryptRootKeyEnvelopeV2({
        userId: requireEnvelopeUserId(input.userId),
        keyMaterialVersion: requireKeyMaterialVersion(
          input.recoveryRootKeyContextVersion
        ),
        wrappingKey: recoveryWrappingKey,
        envelope: recoveryEnvelope
      })
    : await decryptBytes(recoveryEnvelope, recoveryWrappingKey, ROOT_KEY_AAD);

  return {
    rootKey,
    recoveryAuthVerifier: toBase64(recoveryAuthVerifier),
    passwordChange: await createPasswordChangeCrypto(
      rootKey,
      input.newPassword,
      input.userId && input.nextKeyMaterialVersion
        ? {
            userId: input.userId,
            keyMaterialVersion: input.nextKeyMaterialVersion
          }
        : undefined
    )
  };
}

function requireEnvelopeUserId(userId: string | undefined): string {
  if (!userId) {
    throw new Error("Protected sharing key account context is missing");
  }
  return userId;
}

function requireKeyMaterialVersion(version: number | undefined): number {
  if (!version) {
    throw new Error("Protected root key material context is missing");
  }
  return version;
}
