import { fromCanonicalBase64, type CrdtBinaryHeader } from "@fortnote/shared";
import { and, eq, gt, lte, ne, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { ROOT_CRDT_SECTION_ID, storageSectionId } from "../notes/sections.js";

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

interface HistoryAccess {
  cryptoOwnerId: string;
  keyEpoch: number;
  rotationFenced: boolean;
  isDeleted: boolean;
  role: string;
  status: string;
}

interface StoredSection {
  id: string;
  noteId: string;
  createdEpoch: number;
  currentSequence: number;
  isDeleted: boolean;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

function activeSession(
  database: Pick<SqliteDatabase, "select">,
  sessionId: string
): boolean {
  const now = new Date().toISOString();
  return Boolean(
    database
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.id, sessionId),
          gt(schema.sessions.idleExpiresAt, now),
          gt(schema.sessions.absoluteExpiresAt, now)
        )
      )
      .get()
  );
}

function historyAccess(
  database: Pick<SqliteDatabase, "select">,
  noteId: string,
  userId: string
): HistoryAccess | null {
  return (
    database
      .select({
        cryptoOwnerId: schema.notes.cryptoOwnerId,
        keyEpoch: schema.notes.keyEpoch,
        rotationFenced: schema.notes.rotationFenced,
        isDeleted: schema.notes.isDeleted,
        role: schema.noteMemberships.role,
        status: schema.noteMemberships.status
      })
      .from(schema.notes)
      .innerJoin(
        schema.noteMemberships,
        eq(schema.noteMemberships.noteId, schema.notes.id)
      )
      .where(and(eq(schema.notes.id, noteId), eq(schema.noteMemberships.userId, userId)))
      .get() ?? null
  );
}

function ensureSection(
  database: Pick<SqliteDatabase, "select" | "insert">,
  noteId: string,
  sectionId: string,
  keyEpoch: number
): StoredSection | null {
  const storedId = storageSectionId(noteId, sectionId);
  if (sectionId === ROOT_CRDT_SECTION_ID) {
    const note = database
      .select({ keyEpoch: schema.notes.keyEpoch })
      .from(schema.notes)
      .where(eq(schema.notes.id, noteId))
      .get();
    if (!note) {
      return null;
    }
    database
      .insert(schema.noteSections)
      .values({ id: noteId, noteId, createdEpoch: note.keyEpoch })
      .onConflictDoNothing()
      .run();
  }
  const section = database
    .select({
      id: schema.noteSections.id,
      noteId: schema.noteSections.noteId,
      createdEpoch: schema.noteSections.createdEpoch,
      currentSequence: schema.noteSections.currentSequence,
      isDeleted: schema.noteSections.isDeleted
    })
    .from(schema.noteSections)
    .where(
      and(eq(schema.noteSections.id, storedId), eq(schema.noteSections.noteId, noteId))
    )
    .get();
  if (!section || section.isDeleted || section.createdEpoch > keyEpoch) {
    return null;
  }
  return section;
}

export class SqliteSectionHistoryRepository implements SectionHistoryRepository {
  constructor(private readonly orm: SqliteDatabase) {}

  persist(input: PersistBinaryUpdateInput): Promise<BinaryUpdateOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      if (!activeSession(transaction, input.sessionId)) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      const access = historyAccess(transaction, input.header.noteId, input.userId);
      if (access?.status !== "active" || access.isDeleted) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      if (access.rotationFenced) {
        return { status: "rejected", code: "rotation-pending" } as const;
      }
      if (access.keyEpoch !== input.header.expectedKeyEpoch) {
        return { status: "rejected", code: "stale-epoch" } as const;
      }
      if (
        (access.role !== "owner" && access.role !== "editor") ||
        access.cryptoOwnerId !== input.header.cryptoOwnerId
      ) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      const section = ensureSection(
        transaction,
        input.header.noteId,
        input.header.sectionId,
        access.keyEpoch
      );
      if (!section) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      const checkpointCutoff = input.header.checkpointSequenceCutoff;
      if (
        (input.header.kind === "checkpoint") !== (checkpointCutoff !== undefined) ||
        (checkpointCutoff !== undefined && checkpointCutoff > section.currentSequence)
      ) {
        return { status: "rejected", code: "forbidden" } as const;
      }

