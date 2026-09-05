import {
  contentChunkAssociatedData,
  decryptBytes,
  encryptBytesV2,
  fromBase64,
  randomUuid,
  sha256,
  toBase64,
  utf8,
  type EncryptedPayload
} from "@fortnote/shared";

export const CONTENT_CHUNK_AUTH_BYTES = 16;
export const DEFAULT_CONTENT_CIPHER_CHUNK_BYTES = 256 * 1024;

type ProtectedEnvelopeV2 = EncryptedPayload & { formatVersion: 2 };

export interface EncryptedContentChunkV2 {
  chunkIndex: number;
  cipherBytes: Uint8Array;
  cipherHash: string;
  nonce: string;
}

export interface PreparedEncryptedContentV2 {
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  uploadId: string;
  requestId: string;
  kind: "update" | "checkpoint" | "root-update";
  formatVersion: 2;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
  checkpointSequenceCutoff?: number;
  chunks: EncryptedContentChunkV2[];
}

export function encryptContentChunkV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  uploadId: string;
  chunkIndex: number;
  chunkCount: number;
  totalCipherBytes: number;
  kind: "update" | "checkpoint" | "root-update";
  checkpointSequenceCutoff?: number;
  noteKey: Uint8Array;
  plaintext: Uint8Array;
}): Promise<ProtectedEnvelopeV2> {
  return encryptBytesV2(
    input.plaintext,
    input.noteKey,
    contentChunkAssociatedData({ ...contentChunkContext(input), formatVersion: 2 })
  ).then(requireV2);
}

export function decryptContentChunkV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  uploadId: string;
  chunkIndex: number;
  chunkCount: number;
  totalCipherBytes: number;
  kind: "update" | "checkpoint" | "root-update";
  checkpointSequenceCutoff?: number;
  noteKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<Uint8Array> {
  requireV2(input.envelope);
  return decryptBytes(
    input.envelope,
    input.noteKey,
    contentChunkAssociatedData({ ...contentChunkContext(input), formatVersion: 2 })
  );
}

export async function encryptContentChunksV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId?: string;
  uploadId?: string;
  requestId?: string;
  kind: "update" | "checkpoint" | "root-update";
  checkpointSequenceCutoff?: number;
  noteKey: Uint8Array;
  plaintext: Uint8Array;
  maxCipherChunkBytes?: number;
}): Promise<PreparedEncryptedContentV2> {
  const maxCipherChunkBytes =
    input.maxCipherChunkBytes ?? DEFAULT_CONTENT_CIPHER_CHUNK_BYTES;
  if (
    !Number.isSafeInteger(maxCipherChunkBytes) ||
    maxCipherChunkBytes <= CONTENT_CHUNK_AUTH_BYTES
  ) {
    throw new Error("Invalid encrypted content chunk limit");
  }
  if (
    (input.kind === "checkpoint") !==
    (input.checkpointSequenceCutoff !== undefined)
  ) {
    throw new Error("Invalid checkpoint sequence cutoff");
  }
  const plaintextChunkBytes = maxCipherChunkBytes - CONTENT_CHUNK_AUTH_BYTES;
  const chunkCount = Math.max(1, Math.ceil(input.plaintext.byteLength / plaintextChunkBytes));
  if (chunkCount > 1_000_000) {
    throw new Error("Encrypted content requires too many chunks");
  }
  const totalCipherBytes =
    input.plaintext.byteLength + chunkCount * CONTENT_CHUNK_AUTH_BYTES;
  const updateId = input.updateId ?? randomUuid();
  const uploadId = input.uploadId ?? randomUuid();
  const requestId = input.requestId ?? randomUuid();
  const chunks: EncryptedContentChunkV2[] = [];

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * plaintextChunkBytes;
    const plaintext = input.plaintext.slice(
      start,
      Math.min(start + plaintextChunkBytes, input.plaintext.byteLength)
    );
    const envelope = await encryptContentChunkV2({
      cryptoOwnerId: input.cryptoOwnerId,
      noteId: input.noteId,
      sectionId: input.sectionId,
      keyEpoch: input.keyEpoch,
      updateId,
      uploadId,
      chunkIndex,
      chunkCount,
      totalCipherBytes,
      kind: input.kind,
      ...(input.checkpointSequenceCutoff === undefined
        ? {}
        : { checkpointSequenceCutoff: input.checkpointSequenceCutoff }),
      noteKey: input.noteKey,
      plaintext
    });
    const cipherBytes = fromBase64(envelope.cipher);
    if (cipherBytes.byteLength > maxCipherChunkBytes) {
      throw new Error("Encrypted content chunk exceeds the configured limit");
    }
    chunks.push({
      chunkIndex,
      cipherBytes,
      cipherHash: await sha256Hex(cipherBytes),
      nonce: envelope.nonce
    });
  }

  return {
    cryptoOwnerId: input.cryptoOwnerId,
    noteId: input.noteId,
    sectionId: input.sectionId,
    keyEpoch: input.keyEpoch,
    updateId,
    uploadId,
    requestId,
    kind: input.kind,
    formatVersion: 2,
    totalCipherBytes,
    chunkCount,
    manifestHash: await contentManifestHashV2(chunks),
    ...(input.checkpointSequenceCutoff === undefined
      ? {}
      : { checkpointSequenceCutoff: input.checkpointSequenceCutoff }),
    chunks
  };
}

