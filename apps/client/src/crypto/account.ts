import {
  createKdfParams,
  cryptoReady,
  deriveAuthVerifier,
  deriveRecoveryAuthVerifier,
  deriveRecoveryWrappingKey,
  deriveVaultWrappingKey,
  generateRecoverySecret,
  randomBytes,
  randomUuid,
  toBase64,
  type KdfParams
} from "@fortnote/shared";
import type { RegisterPayload } from "../api/contracts";
import { decryptRootKeyEnvelopeV2, encryptRootKeyEnvelopeV2 } from "./protected";

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

/** Binds a root key envelope to its account and key material version. */
export interface RootKeyContext {
  userId: string;
  keyMaterialVersion: number;
}

export interface PasswordChangeCrypto {
  authVerifier: string;
  authKdf: KdfParams;
  vaultKdf: KdfParams;
  encryptedRootKey: string;
  rootKeyNonce: string;
  rootKeyFormatVersion: 2;
  rootKeyContextVersion: number;
}

export interface RecoveryRotationCrypto {
  recoverySecret: string;
  recoveryAuthVerifier: string;
  recoveryKdf: KdfParams;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryRootKeyFormatVersion: 2;
  recoveryRootKeyContextVersion: number;
}

export interface AccountRecoveryCrypto {
  rootKey: Uint8Array;
  recoveryAuthVerifier: string;
  passwordChange: PasswordChangeCrypto;
}

const INITIAL_KEY_MATERIAL_VERSION = 1;

export async function createRegistrationCrypto(
  username: string,
  password: string
): Promise<RegistrationCrypto> {
  await cryptoReady();
  const userId = randomUuid();
  const authKdf = createKdfParams();
  const vaultKdf = createKdfParams();
  const recoveryKdf = createKdfParams();
  const rootKey = randomBytes(32);
  const recoverySecret = generateRecoverySecret();
  const context = { userId, keyMaterialVersion: INITIAL_KEY_MATERIAL_VERSION };

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
  const encryptedRoot = await encryptRootKeyEnvelopeV2({
    ...context,
    rootKey,
    wrappingKey: vaultKey
  });
  const recoveryEncryptedRoot = await encryptRootKeyEnvelopeV2({
    ...context,
    rootKey,
    wrappingKey: recoveryWrappingKey
  });

  return {
    rootKey,
    vaultKey,
    recoverySecret,
    payload: {
      id: userId,
      username,
      authVerifier: toBase64(authVerifier),
      authKdf,
      vaultKdf,
      encryptedRootKey: encryptedRoot.cipher,
      rootKeyNonce: encryptedRoot.nonce,
      rootKeyFormatVersion: 2,
      recoveryAuthVerifier: toBase64(recoveryAuthVerifier),
      recoveryKdf,
      recoveryEncryptedRootKey: recoveryEncryptedRoot.cipher,
      recoveryRootKeyNonce: recoveryEncryptedRoot.nonce,
      recoveryRootKeyFormatVersion: 2
    }
  };
}

export async function openVault(input: {
  password: string;
  authKdf: KdfParams;
  vaultKdf: KdfParams;
  encryptedRootKey: string;
  rootKeyNonce: string;
  rootKeyFormatVersion: number;
  context: RootKeyContext;
}): Promise<OpenedVault> {
  const authVerifier = await deriveAuthVerifier(input.password, input.authKdf);
  const vaultKey = await deriveVaultWrappingKey(input.password, input.vaultKdf);
  const rootKey = await decryptRootKeyEnvelopeV2({
    ...input.context,
    wrappingKey: vaultKey,
    envelope: {
      cipher: input.encryptedRootKey,
      nonce: input.rootKeyNonce,
      formatVersion: input.rootKeyFormatVersion
    }
  });

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
  context: RootKeyContext
): Promise<PasswordChangeCrypto> {
  await cryptoReady();
  const authKdf = createKdfParams();
  const vaultKdf = createKdfParams();
  const authVerifier = await deriveAuthVerifier(newPassword, authKdf);
  const vaultKey = await deriveVaultWrappingKey(newPassword, vaultKdf);
  const encryptedRoot = await encryptRootKeyEnvelopeV2({
    ...context,
    rootKey,
    wrappingKey: vaultKey
  });

  return {
    authVerifier: toBase64(authVerifier),
    authKdf,
    vaultKdf,
    encryptedRootKey: encryptedRoot.cipher,
    rootKeyNonce: encryptedRoot.nonce,
    rootKeyFormatVersion: 2,
    rootKeyContextVersion: context.keyMaterialVersion
  };
}

export async function createRecoveryRotationCrypto(
  rootKey: Uint8Array,
  context: RootKeyContext
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
  const recoveryEncryptedRoot = await encryptRootKeyEnvelopeV2({
    ...context,
    rootKey,
    wrappingKey: recoveryWrappingKey
  });

  return {
    recoverySecret,
    recoveryAuthVerifier: toBase64(recoveryAuthVerifier),
    recoveryKdf,
    recoveryEncryptedRootKey: recoveryEncryptedRoot.cipher,
    recoveryRootKeyNonce: recoveryEncryptedRoot.nonce,
    recoveryRootKeyFormatVersion: 2,
    recoveryRootKeyContextVersion: context.keyMaterialVersion
  };
}

export async function createAccountRecoveryCrypto(input: {
  userId: string;
  recoverySecret: string;
  recoveryKdf: KdfParams;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryRootKeyFormatVersion: number;
  recoveryRootKeyContextVersion: number;
  nextKeyMaterialVersion: number;
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
  const rootKey = await decryptRootKeyEnvelopeV2({
    userId: input.userId,
    keyMaterialVersion: input.recoveryRootKeyContextVersion,
    wrappingKey: recoveryWrappingKey,
    envelope: {
      cipher: input.recoveryEncryptedRootKey,
      nonce: input.recoveryRootKeyNonce,
      formatVersion: input.recoveryRootKeyFormatVersion
    }
  });

  return {
    rootKey,
    recoveryAuthVerifier: toBase64(recoveryAuthVerifier),
    passwordChange: await createPasswordChangeCrypto(rootKey, input.newPassword, {
      userId: input.userId,
      keyMaterialVersion: input.nextKeyMaterialVersion
    })
  };
}
