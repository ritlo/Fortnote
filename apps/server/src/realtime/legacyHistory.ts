import type { EncryptedCrdtMessage } from "@fortnote/shared";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

export type LegacyHistoryPersistOutcome =
  | "inserted"
  | "duplicate"
  | "storage-limit"
  | "forbidden";

export interface PersistLegacyHistoryInput {
  sessionId: string;
  userId: string;
  update: EncryptedCrdtMessage;
  maxEnvelopes: number;
  maxBytes: number;
}

export interface LegacyHistoryRepository {
  list(noteId: string, keyEpoch: number): Promise<EncryptedCrdtMessage[]>;
  persist(input: PersistLegacyHistoryInput): Promise<LegacyHistoryPersistOutcome>;
}

export interface LegacyHistoryRow {
  updateId: string;
  noteId: string;
  cryptoOwnerId: string;
  keyEpoch: number;
  formatVersion: number;
  cipher: string;
  nonce: string;
  kind: string;
  compactedUpdateIds: string | null;
}

interface LegacyWriteAccess {
  cryptoOwnerId: string;
  keyEpoch: number;
  role: string;
  status: string;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

export class SqliteLegacyHistoryRepository implements LegacyHistoryRepository {
  constructor(private readonly orm: SqliteDatabase) {}

  list(noteId: string, keyEpoch: number): Promise<EncryptedCrdtMessage[]> {
    const rows = this.orm
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
      .orderBy(schema.noteUpdates.createdAt, schema.noteUpdates.updateId)
      .all();
    return Promise.resolve(rows.map(legacyHistoryMessage));
  }

  persist(input: PersistLegacyHistoryInput): Promise<LegacyHistoryPersistOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      if (!activeSession(transaction, input.sessionId)) {
        return "forbidden" as const;
      }
      const access = writeAccess(
        transaction,
        input.update.noteId,
        input.userId
      );
      if (
        access?.status !== "active" ||
        (access.role !== "owner" && access.role !== "editor") ||
        access.cryptoOwnerId !== input.update.cryptoOwnerId ||
        access.keyEpoch !== input.update.keyEpoch
      ) {
        return "forbidden" as const;
      }
      const existing = transaction
        .select({ updateId: schema.noteUpdates.updateId })
        .from(schema.noteUpdates)
        .where(eq(schema.noteUpdates.updateId, input.update.updateId))
        .get();
      if (existing) {
        return "duplicate" as const;
      }
      const storedUpdates = transaction
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
        .all();
      if (legacyStorageLimitExceeded(storedUpdates, input)) {
        return "storage-limit" as const;
      }
      const result = transaction
        .insert(schema.noteUpdates)
        .values(legacyHistoryValues(input.update))
        .onConflictDoNothing()
        .run();
      if (result.changes === 0) {
        return "duplicate" as const;
      }
      compactLegacyHistory(transaction, input.update);
      return "inserted" as const;
    });
    return Promise.resolve(outcome);
  }
}

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

function writeAccess(
  database: Pick<SqliteDatabase, "select">,
  noteId: string,
  userId: string
): LegacyWriteAccess | null {
  return database
    .select({
      cryptoOwnerId: schema.notes.cryptoOwnerId,
      keyEpoch: schema.notes.keyEpoch,
      role: schema.noteMemberships.role,
      status: schema.noteMemberships.status
    })
    .from(schema.notes)
    .innerJoin(
      schema.noteMemberships,
      eq(schema.noteMemberships.noteId, schema.notes.id)
    )
    .where(
      and(
        eq(schema.notes.id, noteId),
        eq(schema.noteMemberships.userId, userId)
      )
    )
    .get() ?? null;
}

export function legacyStorageLimitExceeded(
  storedUpdates: { updateId: string; cipher: string }[],
  input: Pick<PersistLegacyHistoryInput, "update" | "maxEnvelopes" | "maxBytes">
): boolean {
  const compactedIds = new Set(
    input.update.type === "crdt-checkpoint"
      ? input.update.compactedUpdateIds
      : []
  );
  const compactedUpdates = storedUpdates.filter(({ updateId }) =>
    compactedIds.has(updateId)
  );
  const storedBytes = storedUpdates.reduce(
    (total, stored) => total + Buffer.byteLength(stored.cipher, "utf8"),
    0
  );
  const compactedBytes = compactedUpdates.reduce(
    (total, stored) => total + Buffer.byteLength(stored.cipher, "utf8"),
    0
  );
  return (
    storedUpdates.length + 1 - compactedUpdates.length > input.maxEnvelopes ||
    storedBytes + Buffer.byteLength(input.update.cipher, "utf8") - compactedBytes >
      input.maxBytes
  );
}

export function legacyHistoryValues(update: EncryptedCrdtMessage) {
  return {
    updateId: update.updateId,
    noteId: update.noteId,
    cryptoOwnerId: update.cryptoOwnerId,
    keyEpoch: update.keyEpoch,
    formatVersion: update.formatVersion,
    cipher: update.cipher,
    nonce: update.nonce,
    kind: update.type === "crdt-checkpoint" ? "checkpoint" : "update",
    compactedUpdateIds:
      update.type === "crdt-checkpoint"
        ? JSON.stringify(update.compactedUpdateIds)
        : null
  };
}

function compactLegacyHistory(
  transaction: Pick<SqliteDatabase, "delete">,
  update: EncryptedCrdtMessage
): void {
  if (update.type !== "crdt-checkpoint") {
    return;
  }
  if (update.compactedUpdateIds.length > 0) {
    transaction
      .delete(schema.noteUpdates)
      .where(
        and(
          eq(schema.noteUpdates.noteId, update.noteId),
          eq(schema.noteUpdates.keyEpoch, update.keyEpoch),
          inArray(schema.noteUpdates.updateId, update.compactedUpdateIds)
        )
      )
      .run();
  }
  transaction
    .delete(schema.noteUpdates)
    .where(
      and(
        eq(schema.noteUpdates.noteId, update.noteId),
        lt(schema.noteUpdates.keyEpoch, update.keyEpoch)
      )
    )
    .run();
}

export function legacyHistoryMessage(row: LegacyHistoryRow): EncryptedCrdtMessage {
  const envelope = {
    formatVersion: row.formatVersion as 1,
    updateId: row.updateId,
    noteId: row.noteId,
    cryptoOwnerId: row.cryptoOwnerId,
    keyEpoch: row.keyEpoch,
    cipher: row.cipher,
    nonce: row.nonce
  };
  return row.kind === "checkpoint"
    ? {
        ...envelope,
        type: "crdt-checkpoint",
        compactedUpdateIds: JSON.parse(row.compactedUpdateIds ?? "[]") as string[]
      }
    : { ...envelope, type: "crdt-update" };
}
