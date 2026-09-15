import type { ContentKind } from "../manifests.js";
import type { StorageQuotaStatus } from "../quota.js";

export type ContentUploadStatus =
  "receiving" | "complete" | "committed" | "aborted" | "expired" | "invalid";

export interface ContentUploadRecord {
  id: string;
  updateId: string;
  noteId: string;
  sectionId: string;
  cryptoOwnerId: string;
  keyEpoch: number;
  kind: ContentKind;
  formatVersion: number;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
  checkpointSequenceCutoff: number | null;
  status: ContentUploadStatus;
  expiresAt: string;
  ownerUserId: string;
  noteKeyEpoch: number;
  noteIsDeleted: boolean;
  rotationFenced: boolean;
}

export interface ContentChunkRecord {
  chunkIndex: number;
  cipherLength: number;
  cipherHash: string;
  nonce: Buffer;
  storageKey: string;
}

export interface ContentManifestChunkRecord extends ContentChunkRecord {
  noteId: string;
}

export interface ContentUploadView {
  upload: ContentUploadRecord;
  receivedChunkIndexes: number[];
  cleanupStorageKeys: string[];
}

export interface BeginContentUploadInput {
  sessionId: string;
  userId: string;
  uploadId: string;
  updateId: string;
  noteId: string;
  sectionId: string;
  expectedKeyEpoch: number;
  kind: ContentKind;
  formatVersion: number;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
  checkpointSequenceCutoff?: number;
  expiresAt: string;
  quotaBytes: number;
}

export type BeginContentUploadOutcome =
  | ({ kind: "created" | "existing" } & ContentUploadView)
  | {
      kind:
        | "unauthorized"
        | "not-found"
        | "conflict"
        | "rotation-pending"
        | "stale-epoch"
        | "storage-limit";
    };

export interface RegisterContentChunkInput {
  sessionId: string;
  userId: string;
  uploadId: string;
  chunkIndex: number;
  cipherLength: number;
  cipherHash: string;
  nonce: Buffer;
  storageKey: string;
}

export type RegisterContentChunkOutcome =
  | "stored"
  | "raced"
  | "unauthorized"
  | "not-found"
  | "stale-epoch"
  | "rotation-pending"
  | "conflict"
  | "chunk-conflict"
  | "manifest-mismatch";

export type AbortContentUploadOutcome =
  | { kind: "aborted"; storageKeys: string[] }
  | { kind: "unauthorized" | "not-found" | "conflict" };

export interface ContentUploadRepository {
  begin(input: BeginContentUploadInput): Promise<BeginContentUploadOutcome>;
  status(
    uploadId: string,
    userId: string,
    now: string
  ): Promise<ContentUploadView | null>;
  findEditable(uploadId: string, userId: string): Promise<ContentUploadRecord | null>;
  findChunk(uploadId: string, chunkIndex: number): Promise<ContentChunkRecord | null>;
  registerChunk(input: RegisterContentChunkInput): Promise<RegisterContentChunkOutcome>;
  abort(
    uploadId: string,
    sessionId: string,
    userId: string
  ): Promise<AbortContentUploadOutcome>;
  findManifestChunk(
    manifestId: string,
    chunkIndex: number
  ): Promise<ContentManifestChunkRecord | null>;
  quota(userId: string, quotaBytes: number): Promise<StorageQuotaStatus>;
}
