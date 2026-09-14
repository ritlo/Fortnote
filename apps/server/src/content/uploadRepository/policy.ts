import type { StorageQuotaStatus } from "../quota.js";
import type {
  BeginContentUploadInput,
  BeginContentUploadOutcome,
  ContentChunkRecord,
  ContentUploadRecord,
  ContentUploadStatus,
  RegisterContentChunkInput
} from "./contracts.js";

export interface UploadAccess {
  ownerUserId: string;
  cryptoOwnerId: string;
  keyEpoch: number;
  rotationFenced: boolean;
  isDeleted: boolean;
  role: string;
  status: string;
}

export function beginUploadGate(
  access: UploadAccess | null,
  input: BeginContentUploadInput
): Exclude<BeginContentUploadOutcome, { kind: "created" | "existing" }> | null {
  if (!canEditUpload(access)) {
    return { kind: "not-found" };
  }
  if (access.isDeleted) {
    return { kind: "conflict" };
  }
  if (access.rotationFenced) {
    return { kind: "rotation-pending" };
  }
  return access.keyEpoch === input.expectedKeyEpoch
    ? null
    : { kind: "stale-epoch" };
}

export function canEditUpload(access: UploadAccess | null): access is UploadAccess {
  return access?.status === "active" &&
    (access.role === "owner" || access.role === "editor");
}

export function isSameContentChunk(
  chunk: ContentChunkRecord,
  input: RegisterContentChunkInput
): boolean {
  return chunk.cipherLength === input.cipherLength &&
    chunk.cipherHash === input.cipherHash &&
    chunk.nonce.equals(input.nonce);
}

export function isSameContentUpload(
  upload: ContentUploadRecord,
  input: BeginContentUploadInput,
  sectionId: string
): boolean {
  return upload.id === input.uploadId &&
    upload.updateId === input.updateId &&
    upload.noteId === input.noteId &&
    upload.sectionId === sectionId &&
    upload.keyEpoch === input.expectedKeyEpoch &&
    upload.kind === input.kind &&
    upload.formatVersion === input.formatVersion &&
    upload.totalCipherBytes === input.totalCipherBytes &&
    upload.chunkCount === input.chunkCount &&
    upload.manifestHash === input.manifestHash &&
    upload.checkpointSequenceCutoff === (input.checkpointSequenceCutoff ?? null);
}

export function contentQuotaStatus(
  row: { usedBytes: number; reservedBytes: number } | undefined,
  quotaBytes: number
): StorageQuotaStatus {
  const usedBytes = row?.usedBytes ?? 0;
  const reservedBytes = row?.reservedBytes ?? 0;
  return {
    usedBytes,
    reservedBytes,
    quotaBytes,
    availableBytes: Math.max(quotaBytes - usedBytes - reservedBytes, 0)
  };
}

export function uploadReservesStorage(status: ContentUploadStatus): boolean {
  return status === "receiving" || status === "complete" || status === "invalid";
}
