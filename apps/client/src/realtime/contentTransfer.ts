import {
  abortContentUpload,
  beginContentUpload,
  commitContentManifest,
  downloadContentChunk,
  inspectContentUpload,
  isApiRequestError,
  putContentChunk,
  type ContentManifestSummary,
  type ContentUploadBeginPayload,
  type ContentUploadStatus,
  type DownloadedContentChunk
} from "../api";
import { fromCanonicalBase64, toBase64 } from "@fortnote/shared";
import {
  decryptContentChunksV2,
  type EncryptedContentChunkV2,
  type PreparedEncryptedContentV2
} from "../cryptoClient";
import {
  IndexedDbCapacityError,
  type EncryptedContentTransferRecord,
  type FortnoteIndexedDb,
  type SectionCacheRecord
} from "../lib/indexedDb";

const DEFAULT_SECTION_CACHE_MAX_ENTRIES = 12;
const DEFAULT_SECTION_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_FORMAT_VERSION = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ContentTransferProgress {
  phase: "uploading" | "downloading" | "verifying";
  completedChunks: number;
  totalChunks: number;
  transferredBytes: number;
  totalBytes: number;
}

export type ContentUploadResult =
  | { kind: "committed"; manifest: ContentManifestSummary }
  | { kind: "local-capacity"; error: IndexedDbCapacityError }
  | { kind: "server-capacity"; error: Error };

export interface ContentTransferApi {
  abortContentUpload: typeof abortContentUpload;
  beginContentUpload: typeof beginContentUpload;
  commitContentManifest: typeof commitContentManifest;
  downloadContentChunk: typeof downloadContentChunk;
  inspectContentUpload: typeof inspectContentUpload;
  putContentChunk: typeof putContentChunk;
}

export interface VerifiedContentDownloadInput {
  manifest: ContentManifestSummary;
  cryptoOwnerId: string;
  noteKey: Uint8Array;
  api?: ContentTransferApi;
  signal?: AbortSignal;
  onProgress?: (progress: ContentTransferProgress) => void;
  cache?: {
    database: FortnoteIndexedDb;
    userId: string;
    maxEntries?: number;
    maxBytes?: number;
  };
}

export async function uploadPreparedContent(input: {
  userId: string;
  database: FortnoteIndexedDb;
  prepared: PreparedEncryptedContentV2;
  api?: ContentTransferApi;
  signal?: AbortSignal;
  onProgress?: (progress: ContentTransferProgress) => void;
}): Promise<ContentUploadResult> {
  try {
    const record = await persistPreparedTransfer(
      input.database,
      input.userId,
      input.prepared
    );
    return await resumeContentUpload({
      database: input.database,
      record,
      ...(input.api ? { api: input.api } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {})
    });
  } catch (error) {
    return capacityOutcome(error);
  }
}

export async function resumeContentUpload(input: {
  database: FortnoteIndexedDb;
  record: EncryptedContentTransferRecord;
  api?: ContentTransferApi;
  signal?: AbortSignal;
  onProgress?: (progress: ContentTransferProgress) => void;
}): Promise<ContentUploadResult> {
  const api = input.api ?? defaultContentTransferApi();
  try {
    throwIfAborted(input.signal);
    await api.beginContentUpload(beginPayload(input.record));
    const status = await api.inspectContentUpload(input.record.uploadId);
    assertResumableStatus(status);
    const received = new Set(status.receivedChunkIndexes);
    await saveProgress(input.database, input.record, received);
    reportUploadProgress(input.record, received, input.onProgress);

    for (const chunk of input.record.chunks) {
      throwIfAborted(input.signal);
      if (received.has(chunk.chunkIndex)) {
        continue;
      }
      await api.putContentChunk(
        input.record.uploadId,
        chunk.chunkIndex,
        chunk.cipherBytes,
        chunk.cipherHash,
        chunk.nonce
      );
      received.add(chunk.chunkIndex);
      await saveProgress(input.database, input.record, received);
      reportUploadProgress(input.record, received, input.onProgress);
      await yieldToBrowser();
    }

    throwIfAborted(input.signal);
    const manifest = await api.commitContentManifest(input.record.uploadId, {
      requestId: input.record.requestId,
      updateId: input.record.updateId,
      expectedKeyEpoch: input.record.keyEpoch
    });
    await input.database.deleteContentTransfer(input.record.userId, input.record.uploadId);
    return { kind: "committed", manifest };
  } catch (error) {
    return capacityOutcome(error);
  }
}

