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
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function sha256(value: Uint8Array): Promise<Uint8Array> {
  await cryptoReady();
  return sodium.crypto_hash_sha256(value);
}

export async function hkdfSha256(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  await cryptoReady();
  if (!Number.isSafeInteger(length) || length < 0 || length > 255 * 32) {
    throw new Error("Invalid HKDF output length");
  }

  const prk = hmacSha256(inputKeyMaterial, salt.length === 0 ? new Uint8Array(32) : salt);
  const output = new Uint8Array(length);
  let previous = new Uint8Array() as Uint8Array;
  let offset = 0;
  for (let counter = 1; offset < length; counter += 1) {
    const message = new Uint8Array(previous.length + info.length + 1);
    message.set(previous);
    message.set(info, previous.length);
    message[message.length - 1] = counter;
    previous = hmacSha256(message, prk);
    const copied = Math.min(previous.length, length - offset);
    output.set(previous.subarray(0, copied), offset);
    offset += copied;
  }
  return output;
}

function hmacSha256(message: Uint8Array, key: Uint8Array): Uint8Array {
  const block = 64;
  const normalizedKey = key.length > block ? sodium.crypto_hash_sha256(key) : key;
  const paddedKey = new Uint8Array(block);
  paddedKey.set(normalizedKey);
  const innerPad = new Uint8Array(block);
  const outerPad = new Uint8Array(block);
  for (let index = 0; index < block; index += 1) {
    const byte = paddedKey[index] ?? 0;
    innerPad[index] = byte ^ 0x36;
    outerPad[index] = byte ^ 0x5c;
  }
  return sodium.crypto_hash_sha256(
    concatBytes(outerPad, sodium.crypto_hash_sha256(concatBytes(innerPad, message)))
  );
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
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
  checkpointSequenceCutoff?: number;
  formatVersion: number;
}): Uint8Array {
  const checkpointSequenceCutoff = input.checkpointSequenceCutoff ?? 0;
  if (
    input.formatVersion !== 2 ||
    !Number.isSafeInteger(input.chunkIndex) ||
    input.chunkIndex < 0 ||
    !Number.isSafeInteger(input.chunkCount) ||
    input.chunkCount <= 0 ||
    input.chunkIndex >= input.chunkCount ||
    !Number.isSafeInteger(input.totalCipherBytes) ||
    input.totalCipherBytes <= 0 ||
    !Number.isSafeInteger(checkpointSequenceCutoff) ||
    checkpointSequenceCutoff < 0 ||
    (input.kind === "checkpoint") !== (input.checkpointSequenceCutoff !== undefined)
  ) {
    throw new Error("Invalid content chunk context");
  }
  return associatedDataV2("content-chunk", {
    ...input,
    checkpointSequenceCutoff
  });
}

export function crdtBinaryAssociatedData(input: {
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  kind: ContentKind;
  checkpointSequenceCutoff?: number;
  formatVersion: number;
}): Uint8Array {
  const checkpointSequenceCutoff = input.checkpointSequenceCutoff ?? 0;
  if (
    input.formatVersion !== 2 ||
    !Number.isSafeInteger(input.keyEpoch) ||
    input.keyEpoch <= 0 ||
    !Number.isSafeInteger(checkpointSequenceCutoff) ||
    checkpointSequenceCutoff < 0
  ) {
    throw new Error("Invalid CRDT binary context");
  }
  return associatedDataV2("crdt-binary", {
    cryptoOwnerId: input.cryptoOwnerId,
    noteId: input.noteId,
    sectionId: input.sectionId,
    keyEpoch: input.keyEpoch,
    updateId: input.updateId,
    kind: input.kind,
    checkpointSequenceCutoff,
    formatVersion: input.formatVersion
  });
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
