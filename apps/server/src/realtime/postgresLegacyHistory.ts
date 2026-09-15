import { and, eq, gt, inArray, lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import {
  legacyHistoryMessage,
  legacyHistoryValues,
  legacyStorageLimitExceeded,
  type LegacyHistoryPersistOutcome,
  type LegacyHistoryRepository,
  type LegacyHistoryRow,
  type PersistLegacyHistoryInput
} from "./legacyHistory.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

interface LegacyWriteAccess {
  cryptoOwnerId: string;
  keyEpoch: number;
  role: string;
  status: string;
}

export class PostgresLegacyHistoryRepository implements LegacyHistoryRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  async list(noteId: string, keyEpoch: number) {
    const rows = await this.orm
      .select({
        updateId: schema.noteUpdates.updateId,
        noteId: schema.noteUpdates.noteId,
        cryptoOwnerId: schema.noteUpdates.cryptoOwnerId,
        keyEpoch: schema.noteUpdates.keyEpoch,
        formatVersion: schema.noteUpdates.formatVersion,
        cipher: schema.noteUpdates.cipher,
        nonce: schema.noteUpdates.nonce,
        kind: schema.noteUpdates.kind,
        compactedUpdateIds: schema.noteUpdates.compactedUpdateIds
      })
      .from(schema.noteUpdates)
      .where(
        and(
          eq(schema.noteUpdates.noteId, noteId),
          eq(schema.noteUpdates.keyEpoch, keyEpoch)
        )
      )
      .orderBy(schema.noteUpdates.createdAt, schema.noteUpdates.updateId);
    return (rows as LegacyHistoryRow[]).map(legacyHistoryMessage);
  }

  persist(input: PersistLegacyHistoryInput): Promise<LegacyHistoryPersistOutcome> {
    return this.orm.transaction(async (transaction) => {
      if (!(await activeSession(transaction, input.sessionId))) {
        return "forbidden" as const;
      }
      const access = await writeAccess(transaction, input.update.noteId, input.userId);
      if (
        access?.status !== "active" ||
        (access.role !== "owner" && access.role !== "editor") ||
        access.cryptoOwnerId !== input.update.cryptoOwnerId ||
        access.keyEpoch !== input.update.keyEpoch
      ) {
        return "forbidden" as const;
      }
      const existing = await transaction
        .select({ updateId: schema.noteUpdates.updateId })
        .from(schema.noteUpdates)
        .where(eq(schema.noteUpdates.updateId, input.update.updateId))
        .limit(1)
        .for("update");
      if (existing[0]) {
        return "duplicate" as const;
      }
      const storedUpdates = await transaction
        .select({
          updateId: schema.noteUpdates.updateId,
          cipher: schema.noteUpdates.cipher
        })
        .from(schema.noteUpdates)
        .where(
          and(
            eq(schema.noteUpdates.noteId, input.update.noteId),
            eq(schema.noteUpdates.keyEpoch, input.update.keyEpoch)
          )
        )
        .for("update");
      if (legacyStorageLimitExceeded(storedUpdates, input)) {
        return "storage-limit" as const;
      }
      const inserted = await transaction
        .insert(schema.noteUpdates)
        .values(legacyHistoryValues(input.update))
        .onConflictDoNothing()
        .returning({ updateId: schema.noteUpdates.updateId });
      if (inserted.length !== 1) {
        return "duplicate" as const;
      }
      if (input.update.type === "crdt-checkpoint") {
        if (input.update.compactedUpdateIds.length > 0) {
          await transaction
            .delete(schema.noteUpdates)
            .where(
              and(
                eq(schema.noteUpdates.noteId, input.update.noteId),
                eq(schema.noteUpdates.keyEpoch, input.update.keyEpoch),
                inArray(schema.noteUpdates.updateId, input.update.compactedUpdateIds)
              )
            );
        }
        await transaction
          .delete(schema.noteUpdates)
          .where(
            and(
              eq(schema.noteUpdates.noteId, input.update.noteId),
              lt(schema.noteUpdates.keyEpoch, input.update.keyEpoch)
            )
          );
      }
      return "inserted" as const;
    });
  }
}

async function activeSession(
  database: Pick<PostgresDatabase, "select">,
  sessionId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await database
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
  return Boolean(rows[0]);
}

async function writeAccess(
  database: Pick<PostgresDatabase, "select">,
  noteId: string,
  userId: string
): Promise<LegacyWriteAccess | null> {
  const rows = await database
    .select({
      cryptoOwnerId: schema.notes.cryptoOwnerId,
      keyEpoch: schema.notes.keyEpoch,
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
