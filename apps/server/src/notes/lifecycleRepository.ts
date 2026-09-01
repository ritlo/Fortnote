import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "./events.js";

export interface SetNoteDeletedInput {
  noteId: string;
  ownerUserId: string;
  actorUserId: string;
  noteVersion: number;
  deleted: boolean;
  clientInstanceId?: string;
}

export interface PermanentlyDeleteNoteInput {
  noteId: string;
  ownerUserId: string;
  actorUserId: string;
  noteVersion: number;
  clientInstanceId?: string;
}

export interface PermanentlyDeleteNoteOutcome {
  cursor: number;
  storageKeys: string[];
}

export interface NoteLifecycleRepository {
  setDeleted(input: SetNoteDeletedInput): Promise<number | null>;
  permanentlyDelete(
    input: PermanentlyDeleteNoteInput
  ): Promise<PermanentlyDeleteNoteOutcome | null>;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

export class SqliteNoteLifecycleRepository
  implements NoteLifecycleRepository
{
  constructor(private readonly orm: SqliteDatabase) {}

  setDeleted(input: SetNoteDeletedInput): Promise<number | null> {
    const cursor = this.orm.transaction((transaction) => {
      const updated = transaction
        .update(schema.notes)
        .set({
          isDeleted: input.deleted,
          deletedAt: input.deleted ? sql`CURRENT_TIMESTAMP` : null,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.notes.id, input.noteId),
            eq(schema.notes.userId, input.ownerUserId)
          )
        )
        .run();
      if (updated.changes !== 1) {
        return null;
      }

      return transaction
        .insert(schema.noteEvents)
        .values({
          eventId: randomUUID(),
          resourceType: "note",
          resourceId: input.noteId,
          noteId: input.noteId,
          actorUserId: input.actorUserId,
          eventType: input.deleted ? "note.deleted" : "note.restored",
          noteVersion: input.noteVersion,
          payloadMetadata: serializedEventMetadata(
            undefined,
            input.clientInstanceId
          )
        })
        .returning({ cursor: schema.noteEvents.cursor })
        .get().cursor;
    });
    return Promise.resolve(cursor);
  }

  permanentlyDelete(
    input: PermanentlyDeleteNoteInput
  ): Promise<PermanentlyDeleteNoteOutcome | null> {
    const outcome = this.orm.transaction((transaction) => {
      const rows = transaction
        .select({
          storageKey: schema.attachments.storageKey,
          size: schema.attachments.size
        })
        .from(schema.attachments)
        .where(
          and(
            eq(schema.attachments.noteId, input.noteId),
            eq(schema.attachments.userId, input.ownerUserId)
          )
        )
        .all();
      const members = transaction
        .select({ userId: schema.noteMemberships.userId })
        .from(schema.noteMemberships)
        .where(
          and(
            eq(schema.noteMemberships.noteId, input.noteId),
            eq(schema.noteMemberships.status, "active")
          )
        )
        .all();
      const deleted = transaction
        .delete(schema.notes)
        .where(
          and(
            eq(schema.notes.id, input.noteId),
            eq(schema.notes.userId, input.ownerUserId)
          )
        )
        .run();
      if (deleted.changes !== 1) {
        return null;
      }

      const attachmentBytes = rows.reduce((total, row) => total + row.size, 0);
      if (attachmentBytes > 0) {
        transaction
          .update(schema.storageAccounts)
          .set({
            usedBytes: sql`MAX(${schema.storageAccounts.usedBytes} - ${attachmentBytes}, 0)`,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(eq(schema.storageAccounts.userId, input.ownerUserId))
          .run();
      }
      const cursor = transaction
        .insert(schema.noteEvents)
        .values({
          eventId: randomUUID(),
          resourceType: "note",
          resourceId: input.noteId,
          noteId: input.noteId,
          actorUserId: input.actorUserId,
          eventType: "note.permanently_deleted",
          noteVersion: input.noteVersion,
          payloadMetadata: serializedEventMetadata(
            { visibleUserIds: members.map(({ userId }) => userId) },
            input.clientInstanceId
          )
        })
        .returning({ cursor: schema.noteEvents.cursor })
        .get().cursor;
      return {
        cursor,
        storageKeys: rows.map(({ storageKey }) => storageKey)
      };
    });
    return Promise.resolve(outcome);
  }
}