export async function decryptContentChunksV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  uploadId: string;
  kind: "update" | "checkpoint" | "root-update";
  checkpointSequenceCutoff?: number;
  noteKey: Uint8Array;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
  chunks: EncryptedContentChunkV2[];
}): Promise<Uint8Array> {
  const chunks = [...input.chunks].sort(
    (left, right) => left.chunkIndex - right.chunkIndex
  );
  if (
    chunks.length !== input.chunkCount ||
    chunks.some((chunk, index) => chunk.chunkIndex !== index) ||
    chunks.reduce((total, chunk) => total + chunk.cipherBytes.byteLength, 0) !==
      input.totalCipherBytes
  ) {
    throw new Error("Encrypted content chunk set is incomplete");
  }
  for (const chunk of chunks) {
    if ((await sha256Hex(chunk.cipherBytes)) !== chunk.cipherHash) {
      throw new Error("Encrypted content chunk hash mismatch");
    }
  }
  if ((await contentManifestHashV2(chunks)) !== input.manifestHash) {
    throw new Error("Encrypted content manifest mismatch");
  }

  const plaintextBytes = input.totalCipherBytes -
    input.chunkCount * CONTENT_CHUNK_AUTH_BYTES;
  if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0) {
    throw new Error("Invalid encrypted content length");
  }
  const plaintext = new Uint8Array(plaintextBytes);
  let offset = 0;
  for (const chunk of chunks) {
    const opened = await decryptContentChunkV2({
      cryptoOwnerId: input.cryptoOwnerId,
      noteId: input.noteId,
      sectionId: input.sectionId,
      keyEpoch: input.keyEpoch,
      updateId: input.updateId,
      uploadId: input.uploadId,
      chunkIndex: chunk.chunkIndex,
      chunkCount: input.chunkCount,
      totalCipherBytes: input.totalCipherBytes,
      kind: input.kind,
      ...(input.checkpointSequenceCutoff === undefined
        ? {}
        : { checkpointSequenceCutoff: input.checkpointSequenceCutoff }),
      noteKey: input.noteKey,
      envelope: {
        cipher: toBase64(chunk.cipherBytes),
        nonce: chunk.nonce,
        formatVersion: 2
      }
    });
    plaintext.set(opened, offset);
    offset += opened.byteLength;
  }
  if (offset !== plaintext.byteLength) {
    throw new Error("Decrypted content length mismatch");
  }
  return plaintext;
}

export async function contentManifestHashV2(
  chunks: readonly EncryptedContentChunkV2[]
): Promise<string> {
  const canonical = [...chunks]
    .sort((left, right) => left.chunkIndex - right.chunkIndex)
    .map(
      (chunk) =>
        `${String(chunk.chunkIndex)}:${String(chunk.cipherBytes.byteLength)}:${chunk.cipherHash}:${chunk.nonce}\n`
    )
    .join("");
  return sha256Hex(utf8(canonical));
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await sha256(value);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentChunkContext(input: {
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  uploadId: string;
  chunkIndex: number;
  chunkCount: number;
  totalCipherBytes: number;
  kind: "update" | "checkpoint" | "root-update";
  checkpointSequenceCutoff?: number;
}) {
  return {
    cryptoOwnerId: input.cryptoOwnerId,
    noteId: input.noteId,
    sectionId: input.sectionId,
    keyEpoch: input.keyEpoch,
    updateId: input.updateId,
    uploadId: input.uploadId,
    chunkIndex: input.chunkIndex,
    chunkCount: input.chunkCount,
    totalCipherBytes: input.totalCipherBytes,
    kind: input.kind,
    ...(input.checkpointSequenceCutoff === undefined
      ? {}
      : { checkpointSequenceCutoff: input.checkpointSequenceCutoff })
  } satisfies {
    cryptoOwnerId: string;
    noteId: string;
    sectionId: string;
    keyEpoch: number;
    updateId: string;
    uploadId: string;
    chunkIndex: number;
    chunkCount: number;
    totalCipherBytes: number;
    kind: "update" | "checkpoint" | "root-update";
    checkpointSequenceCutoff?: number;
  };
}

function requireV2(envelope: EncryptedPayload): ProtectedEnvelopeV2 {
  if (envelope.formatVersion !== 2) {
    throw new Error("Protected envelope downgrade rejected");
  }
  return envelope as ProtectedEnvelopeV2;
}
