import sodium from "libsodium-wrappers-sumo";

export const KEY_BYTES = 32;
export const XCHACHA_NONCE_BYTES = 24;

export const DOMAIN_LABELS = {
  auth: "fortnote/auth-verifier/v1",
  vault: "fortnote/vault-wrap/v1",
  recoveryAuth: "fortnote/recovery-auth/v1",
  recoveryVault: "fortnote/recovery-wrap/v1"
} as const;

export const DEFAULT_KDF = {
  opsLimit: 4,
  memLimit: 64 * 1024 * 1024,
  version: 1
} as const;

export interface KdfParams {
  salt: string;
  opsLimit: number;
  memLimit: number;
  version: number;
}

export interface EncryptedPayload {
  cipher: string;
  nonce: string;
  formatVersion: number;
}

export async function cryptoReady(): Promise<void> {
  await sodium.ready;
}

export function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export function fromBase64(value: string): Uint8Array {
  return sodium.from_base64(value, sodium.base64_variants.ORIGINAL);
}

export function utf8(value: string): Uint8Array {
  return sodium.from_string(value);
}

export function randomBytes(length: number): Uint8Array {
  return sodium.randombytes_buf(length);
}

export function randomBase64(length: number): string {
  return toBase64(randomBytes(length));
}

export function randomUuid(): string {
  return crypto.randomUUID();
}

export function createKdfParams(): KdfParams {
  return {
    salt: randomBase64(sodium.crypto_pwhash_SALTBYTES),
    opsLimit: DEFAULT_KDF.opsLimit,
    memLimit: DEFAULT_KDF.memLimit,
    version: DEFAULT_KDF.version
  };
}

export async function deriveKey(
  password: string,
  params: KdfParams,
  domainLabel: string
): Promise<Uint8Array> {
  await cryptoReady();
  const domainSeparatedPassword = `${domainLabel}:${password}`;
  return sodium.crypto_pwhash(
    KEY_BYTES,
    domainSeparatedPassword,
    fromBase64(params.salt),
    params.opsLimit,
    params.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
}

export async function deriveAuthVerifier(
  password: string,
  params: KdfParams
): Promise<Uint8Array> {
  return deriveKey(password, params, DOMAIN_LABELS.auth);
}

export async function deriveVaultWrappingKey(
  password: string,
  params: KdfParams
): Promise<Uint8Array> {
  return deriveKey(password, params, DOMAIN_LABELS.vault);
}

export async function deriveRecoveryAuthVerifier(
  recoverySecret: string,
  params: KdfParams
): Promise<Uint8Array> {
  return deriveKey(recoverySecret, params, DOMAIN_LABELS.recoveryAuth);
}

export async function deriveRecoveryWrappingKey(
  recoverySecret: string,
  params: KdfParams
): Promise<Uint8Array> {
  return deriveKey(recoverySecret, params, DOMAIN_LABELS.recoveryVault);
}

export async function encryptBytes(
  plaintext: Uint8Array,
  key: Uint8Array,
  associatedData: Uint8Array
): Promise<EncryptedPayload> {
  await cryptoReady();
  const nonce = randomBytes(XCHACHA_NONCE_BYTES);
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData,
    null,
    nonce,
    key
  );

  return {
    cipher: toBase64(cipher),
    nonce: toBase64(nonce),
    formatVersion: 1
  };
}

export async function decryptBytes(
  payload: EncryptedPayload,
  key: Uint8Array,
  associatedData: Uint8Array
): Promise<Uint8Array> {
  await cryptoReady();
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromBase64(payload.cipher),
    associatedData,
    fromBase64(payload.nonce),
    key
  );
}

export function noteAssociatedData(input: {
  userId: string;
  noteId: string;
  formatVersion: number;
}): Uint8Array {
  return utf8(
    `note:${String(input.formatVersion)}:${input.userId}:${input.noteId}`
  );
}

export function attachmentAssociatedData(input: {
  userId: string;
  noteId: string;
  attachmentId: string;
  formatVersion: number;
}): Uint8Array {
  return utf8(
    `attachment:${String(input.formatVersion)}:${input.userId}:${input.noteId}:${input.attachmentId}`
  );
}

export function generateRecoverySecret(): string {
  return randomBase64(32);
}