export async function abortPersistedContentUpload(input: {
  userId: string;
  uploadId: string;
  database: FortnoteIndexedDb;
  api?: ContentTransferApi;
}): Promise<void> {
  const api = input.api ?? defaultContentTransferApi();
  await api.abortContentUpload(input.uploadId);
  await input.database.deleteContentTransfer(input.userId, input.uploadId);
}

export async function downloadVerifiedContent(
  input: VerifiedContentDownloadInput
): Promise<Uint8Array> {
  const cached = await readVerifiedCache(input);
  if (cached) {
    return cached;
  }
  const api = input.api ?? defaultContentTransferApi();
  const chunks: EncryptedContentChunkV2[] = [];
  let transferredBytes = 0;
  for (let chunkIndex = 0; chunkIndex < input.manifest.chunkCount; chunkIndex += 1) {
    throwIfAborted(input.signal);
    const downloaded = await api.downloadContentChunk(
      input.manifest.manifestId,
      chunkIndex
    );
    chunks.push(downloadedChunk(chunkIndex, downloaded));
    transferredBytes += downloaded.bytes.byteLength;
    input.onProgress?.({
      phase: "downloading",
      completedChunks: chunkIndex + 1,
      totalChunks: input.manifest.chunkCount,
      transferredBytes,
      totalBytes: input.manifest.totalCipherBytes
    });
    await yieldToBrowser();
  }
  throwIfAborted(input.signal);
  input.onProgress?.({
    phase: "verifying",
    completedChunks: chunks.length,
    totalChunks: input.manifest.chunkCount,
    transferredBytes,
    totalBytes: input.manifest.totalCipherBytes
  });
  const plaintext = await decryptDownloadedChunks(input, chunks);
  await cacheVerifiedChunks(input, chunks);
  return plaintext;
}

function decryptDownloadedChunks(
  input: VerifiedContentDownloadInput,
  chunks: EncryptedContentChunkV2[]
): Promise<Uint8Array> {
  return decryptContentChunksV2({
    cryptoOwnerId: input.cryptoOwnerId,
    noteId: input.manifest.noteId,
    sectionId: input.manifest.sectionId,
    keyEpoch: input.manifest.keyEpoch,
    updateId: input.manifest.updateId,
    uploadId: input.manifest.uploadId,
    kind: input.manifest.kind,
    ...(input.manifest.checkpointSequenceCutoff === undefined
      ? {}
      : { checkpointSequenceCutoff: input.manifest.checkpointSequenceCutoff }),
    noteKey: input.noteKey,
    totalCipherBytes: input.manifest.totalCipherBytes,
    chunkCount: input.manifest.chunkCount,
    manifestHash: input.manifest.manifestHash,
    chunks
  });
}

async function readVerifiedCache(
  input: VerifiedContentDownloadInput
): Promise<Uint8Array | null> {
  if (!input.cache) {
    return null;
  }
  const key = sectionCacheKey(input);
  try {
    const cached = await input.cache.database.getSectionCache(key);
    if (!cached || cached.pending) {
      return null;
    }
    const chunks = decodeCachedChunks(cached.encryptedBytes);
    input.onProgress?.({
      phase: "verifying",
      completedChunks: chunks.length,
      totalChunks: input.manifest.chunkCount,
      transferredBytes: input.manifest.totalCipherBytes,
      totalBytes: input.manifest.totalCipherBytes
    });
    const plaintext = await decryptDownloadedChunks(input, chunks);
    await input.cache.database.putSectionCache({
      ...cached,
      lastAccessedAt: Date.now()
    }).catch(() => undefined);
    return plaintext;
  } catch {
    await input.cache.database.deleteSectionCache(key).catch(() => undefined);
    return null;
  }
}

