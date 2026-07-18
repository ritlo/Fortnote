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

export type ProtectedContextValue = string | number | boolean;

export type ContentKind = "update" | "checkpoint" | "root-update";

export interface SharingKeyPair {
  publicKey: string;
  privateKey: string;
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

export function fromCanonicalBase64(value: string): Uint8Array {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error("Expected canonical Base64");
  }
  let decoded: Uint8Array;
  try {
    decoded = fromBase64(value);
  } catch {
    throw new Error("Expected canonical Base64");
  }
  if (toBase64(decoded) !== value) {
    throw new Error("Expected canonical Base64");
  }
  return decoded;
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
  return encryptBytesWithFormat(plaintext, key, associatedData, 1);
}

export async function encryptBytesV2(
  plaintext: Uint8Array,
  key: Uint8Array,
  associatedData: Uint8Array
): Promise<EncryptedPayload> {
  return encryptBytesWithFormat(plaintext, key, associatedData, 2);
}

async function encryptBytesWithFormat(
  plaintext: Uint8Array,
  key: Uint8Array,
  associatedData: Uint8Array,
  formatVersion: 1 | 2
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
    formatVersion
  };
}

export async function decryptBytes(
  payload: EncryptedPayload,
  key: Uint8Array,
  associatedData: Uint8Array
): Promise<Uint8Array> {
  await cryptoReady();
  const validated = validateEncryptedPayload(payload);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    validated.cipher,
    associatedData,
    validated.nonce,
    key
  );
}

export function validateEncryptedPayload(payload: EncryptedPayload): {
  cipher: Uint8Array;
  nonce: Uint8Array;
} {
  if (payload.formatVersion !== 1 && payload.formatVersion !== 2) {
    throw new Error("Unsupported encrypted payload format");
  }
  const cipher = fromCanonicalBase64(payload.cipher);
  if (cipher.length === 0) {
    throw new Error("Encrypted payload cipher is empty");
  }
  const nonce = fromCanonicalBase64(payload.nonce);
  if (nonce.length !== XCHACHA_NONCE_BYTES) {
    throw new Error("Invalid XChaCha nonce length");
  }
  return { cipher, nonce };
}

export async function createSharingKeyPair(): Promise<SharingKeyPair> {
  await cryptoReady();
  const keyPair = sodium.crypto_box_keypair();
  return {
    publicKey: toBase64(keyPair.publicKey),
    privateKey: toBase64(keyPair.privateKey)
  };
}

export async function sealBytes(
  plaintext: Uint8Array,
  publicKey: string
): Promise<string> {
  await cryptoReady();
  return toBase64(sodium.crypto_box_seal(plaintext, fromBase64(publicKey)));
}

export async function openSealedBytes(input: {
  cipher: string;
  publicKey: string;
  privateKey: string;
}): Promise<Uint8Array> {
  await cryptoReady();
  return sodium.crypto_box_seal_open(
    fromBase64(input.cipher),
    fromBase64(input.publicKey),
    fromBase64(input.privateKey)
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

export function associatedDataV2(
  purpose: string,
  context: Readonly<Record<string, ProtectedContextValue>>
): Uint8Array {
  if (!purpose) {
    throw new Error("Crypto purpose is required");
  }
  const entries = Object.entries(context)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!key || (typeof value === "number" && !Number.isSafeInteger(value))) {
        throw new Error("Invalid crypto context");
      }
      return [key, typeof value, value] as const;
    });
  return utf8(JSON.stringify(["fortnote", purpose, 2, entries]));
}

export function contentChunkAssociatedData(input: {
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  uploadId: string;
  chunkIndex: number;
  chunkCount: number;
  totalCipherBytes: number;
  kind: ContentKind;
  formatVersion: number;
}): Uint8Array {
  if (
    input.formatVersion !== 2 ||
    !Number.isSafeInteger(input.chunkIndex) ||
    input.chunkIndex < 0 ||
    !Number.isSafeInteger(input.chunkCount) ||
    input.chunkCount <= 0 ||
    input.chunkIndex >= input.chunkCount ||
    !Number.isSafeInteger(input.totalCipherBytes) ||
    input.totalCipherBytes <= 0
  ) {
    throw new Error("Invalid content chunk context");
  }
  return associatedDataV2("content-chunk", input);
}

export function epochLinkAssociatedData(input: {
  cryptoOwnerId: string;
  noteId: string;
  sourceEpoch: number;
  targetEpoch: number;
  formatVersion: number;
}): Uint8Array {
  if (
    input.formatVersion !== 2 ||
    !Number.isSafeInteger(input.sourceEpoch) ||
    !Number.isSafeInteger(input.targetEpoch) ||
    input.sourceEpoch <= 0 ||
    input.targetEpoch !== input.sourceEpoch + 1
  ) {
    throw new Error("Epoch link must bind adjacent source and target epochs");
  }
  return associatedDataV2("note-epoch-link", input);
}

export function generateRecoverySecret(): string {
  return randomBase64(32);
}
