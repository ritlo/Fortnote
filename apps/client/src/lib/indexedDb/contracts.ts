export interface EncryptedOutboxRecord {
  userId: string;
  noteId: string;
  sectionId: string;
  cryptoOwnerId: string;
  keyEpoch: number;
  updateId: string;
  kind: "update" | "checkpoint" | "root-update" | "chunk";
  formatVersion: number;
  inlineCipher: Uint8Array;
  nonce: Uint8Array;
  originClientId?: string;
  checkpointSequenceCutoff?: number;
  state: "queued" | "sending" | "terminal-rejected";
  terminalReason?: "forbidden" | "stale-epoch";
  terminalRejectedAt?: number;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface AcknowledgementRecord {
  userId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  serverSequence: number;
  acknowledgedAt: number;
}

export interface SectionCacheRecord {
  userId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  manifestId: string;
  encryptedBytes: Uint8Array;
  lastAccessedAt: number;
  pending: boolean;
}

export interface LeaseRecord {
  scopeKey: string;
  userId: string;
  ownerId: string;
  expiresAt: number;
}

export interface EncryptedContentTransferRecord {
  userId: string;
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
  chunks: {
    chunkIndex: number;
    cipherBytes: Uint8Array;
    cipherHash: string;
    nonce: string;
  }[];
  uploadedChunkIndexes: number[];
  createdAt: number;
  updatedAt: number;
}

export interface ProtectedSearchIndexRecord {
  userId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  indexedSequence: number;
  cipher: string;
  nonce: string;
  formatVersion: 2;
  updatedAt: number;
}

export interface IndexedDbChange {
  store:
    | "outbox"
    | "acknowledgements"
    | "section-cache"
    | "leases"
    | "content-transfers"
    | "search-index";
  userId: string;
}

type OutboxKey = Pick<
  EncryptedOutboxRecord,
  "userId" | "noteId" | "sectionId" | "keyEpoch" | "updateId"
>;
type CacheKey = Pick<
  SectionCacheRecord,
  "userId" | "noteId" | "sectionId" | "keyEpoch" | "manifestId"
>;
type SearchIndexKey = Pick<
  ProtectedSearchIndexRecord,
  "userId" | "noteId" | "sectionId" | "keyEpoch"
>;

export class IndexedDbCapacityError extends Error {
  constructor() {
    super("Protected browser storage is full");
    this.name = "IndexedDbCapacityError";
  }
}

export class IndexedDbOperationError extends Error {
  constructor() {
    super("Protected browser storage operation failed");
    this.name = "IndexedDbOperationError";
  }
}

export function normalizeIndexedDbError(error: unknown): Error {
  if (error instanceof IndexedDbCapacityError || error instanceof IndexedDbOperationError) {
    return error;
  }
  if (isNamedError(error, "QuotaExceededError")) {
    return new IndexedDbCapacityError();
  }
  return new IndexedDbOperationError();
}

export interface OpenFortnoteIndexedDbOptions {
  factory?: IDBFactory;
  name?: string;
  broadcastChannelFactory?: (name: string) => BroadcastChannel;
}

export interface FortnoteIndexedDb {
  readonly name: string;
  acknowledgeOutbox(record: OutboxKey, serverSequence: number): Promise<void>;
  acquireLease(
    scopeKey: string,
    ownerId: string,
    now: number,
    durationMs: number
  ): Promise<boolean>;
  clearAccount(userId: string): Promise<void>;
  close(): void;
  deleteContentTransfer(userId: string, uploadId: string): Promise<void>;
  deleteOutboxFence(
    fence: Pick<EncryptedOutboxRecord, "userId" | "noteId" | "sectionId" | "keyEpoch">
  ): Promise<void>;
  deleteSectionCache(record: CacheKey): Promise<void>;
  deleteDatabase(): Promise<void>;
  evictSectionCache(userId: string, maxEntries: number, maxBytes?: number): Promise<string[]>;
  getAcknowledgement(record: OutboxKey): Promise<AcknowledgementRecord | null>;
  getContentTransfer(
    userId: string,
    uploadId: string
  ): Promise<EncryptedContentTransferRecord | null>;
  getOutbox(record: OutboxKey): Promise<EncryptedOutboxRecord | null>;
  getSearchIndexSection(record: SearchIndexKey): Promise<ProtectedSearchIndexRecord | null>;
  getSectionCache(record: CacheKey): Promise<SectionCacheRecord | null>;
  listOutbox(userId: string): Promise<EncryptedOutboxRecord[]>;
  listContentTransfers(userId: string): Promise<EncryptedContentTransferRecord[]>;
  listSearchIndex(userId: string): Promise<ProtectedSearchIndexRecord[]>;
  preserveOutboxFence(
    fence: Pick<EncryptedOutboxRecord, "userId" | "noteId" | "sectionId" | "keyEpoch">,
    reason: "forbidden" | "stale-epoch",
    rejectedAt: number
  ): Promise<EncryptedOutboxRecord[]>;
  listSectionCache(userId: string): Promise<SectionCacheRecord[]>;
  putOutbox(record: EncryptedOutboxRecord): Promise<void>;
  putContentTransfer(record: EncryptedContentTransferRecord): Promise<void>;
  putSearchIndexSection(record: ProtectedSearchIndexRecord): Promise<boolean>;
  putSectionCache(record: SectionCacheRecord): Promise<void>;
  readLease(scopeKey: string): Promise<LeaseRecord | null>;
  subscribe(listener: (change: IndexedDbChange) => void): () => void;
}

function isNamedError(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}