async function cacheVerifiedChunks(
  input: VerifiedContentDownloadInput,
  chunks: EncryptedContentChunkV2[]
): Promise<void> {
  if (!input.cache) {
    return;
  }
  const maxEntries = input.cache.maxEntries ?? DEFAULT_SECTION_CACHE_MAX_ENTRIES;
  const maxBytes = input.cache.maxBytes ?? DEFAULT_SECTION_CACHE_MAX_BYTES;
  const encryptedBytes = encodeCachedChunks(chunks);
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries <= 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    encryptedBytes.byteLength > maxBytes
  ) {
    return;
  }
  const record: SectionCacheRecord = {
    ...sectionCacheKey(input),
    encryptedBytes,
    lastAccessedAt: Date.now(),
    pending: false
  };
  try {
    await input.cache.database.evictSectionCache(
      input.cache.userId,
      Math.max(0, maxEntries - 1),
      Math.max(0, maxBytes - encryptedBytes.byteLength)
    );
    await input.cache.database.putSectionCache(record);
    await input.cache.database.evictSectionCache(
      input.cache.userId,
      maxEntries,
      maxBytes
    );
  } catch (error) {
    if (!(error instanceof IndexedDbCapacityError)) {
      return;
    }
    await input.cache.database
      .evictSectionCache(
        input.cache.userId,
        Math.max(0, maxEntries - 1),
        Math.max(0, maxBytes - encryptedBytes.byteLength)
      )
      .catch(() => []);
    await input.cache.database.putSectionCache(record).catch(() => undefined);
    await input.cache.database
      .evictSectionCache(input.cache.userId, maxEntries, maxBytes)
      .catch(() => []);
  }
}

function sectionCacheKey(input: VerifiedContentDownloadInput) {
  if (!input.cache) {
    throw new Error("Section cache is unavailable");
  }
  return {
    userId: input.cache.userId,
    noteId: input.manifest.noteId,
    sectionId: input.manifest.sectionId,
    keyEpoch: input.manifest.keyEpoch,
    manifestId: input.manifest.manifestId
  };
}

function encodeCachedChunks(chunks: EncryptedContentChunkV2[]): Uint8Array {
  return textEncoder.encode(JSON.stringify({
    version: CACHE_FORMAT_VERSION,
    chunks: chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      cipherBytes: toBase64(chunk.cipherBytes),
      cipherHash: chunk.cipherHash,
      nonce: chunk.nonce
    }))
  }));
}

function decodeCachedChunks(bytes: Uint8Array): EncryptedContentChunkV2[] {
  const parsed: unknown = JSON.parse(textDecoder.decode(bytes));
  if (
    !isRecord(parsed) ||
    parsed.version !== CACHE_FORMAT_VERSION ||
    !Array.isArray(parsed.chunks)
  ) {
    throw new Error("Invalid encrypted section cache");
  }
  return parsed.chunks.map((value) => {
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value.chunkIndex) ||
      typeof value.cipherBytes !== "string" ||
      typeof value.cipherHash !== "string" ||
      typeof value.nonce !== "string"
    ) {
      throw new Error("Invalid encrypted section cache");
    }
    return {
      chunkIndex: value.chunkIndex as number,
      cipherBytes: fromCanonicalBase64(value.cipherBytes),
      cipherHash: value.cipherHash,
      nonce: value.nonce
    };
  });
}

