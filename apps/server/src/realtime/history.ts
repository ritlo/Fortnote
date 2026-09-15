import { type CrdtBinaryHeader } from "@fortnote/shared";

export type BinaryUpdateOutcome =
  | { status: "inserted" | "already-present"; serverSequence: number }
  | {
      status: "rejected";
      code: "forbidden" | "rotation-pending" | "stale-epoch" | "storage-limit";
    };

interface SectionHistoryEntryBase {
  updateId: string;
  serverSequence: number;
  cryptoOwnerId: string;
  keyEpoch: number;
  formatVersion: number;
  kind: "update" | "checkpoint" | "root-update";
  checkpointSequenceCutoff: number | null;
}

export interface InlineSectionHistoryEntry extends SectionHistoryEntryBase {
  storage: "inline";
  inlineCipher: Buffer;
  nonce: Buffer;
}

export interface ManifestSectionHistoryEntry extends SectionHistoryEntryBase {
  storage: "manifest";
  manifestId: string;
  uploadId: string;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
}

export type SectionHistoryEntry = InlineSectionHistoryEntry | ManifestSectionHistoryEntry;

export interface SectionHistoryRow extends SectionHistoryEntryBase {
  inlineCipher: Buffer | null;
  nonce: Buffer | null;
  manifestId: string | null;
  uploadId: string | null;
  totalCipherBytes: number | null;
  chunkCount: number | null;
  manifestHash: string | null;
}

export interface SectionHistoryPage {
  entries: SectionHistoryEntry[];
  hasMore: boolean;
  nextSequence: number;
}

export interface PersistBinaryUpdateInput {
  sessionId: string;
  userId: string;
  header: CrdtBinaryHeader;
  cipher: Uint8Array;
}

export interface ListSectionHistoryInput {
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  afterSequence: number;
  maxItems: number;
  maxBytes: number;
}

export interface SectionHistoryRepository {
  persist(input: PersistBinaryUpdateInput): Promise<BinaryUpdateOutcome>;
  list(input: ListSectionHistoryInput): Promise<SectionHistoryPage | null>;
}

interface ExistingUpdateRow {
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  serverSequence: number;
}

export function matchingUpdate(
  existing: ExistingUpdateRow,
  header: CrdtBinaryHeader,
  storedSectionId: string
): BinaryUpdateOutcome {
  return existing.noteId === header.noteId &&
    existing.sectionId === storedSectionId &&
    existing.keyEpoch === header.expectedKeyEpoch
    ? { status: "already-present", serverSequence: existing.serverSequence }
    : { status: "rejected", code: "forbidden" };
}

export function paginateHistory(
  rows: SectionHistoryRow[],
  limits: Pick<ListSectionHistoryInput, "afterSequence" | "maxItems" | "maxBytes">
): SectionHistoryPage {
  const hasMoreItems = rows.length > limits.maxItems;
  const candidates = rows.slice(0, limits.maxItems).map(historyEntry);
  const entries: SectionHistoryEntry[] = [];
  let bytes = 0;
  for (const row of candidates) {
    const nextBytes = bytes + (row.storage === "inline" ? row.inlineCipher.length : 0);
    if (entries.length > 0 && nextBytes > limits.maxBytes) {
      break;
    }
    entries.push(row);
    bytes = nextBytes;
  }
  return {
    entries,
    hasMore: hasMoreItems || entries.length < candidates.length,
    nextSequence: entries.at(-1)?.serverSequence ?? limits.afterSequence
  };
}

export function historyEntry(row: SectionHistoryRow): SectionHistoryEntry {
  const base = {
    updateId: row.updateId,
    serverSequence: row.serverSequence,
    cryptoOwnerId: row.cryptoOwnerId,
    keyEpoch: row.keyEpoch,
    formatVersion: row.formatVersion,
    kind: row.kind,
    checkpointSequenceCutoff: row.checkpointSequenceCutoff
  };
  if (row.manifestId) {
    if (
      !row.uploadId ||
      row.totalCipherBytes === null ||
      row.chunkCount === null ||
      !row.manifestHash
    ) {
      throw new Error("Content manifest history is incomplete");
    }
    return {
      ...base,
      storage: "manifest",
      manifestId: row.manifestId,
      uploadId: row.uploadId,
      totalCipherBytes: row.totalCipherBytes,
      chunkCount: row.chunkCount,
      manifestHash: row.manifestHash
    };
  }
  if (!row.inlineCipher || !row.nonce) {
    throw new Error("Inline content history is incomplete");
  }
  return {
    ...base,
    storage: "inline",
    inlineCipher: row.inlineCipher,
    nonce: row.nonce
  };
}
