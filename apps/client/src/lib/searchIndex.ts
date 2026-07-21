import {
  associatedDataV2,
  decryptBytes,
  encryptBytesV2,
  hkdfSha256,
  sha256
} from "@fortnote/shared";
import type {
  FortnoteIndexedDb,
  ProtectedSearchIndexRecord
} from "./indexedDb";

const SEARCH_INDEX_FORMAT_VERSION = 1;
const DEFAULT_MAX_SECTIONS_PER_BATCH = 2;
const MAX_EXCERPT_LENGTH = 160;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface SearchCoverageTarget {
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  serverSequence: number;
}

export interface SearchIndexBlock {
  blockId: string;
  text: string;
}

export interface SearchSectionUpdate extends SearchCoverageTarget {
  blocks: SearchIndexBlock[];
}

export interface SearchCoverage {
  complete: boolean;
  indexedSections: number;
  totalSections: number;
  pending: {
    noteId: string;
    sectionId: string;
    keyEpoch: number;
    indexedSequence: number;
    targetSequence: number;
  }[];
}

export interface SearchMatch {
  noteId: string;
  sectionId: string;
  blockId: string;
  indexedSequence: number;
  excerpt: string;
}

export interface SearchQueryResult {
  coverage: SearchCoverage;
  matches: SearchMatch[];
}

export interface ProtectedSearchIndex {
  applySection(update: SearchSectionUpdate): Promise<{
    changedBlockIds: string[];
    indexedSequence: number;
  }>;
  buildNextBatch(
    targets: SearchCoverageTarget[],
    loadSection: (target: SearchCoverageTarget) => Promise<SearchSectionUpdate>
  ): Promise<SearchCoverage>;
  coverage(targets: SearchCoverageTarget[]): Promise<SearchCoverage>;
  query(text: string, targets: SearchCoverageTarget[]): Promise<SearchQueryResult>;
}

interface ProtectedSectionPayload {
  version: 1;
  blocks: ProtectedBlockEntry[];
}

interface ProtectedBlockEntry {
  blockId: string;
  fingerprint: string;
  terms: string[];
  excerpt: string;
}

interface CreateProtectedSearchIndexOptions {
  database: FortnoteIndexedDb;
  rootKey: Uint8Array;
  userId: string;
  maxSectionsPerBatch?: number;
  tokenize?: (text: string) => string[];
  yieldControl?: () => Promise<void>;
}