export async function persistPreparedTransfer(
  database: FortnoteIndexedDb,
  userId: string,
  prepared: PreparedEncryptedContentV2
): Promise<EncryptedContentTransferRecord> {
  const existing = await database.getContentTransfer(userId, prepared.uploadId);
  if (existing) {
    if (
      existing.updateId !== prepared.updateId ||
      existing.manifestHash !== prepared.manifestHash ||
      existing.requestId !== prepared.requestId
    ) {
      throw new Error("Encrypted content upload identity conflict");
    }
    return existing;
  }
  const now = Date.now();
  const record: EncryptedContentTransferRecord = {
    userId,
    cryptoOwnerId: prepared.cryptoOwnerId,
    noteId: prepared.noteId,
    sectionId: prepared.sectionId,
    keyEpoch: prepared.keyEpoch,
    updateId: prepared.updateId,
    uploadId: prepared.uploadId,
    requestId: prepared.requestId,
    kind: prepared.kind,
    formatVersion: 2,
    totalCipherBytes: prepared.totalCipherBytes,
    chunkCount: prepared.chunkCount,
    manifestHash: prepared.manifestHash,
    ...(prepared.checkpointSequenceCutoff === undefined
      ? {}
      : { checkpointSequenceCutoff: prepared.checkpointSequenceCutoff }),
    chunks: prepared.chunks,
    uploadedChunkIndexes: [],
    createdAt: now,
    updatedAt: now
  };
  await database.putContentTransfer(record);
  return record;
}

async function saveProgress(
  database: FortnoteIndexedDb,
  record: EncryptedContentTransferRecord,
  received: ReadonlySet<number>
): Promise<void> {
  record.uploadedChunkIndexes = [...received].sort((left, right) => left - right);
  record.updatedAt = Date.now();
  await database.putContentTransfer(record);
}

function beginPayload(record: EncryptedContentTransferRecord): ContentUploadBeginPayload {
  return {
    uploadId: record.uploadId,
    updateId: record.updateId,
    noteId: record.noteId,
    sectionId: record.sectionId,
    expectedKeyEpoch: record.keyEpoch,
    kind: record.kind,
    formatVersion: 2,
    totalCipherBytes: record.totalCipherBytes,
    chunkCount: record.chunkCount,
    manifestHash: record.manifestHash,
    ...(record.checkpointSequenceCutoff === undefined
      ? {}
      : { checkpointSequenceCutoff: record.checkpointSequenceCutoff })
  };
}

function assertResumableStatus(status: ContentUploadStatus): void {
  if (
    status.status === "aborted" ||
    status.status === "expired" ||
    status.status === "invalid"
  ) {
    throw new Error(`Encrypted content upload is ${status.status}`);
  }
}

function reportUploadProgress(
  record: EncryptedContentTransferRecord,
  received: ReadonlySet<number>,
  onProgress: ((progress: ContentTransferProgress) => void) | undefined
): void {
  if (!onProgress) {
    return;
  }
  const transferredBytes = record.chunks.reduce(
    (total, chunk) =>
      total + (received.has(chunk.chunkIndex) ? chunk.cipherBytes.byteLength : 0),
    0
  );
  onProgress({
    phase: "uploading",
    completedChunks: received.size,
    totalChunks: record.chunkCount,
    transferredBytes,
    totalBytes: record.totalCipherBytes
  });
}

function downloadedChunk(
  chunkIndex: number,
  downloaded: DownloadedContentChunk
): EncryptedContentChunkV2 {
  return {
    chunkIndex,
    cipherBytes: downloaded.bytes,
    cipherHash: downloaded.cipherHash,
    nonce: downloaded.nonce
  };
}

function capacityOutcome(
  error: unknown
): Exclude<ContentUploadResult, { kind: "committed" }> {
  if (error instanceof IndexedDbCapacityError) {
    return { kind: "local-capacity", error };
  }
  if (
    isApiRequestError(error) &&
    (error.code === "storage_limit" || error.code === "quota_exceeded")
  ) {
    return { kind: "server-capacity", error };
  }
  throw error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Content transfer aborted", "AbortError");
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function defaultContentTransferApi(): ContentTransferApi {
  return {
    abortContentUpload,
    beginContentUpload,
    commitContentManifest,
    downloadContentChunk,
    inspectContentUpload,
    putContentChunk
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
