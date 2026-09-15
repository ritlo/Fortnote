import { fromCanonicalBase64 } from "@fortnote/shared";
import { and, eq, gt, lte, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import {
  matchingUpdate,
  paginateHistory,
  type BinaryUpdateOutcome,
  type ListSectionHistoryInput,
  type PersistBinaryUpdateInput,
  type SectionHistoryRepository,
  type SectionHistoryRow
} from "./history.js";
import { ROOT_CRDT_SECTION_ID, storageSectionId } from "../notes/sections.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

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

async function activeSession(
  database: Pick<PostgresDatabase, "select">,
  sessionId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const sessions = await database
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        gt(schema.sessions.idleExpiresAt, now),
        gt(schema.sessions.absoluteExpiresAt, now)
      )
    )
    .limit(1)
    .for("key share");
  return Boolean(sessions[0]);
}

async function historyAccess(
  database: Pick<PostgresDatabase, "select">,
  noteId: string,
  userId: string
): Promise<HistoryAccess | null> {
  const rows = await database
    .select({
      cryptoOwnerId: schema.notes.cryptoOwnerId,
      keyEpoch: schema.notes.keyEpoch,
      rotationFenced: schema.notes.rotationFenced,
      isDeleted: schema.notes.isDeleted,
      role: schema.noteMemberships.role,
      status: schema.noteMemberships.status
    })
    .from(schema.notes)
    .innerJoin(schema.noteMemberships, eq(schema.noteMemberships.noteId, schema.notes.id))
    .where(and(eq(schema.notes.id, noteId), eq(schema.noteMemberships.userId, userId)))
    .limit(1)
    .for("update", { of: [schema.notes, schema.noteMemberships] });
  return rows[0] ?? null;
}

async function ensureSection(
  database: Pick<PostgresDatabase, "select" | "insert">,
  noteId: string,
  sectionId: string,
  keyEpoch: number
): Promise<StoredSection | null> {
  const storedId = storageSectionId(noteId, sectionId);
  if (sectionId === ROOT_CRDT_SECTION_ID) {
    const notes = await database
      .select({ keyEpoch: schema.notes.keyEpoch })
      .from(schema.notes)
      .where(eq(schema.notes.id, noteId))
      .limit(1)
      .for("update");
    const note = notes[0];
    if (!note) {
      return null;
    }
    await database
      .insert(schema.noteSections)
      .values({ id: noteId, noteId, createdEpoch: note.keyEpoch })
      .onConflictDoNothing();
  }
  const sections = await database
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
    .limit(1)
    .for("update");
  const section = sections[0];
  if (!section || section.isDeleted || section.createdEpoch > keyEpoch) {
    return null;
  }
  return section;
}

export class PostgresSectionHistoryRepository implements SectionHistoryRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  persist(input: PersistBinaryUpdateInput): Promise<BinaryUpdateOutcome> {
    return this.orm.transaction(async (transaction) => {
      if (!(await activeSession(transaction, input.sessionId))) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      const access = await historyAccess(transaction, input.header.noteId, input.userId);
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
      const section = await ensureSection(
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
      const existingRows = await transaction
        .select({
          noteId: schema.sectionUpdates.noteId,
          sectionId: schema.sectionUpdates.sectionId,
          keyEpoch: schema.sectionUpdates.keyEpoch,
          serverSequence: schema.sectionUpdates.serverSequence
        })
        .from(schema.sectionUpdates)
        .where(eq(schema.sectionUpdates.updateId, input.header.updateId))
        .limit(1)
        .for("update");
      const existing = existingRows[0];
      if (existing) {
        return matchingUpdate(existing, input.header, storedSectionId);
      }

      const nextSequence = section.currentSequence + 1;
      const inserted = await transaction
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
        .onConflictDoNothing()
        .returning({ updateId: schema.sectionUpdates.updateId });
      if (inserted.length !== 1) {
        const duplicates = await transaction
          .select({
            noteId: schema.sectionUpdates.noteId,
            sectionId: schema.sectionUpdates.sectionId,
            keyEpoch: schema.sectionUpdates.keyEpoch,
            serverSequence: schema.sectionUpdates.serverSequence
          })
          .from(schema.sectionUpdates)
          .where(eq(schema.sectionUpdates.updateId, input.header.updateId))
          .limit(1);
        const duplicate = duplicates[0];
        return duplicate
          ? matchingUpdate(duplicate, input.header, storedSectionId)
          : ({ status: "rejected", code: "forbidden" } as const);
      }
      const advanced = await transaction
        .update(schema.noteSections)
        .set({
          currentSequence: nextSequence,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.noteSections.id, storedSectionId),
            eq(schema.noteSections.noteId, input.header.noteId),
            eq(schema.noteSections.currentSequence, section.currentSequence)
          )
        )
        .returning({ id: schema.noteSections.id });
      if (advanced.length !== 1) {
        throw new Error("Section sequence changed while locked");
      }
      if (checkpointCutoff !== undefined && checkpointCutoff > 0) {
        await transaction
          .delete(schema.sectionUpdates)
          .where(
            and(
              eq(schema.sectionUpdates.noteId, input.header.noteId),
              eq(schema.sectionUpdates.sectionId, storedSectionId),
              eq(schema.sectionUpdates.keyEpoch, input.header.expectedKeyEpoch),
              lte(schema.sectionUpdates.serverSequence, checkpointCutoff),
              ne(schema.sectionUpdates.updateId, input.header.updateId)
            )
          );
      }
      return { status: "inserted", serverSequence: nextSequence } as const;
    });
  }

  list(input: ListSectionHistoryInput) {
    return this.orm.transaction(async (transaction) => {
      const section = await ensureSection(
        transaction,
        input.noteId,
        input.sectionId,
        input.keyEpoch
      );
      if (!section) {
        return null;
      }
      const rawRows = await transaction
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
        .limit(input.maxItems + 1);
      const rows: SectionHistoryRow[] = rawRows.map((row) => ({
        ...row,
        kind: row.kind as SectionHistoryRow["kind"]
      }));
      return paginateHistory(rows, input);
    });
  }
}