export function createProtectedSearchIndex({
  database,
  rootKey,
  userId,
  maxSectionsPerBatch = DEFAULT_MAX_SECTIONS_PER_BATCH,
  tokenize = defaultTokenize,
  yieldControl = defaultYieldControl
}: CreateProtectedSearchIndexOptions): ProtectedSearchIndex {
  if (!userId || rootKey.byteLength !== 32) {
    throw new Error("Invalid protected search identity");
  }
  if (!Number.isSafeInteger(maxSectionsPerBatch) || maxSectionsPerBatch <= 0) {
    throw new Error("Invalid protected search batch limit");
  }
  const searchKey = deriveSearchKey(rootKey, userId);

  async function applySection(update: SearchSectionUpdate) {
    assertSectionUpdate(update);
    const identity = { userId, ...sectionIdentity(update) };
    const existingRecord = await database.getSearchIndexSection(identity);
    if (existingRecord && existingRecord.indexedSequence > update.serverSequence) {
      return {
        changedBlockIds: [],
        indexedSequence: existingRecord.indexedSequence
      };
    }
    const existing = existingRecord
      ? await openRecord(existingRecord).catch(() => emptyPayload())
      : emptyPayload();
    const previous = new Map(existing.blocks.map((block) => [block.blockId, block]));
    const seen = new Set<string>();
    const blocks: ProtectedBlockEntry[] = [];
    const changedBlockIds: string[] = [];

    for (const block of update.blocks) {
      if (!block.blockId || seen.has(block.blockId)) {
        throw new Error("Invalid protected search block identity");
      }
      seen.add(block.blockId);
      const fingerprint = await sha256Hex(block.text);
      const current = previous.get(block.blockId);
      if (current?.fingerprint === fingerprint) {
        blocks.push(current);
        continue;
      }
      changedBlockIds.push(block.blockId);
      blocks.push({
        blockId: block.blockId,
        fingerprint,
        terms: normalizeTerms(tokenize(block.text)),
        excerpt: block.text.trim().slice(0, MAX_EXCERPT_LENGTH)
      });
    }
    for (const blockId of previous.keys()) {
      if (!seen.has(blockId)) {
        changedBlockIds.push(blockId);
      }
    }

    const encrypted = await sealPayload(
      { version: SEARCH_INDEX_FORMAT_VERSION, blocks },
      identity,
      update.serverSequence
    );
    const stored = await database.putSearchIndexSection({
      ...identity,
      indexedSequence: update.serverSequence,
      cipher: encrypted.cipher,
      nonce: encrypted.nonce,
      formatVersion: 2,
      updatedAt: Date.now()
    });
    if (!stored) {
      const current = await database.getSearchIndexSection(identity);
      return {
        changedBlockIds: [],
        indexedSequence: current?.indexedSequence ?? update.serverSequence
      };
    }
    return { changedBlockIds, indexedSequence: update.serverSequence };
  }

  async function buildNextBatch(
    targets: SearchCoverageTarget[],
    loadSection: (target: SearchCoverageTarget) => Promise<SearchSectionUpdate>
  ): Promise<SearchCoverage> {
    const normalizedTargets = normalizeTargets(targets);
    const current = await coverage(normalizedTargets);
    const byIdentity = new Map(
      normalizedTargets.map((target) => [coverageIdentity(target), target])
    );
    const batch = current.pending
      .slice(0, maxSectionsPerBatch)
      .map((pending) => byIdentity.get(coverageIdentity(pending)))
      .filter((target): target is SearchCoverageTarget => target !== undefined);

    for (const target of batch) {
      const loaded = await loadSection(target);
      assertLoadedTarget(target, loaded);
      await applySection(loaded);
      await yieldControl();
    }
    return coverage(normalizedTargets);
  }

  async function coverage(targets: SearchCoverageTarget[]): Promise<SearchCoverage> {
    const records = await readableRecords();
    return coverageFor(normalizeTargets(targets), records);
  }

  async function query(
    text: string,
    targets: SearchCoverageTarget[]
  ): Promise<SearchQueryResult> {
    const queryTerms = normalizeTerms(tokenize(text));
    const normalizedTargets = normalizeTargets(targets);
    const targetIdentities = new Set(normalizedTargets.map(coverageIdentity));
    const records = await readableRecords();
    const matches: SearchMatch[] = [];
    if (queryTerms.length > 0) {
      for (const { payload, record } of records) {
        if (!targetIdentities.has(coverageIdentity(record))) {
          continue;
        }
        for (const block of payload.blocks) {
          if (queryTerms.every((term) => block.terms.includes(term))) {
            matches.push({
              noteId: record.noteId,
              sectionId: record.sectionId,
              blockId: block.blockId,
              indexedSequence: record.indexedSequence,
              excerpt: block.excerpt
            });
          }
        }
      }
    }
    matches.sort((left, right) =>
      left.noteId.localeCompare(right.noteId) ||
      left.sectionId.localeCompare(right.sectionId) ||
      left.blockId.localeCompare(right.blockId)
    );
    return {
      coverage: coverageFor(normalizedTargets, records),
      matches
    };
  }

  async function readableRecords(): Promise<{
    payload: ProtectedSectionPayload;
    record: ProtectedSearchIndexRecord;
  }[]> {
    const records = await database.listSearchIndex(userId);
    const opened = await Promise.all(records.map(async (record) => {
      try {
        return { payload: await openRecord(record), record };
      } catch {
        return null;
      }
    }));
    return opened.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  async function sealPayload(
    payload: ProtectedSectionPayload,
    identity: ReturnType<typeof sectionIdentity> & { userId: string },
    indexedSequence: number
  ) {
    return encryptBytesV2(
      textEncoder.encode(JSON.stringify(payload)),
      await searchKey,
      searchAssociatedData(identity, indexedSequence)
    );
  }

  async function openRecord(
    record: ProtectedSearchIndexRecord
  ): Promise<ProtectedSectionPayload> {
    const stored = record as unknown as Record<string, unknown>;
    if (stored.userId !== userId || stored.formatVersion !== 2) {
      throw new Error("Protected search record context mismatch");
    }
    const bytes = await decryptBytes(
      record,
      await searchKey,
      searchAssociatedData(record, record.indexedSequence)
    );
    return parsePayload(textDecoder.decode(bytes));
  }

  return { applySection, buildNextBatch, coverage, query };
}

function coverageFor(
  targets: SearchCoverageTarget[],
  records: { record: ProtectedSearchIndexRecord }[]
): SearchCoverage {
  const indexed = new Map(records.map(({ record }) => [coverageIdentity(record), record]));
  const pending = targets.flatMap((target) => {
    const record = indexed.get(coverageIdentity(target));
    return record && record.indexedSequence >= target.serverSequence
      ? []
      : [{
          noteId: target.noteId,
          sectionId: target.sectionId,
          keyEpoch: target.keyEpoch,
          indexedSequence: record?.indexedSequence ?? 0,
          targetSequence: target.serverSequence
        }];
  });
  return {
    complete: pending.length === 0,
    indexedSections: targets.length - pending.length,
    totalSections: targets.length,
    pending
  };
}

function normalizeTargets(targets: SearchCoverageTarget[]): SearchCoverageTarget[] {
  const normalized = new Map<string, SearchCoverageTarget>();
  for (const target of targets) {
    assertCoverageTarget(target);
    const identity = coverageIdentity(target);
    const current = normalized.get(identity);
    if (!current || current.serverSequence < target.serverSequence) {
      normalized.set(identity, { ...target });
    }
  }
  return [...normalized.values()].sort((left, right) =>
    left.noteId.localeCompare(right.noteId) ||
    left.sectionId.localeCompare(right.sectionId) ||
    left.keyEpoch - right.keyEpoch
  );
}

function normalizeTerms(terms: string[]): string[] {
  return [...new Set(
    terms
      .map((term) => term.normalize("NFKC").toLocaleLowerCase().trim())
      .filter(Boolean)
  )].sort();
}

function defaultTokenize(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function emptyPayload(): ProtectedSectionPayload {
  return { version: SEARCH_INDEX_FORMAT_VERSION, blocks: [] };
}

function parsePayload(serialized: string): ProtectedSectionPayload {
  const value: unknown = JSON.parse(serialized);
  if (
    !isRecord(value) ||
    value.version !== SEARCH_INDEX_FORMAT_VERSION ||
    !Array.isArray(value.blocks) ||
    !value.blocks.every(isProtectedBlockEntry)
  ) {
    throw new Error("Protected search record is invalid");
  }
  return value as unknown as ProtectedSectionPayload;
}

function isProtectedBlockEntry(value: unknown): value is ProtectedBlockEntry {
  return (
    isRecord(value) &&
    typeof value.blockId === "string" &&
    typeof value.fingerprint === "string" &&
    Array.isArray(value.terms) &&
    value.terms.every((term) => typeof term === "string") &&
    typeof value.excerpt === "string"
  );
}

function assertSectionUpdate(update: SearchSectionUpdate): void {
  assertCoverageTarget(update);
  if (!Array.isArray(update.blocks) || update.blocks.some(
    (block) => typeof block.blockId !== "string" || typeof block.text !== "string"
  )) {
    throw new Error("Invalid protected search section");
  }
}

function assertCoverageTarget(target: SearchCoverageTarget): void {
  if (
    !target.noteId ||
    !target.sectionId ||
    !Number.isSafeInteger(target.keyEpoch) ||
    target.keyEpoch <= 0 ||
    !Number.isSafeInteger(target.serverSequence) ||
    target.serverSequence < 0
  ) {
    throw new Error("Invalid protected search coverage target");
  }
}

function assertLoadedTarget(
  target: SearchCoverageTarget,
  loaded: SearchSectionUpdate
): void {
  assertSectionUpdate(loaded);
  if (
    coverageIdentity(target) !== coverageIdentity(loaded) ||
    loaded.serverSequence < target.serverSequence
  ) {
    throw new Error("Protected search background section mismatch");
  }
}

function sectionIdentity(target: Pick<SearchCoverageTarget, "noteId" | "sectionId" | "keyEpoch">) {
  return {
    noteId: target.noteId,
    sectionId: target.sectionId,
    keyEpoch: target.keyEpoch
  };
}

function coverageIdentity(
  target: Pick<SearchCoverageTarget, "noteId" | "sectionId" | "keyEpoch">
): string {
  return JSON.stringify([target.noteId, target.sectionId, target.keyEpoch]);
}

function searchAssociatedData(
  identity: ReturnType<typeof sectionIdentity> & { userId: string },
  indexedSequence: number
): Uint8Array {
  return associatedDataV2("search-index-section", {
    userId: identity.userId,
    noteId: identity.noteId,
    sectionId: identity.sectionId,
    keyEpoch: identity.keyEpoch,
    indexedSequence
  });
}

async function deriveSearchKey(rootKey: Uint8Array, userId: string): Promise<Uint8Array> {
  return hkdfSha256(
    rootKey,
    textEncoder.encode("fortnote:search-index:salt:v1"),
    textEncoder.encode(`fortnote:search-index:key:v1:${userId}`),
    32
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await sha256(textEncoder.encode(value));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function defaultYieldControl(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