      const storedSectionId = storageSectionId(
        input.header.noteId,
        input.header.sectionId
      );
      const existing = transaction
        .select({
          noteId: schema.sectionUpdates.noteId,
          sectionId: schema.sectionUpdates.sectionId,
          keyEpoch: schema.sectionUpdates.keyEpoch,
          serverSequence: schema.sectionUpdates.serverSequence
        })
        .from(schema.sectionUpdates)
        .where(eq(schema.sectionUpdates.updateId, input.header.updateId))
        .get();
      if (existing) {
        return matchingUpdate(existing, input.header, storedSectionId);
      }

      const nextSequence = section.currentSequence + 1;
      transaction
        .insert(schema.sectionUpdates)
        .values({
          updateId: input.header.updateId,
          noteId: input.header.noteId,
          sectionId: storedSectionId,
          serverSequence: nextSequence,
          cryptoOwnerId: input.header.cryptoOwnerId,
          keyEpoch: input.header.expectedKeyEpoch,
          formatVersion: input.header.formatVersion,
          kind: input.header.kind,
          inlineCipher: Buffer.from(input.cipher),
          nonce: Buffer.from(fromCanonicalBase64(input.header.nonce)),
          checkpointSequenceCutoff: input.header.checkpointSequenceCutoff ?? null
        })
        .run();
      transaction
        .update(schema.noteSections)
        .set({
          currentSequence: nextSequence,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.noteSections.id, storedSectionId),
            eq(schema.noteSections.noteId, input.header.noteId)
          )
        )
        .run();
      if (checkpointCutoff !== undefined && checkpointCutoff > 0) {
        transaction
          .delete(schema.sectionUpdates)
          .where(
            and(
              eq(schema.sectionUpdates.noteId, input.header.noteId),
              eq(schema.sectionUpdates.sectionId, storedSectionId),
              eq(schema.sectionUpdates.keyEpoch, input.header.expectedKeyEpoch),
              lte(schema.sectionUpdates.serverSequence, checkpointCutoff),
              ne(schema.sectionUpdates.updateId, input.header.updateId)
            )
          )
          .run();
      }
      return { status: "inserted", serverSequence: nextSequence } as const;
    });
    return Promise.resolve(outcome);
  }

  list(input: ListSectionHistoryInput): Promise<SectionHistoryPage | null> {
    const page = this.orm.transaction((transaction) => {
      const section = ensureSection(
        transaction,
        input.noteId,
        input.sectionId,
        input.keyEpoch
      );
      if (!section) {
        return null;
      }
      const rows = transaction
        .select({
          updateId: schema.sectionUpdates.updateId,
          serverSequence: schema.sectionUpdates.serverSequence,
          cryptoOwnerId: schema.sectionUpdates.cryptoOwnerId,
          keyEpoch: schema.sectionUpdates.keyEpoch,
          formatVersion: schema.sectionUpdates.formatVersion,
          kind: schema.sectionUpdates.kind,
          inlineCipher: schema.sectionUpdates.inlineCipher,
          nonce: schema.sectionUpdates.nonce,
          checkpointSequenceCutoff: schema.sectionUpdates.checkpointSequenceCutoff,
          manifestId: schema.sectionUpdates.manifestId,
          uploadId: schema.contentManifests.uploadId,
          totalCipherBytes: schema.contentManifests.totalCipherBytes,
          chunkCount: schema.contentManifests.chunkCount,
          manifestHash: schema.contentManifests.manifestHash
        })
        .from(schema.sectionUpdates)
        .leftJoin(
          schema.contentManifests,
          eq(schema.contentManifests.id, schema.sectionUpdates.manifestId)
        )
        .where(
          and(
            eq(schema.sectionUpdates.noteId, input.noteId),
            eq(
              schema.sectionUpdates.sectionId,
              storageSectionId(input.noteId, input.sectionId)
            ),
            eq(schema.sectionUpdates.keyEpoch, input.keyEpoch),
            gt(schema.sectionUpdates.serverSequence, input.afterSequence)
          )
        )
        .orderBy(schema.sectionUpdates.serverSequence)
        .limit(input.maxItems + 1)
        .all() as SectionHistoryRow[];
      return paginateHistory(rows, input);
    });
    return Promise.resolve(page);
  }
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
