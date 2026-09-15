import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "./events.js";
import type {
  NoteLifecycleRepository,
  PermanentlyDeleteNoteInput,
  PermanentlyDeleteNoteOutcome,
  SetNoteDeletedInput
} from "./lifecycleRepository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

export class PostgresNoteLifecycleRepository implements NoteLifecycleRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  setDeleted(input: SetNoteDeletedInput): Promise<number | null> {
    return this.orm.transaction(async (transaction) => {
      const updated = await transaction
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
        .returning({ id: schema.notes.id });
      if (updated.length !== 1) {
        return null;
      }

      const events = await transaction
        .insert(schema.noteEvents)
        .values({
          eventId: randomUUID(),
          resourceType: "note",
          resourceId: input.noteId,
          noteId: input.noteId,
          actorUserId: input.actorUserId,
          eventType: input.deleted ? "note.deleted" : "note.restored",
          noteVersion: input.noteVersion,
          payloadMetadata: serializedEventMetadata(undefined, input.clientInstanceId)
        })
        .returning({ cursor: schema.noteEvents.cursor });
      const event = events[0];
      if (!event) {
        throw new Error("Note lifecycle event insert did not return a cursor");
      }
      return event.cursor;
    });
  }

  permanentlyDelete(
    input: PermanentlyDeleteNoteInput
  ): Promise<PermanentlyDeleteNoteOutcome | null> {
    return this.orm.transaction(async (transaction) => {
      const notes = await transaction
        .select({ id: schema.notes.id })
        .from(schema.notes)
        .where(
          and(
            eq(schema.notes.id, input.noteId),
            eq(schema.notes.userId, input.ownerUserId)
          )
        )
        .limit(1)
        .for("update");
      if (!notes[0]) {
        return null;
      }

      const rows = await transaction
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
        .for("update");
      const members = await transaction
        .select({ userId: schema.noteMemberships.userId })
        .from(schema.noteMemberships)
        .where(
          and(
            eq(schema.noteMemberships.noteId, input.noteId),
            eq(schema.noteMemberships.status, "active")
          )
        )
        .for("update");
      await transaction
        .delete(schema.notes)
        .where(
          and(
            eq(schema.notes.id, input.noteId),
            eq(schema.notes.userId, input.ownerUserId)
          )
        );

      const attachmentBytes = rows.reduce((total, row) => total + row.size, 0);
      if (attachmentBytes > 0) {
        await transaction
          .update(schema.storageAccounts)
          .set({
            usedBytes: sql`GREATEST(${schema.storageAccounts.usedBytes} - ${attachmentBytes}, 0)`,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(eq(schema.storageAccounts.userId, input.ownerUserId));
      }
      const events = await transaction
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
        .returning({ cursor: schema.noteEvents.cursor });
      const event = events[0];
      if (!event) {
        throw new Error("Permanent delete event insert did not return a cursor");
      }
      return {
        cursor: event.cursor,
        storageKeys: rows.map(({ storageKey }) => storageKey)
      };
    });
  }
}
