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
import {
  decryptContentChunksV2,
  type EncryptedContentChunkV2,
  type PreparedEncryptedContentV2
} from "../cryptoClient";
import {
  IndexedDbCapacityError,
  type EncryptedContentTransferRecord,
  type FortnoteIndexedDb
} from "../lib/indexedDb";

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

export async function downloadVerifiedContent(input: {
  manifest: ContentManifestSummary;
  cryptoOwnerId: string;
  noteKey: Uint8Array;
  api?: ContentTransferApi;
  signal?: AbortSignal;
  onProgress?: (progress: ContentTransferProgress) => void;
}): Promise<Uint8Array> {
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

async function persistPreparedTransfer(
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
