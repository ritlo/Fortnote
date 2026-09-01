import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import { serializedEventMetadata } from "../notes/events.js";
import type {
  AttachmentMutationRepository,
  AttachmentReservationOutcome,
  CommitAttachmentUploadInput,
  CommitAttachmentUploadOutcome,
  DeleteAttachmentInput,
  ReserveAttachmentUploadInput
} from "./mutationRepository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

async function attachmentMutationState(
  db: Pick<PostgresDatabase, "select">,
  noteId: string,
  userId: string
) {
  const rows = await db
    .select({
      noteId: schema.notes.id,
      ownerUserId: schema.notes.userId,
      version: schema.notes.version,
      keyEpoch: schema.notes.keyEpoch,
      isDeleted: schema.notes.isDeleted,
      rotationFenced: schema.notes.rotationFenced,
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
    .limit(1)
    .for("update", { of: [schema.notes, schema.noteMemberships] });
  return rows[0];
}

function canMutateAttachment(
  state: Awaited<ReturnType<typeof attachmentMutationState>>
): state is NonNullable<typeof state> {
  return (
    state?.status === "active" &&
    (state.role === "owner" || state.role === "editor")
  );
}

export class PostgresAttachmentMutationRepository
  implements AttachmentMutationRepository
{
  constructor(private readonly orm: PostgresDatabase) {}

  reserve(
    input: ReserveAttachmentUploadInput
  ): Promise<AttachmentReservationOutcome> {
    return this.orm.transaction(async (transaction) => {
      const current = await attachmentMutationState(
        transaction,
        input.noteId,
        input.userId
      );
      if (!canMutateAttachment(current)) {
        return { kind: "not-found" as const };
      }
      if (current.isDeleted) {
        return { kind: "conflict" as const };
      }
      if (current.rotationFenced) {
        return { kind: "rotation-pending" as const };
      }
      const expectedKeyEpoch = input.expectedKeyEpoch ?? current.keyEpoch;
      if (current.keyEpoch !== expectedKeyEpoch) {
        return { kind: "stale-epoch" as const };
      }
      const duplicate = await transaction
        .select({ id: schema.attachments.id })
        .from(schema.attachments)
        .where(eq(schema.attachments.id, input.attachmentId))
        .limit(1);
      if (duplicate[0]) {
        return { kind: "duplicate" as const };
      }

      await transaction
        .insert(schema.storageAccounts)
        .values({ userId: current.ownerUserId })
        .onConflictDoNothing();
      const reserved = await transaction
        .update(schema.storageAccounts)
        .set({
          reservedBytes: sql`${schema.storageAccounts.reservedBytes} + ${input.size}`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.storageAccounts.userId, current.ownerUserId),
            sql`${schema.storageAccounts.usedBytes} + ${schema.storageAccounts.reservedBytes} + ${input.size} <= ${input.storageQuotaBytes}`
          )
        )
        .returning({ userId: schema.storageAccounts.userId });
      if (reserved.length !== 1) {
        return { kind: "quota" as const };
      }
      return {
        kind: "reserved" as const,
        expectedKeyEpoch,
        ownerUserId: current.ownerUserId
      };
    });
  }

  commit(
    input: CommitAttachmentUploadInput
  ): Promise<CommitAttachmentUploadOutcome> {
    return this.orm.transaction(async (transaction) => {
      const now = new Date().toISOString();
      const activeSession = await transaction
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, input.sessionId),
            gt(schema.sessions.idleExpiresAt, now),
            gt(schema.sessions.absoluteExpiresAt, now)
          )
        )
        .limit(1);
      if (!activeSession[0]) {
        return { kind: "unauthorized" as const };
      }
      const current = await attachmentMutationState(
        transaction,
        input.noteId,
        input.actorUserId
      );
      if (!canMutateAttachment(current)) {
        return { kind: "not-found" as const };
      }
      if (current.isDeleted) {
        return { kind: "conflict" as const };
      }
      if (current.rotationFenced) {
        return { kind: "rotation-pending" as const };
      }
      if (
        current.ownerUserId !== input.ownerUserId ||
        current.keyEpoch !== input.expectedKeyEpoch
      ) {
        return { kind: "stale-epoch" as const };
      }
      const duplicate = await transaction
        .select({ id: schema.attachments.id })
        .from(schema.attachments)
        .where(eq(schema.attachments.id, input.attachment.id))
        .limit(1);
      if (duplicate[0]) {
        return { kind: "duplicate" as const };
      }
      const quota = await transaction
        .select({ reservedBytes: schema.storageAccounts.reservedBytes })
        .from(schema.storageAccounts)
        .where(eq(schema.storageAccounts.userId, input.ownerUserId))
        .limit(1)
        .for("update");
      if (!quota[0] || quota[0].reservedBytes < input.attachment.size) {
        return { kind: "quota" as const };
      }

      await transaction.insert(schema.attachments).values({
        ...input.attachment,
        noteId: current.noteId,
        userId: input.ownerUserId,
        keyEpoch: input.expectedKeyEpoch,
        storageKey: input.storageKey
      });
      await transaction
        .update(schema.storageAccounts)
        .set({
          usedBytes: sql`${schema.storageAccounts.usedBytes} + ${input.attachment.size}`,
          reservedBytes: sql`${schema.storageAccounts.reservedBytes} - ${input.attachment.size}`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(schema.storageAccounts.userId, input.ownerUserId));
      const events = await transaction
        .insert(schema.noteEvents)
        .values({
          eventId: randomUUID(),
          resourceType: "attachment",
          resourceId: input.attachment.id,
          noteId: current.noteId,
          actorUserId: input.actorUserId,
          eventType: "attachment.created",
          noteVersion: current.version,
          payloadMetadata: serializedEventMetadata(
            {
              attachmentId: input.attachment.id,
              keyEpoch: input.expectedKeyEpoch
            },
            input.clientInstanceId
          )
        })
        .returning({ cursor: schema.noteEvents.cursor });
      const event = events[0];
      if (!event) {
        throw new Error("Attachment event insert did not return a cursor");
      }
      return { kind: "committed" as const, cursor: event.cursor };
    });
  }

  async release(ownerUserId: string, size: number): Promise<void> {
    await this.orm
      .update(schema.storageAccounts)
      .set({
        reservedBytes: sql`GREATEST(${schema.storageAccounts.reservedBytes} - ${size}, 0)`,
        updatedAt: sql`CURRENT_TIMESTAMP`
      })
      .where(eq(schema.storageAccounts.userId, ownerUserId));
  }

  delete(input: DeleteAttachmentInput): Promise<number> {
    return this.orm.transaction(async (transaction) => {
      await transaction
        .delete(schema.attachments)
        .where(eq(schema.attachments.id, input.attachmentId));
      await transaction
        .update(schema.storageAccounts)
        .set({
          usedBytes: sql`GREATEST(${schema.storageAccounts.usedBytes} - ${input.size}, 0)`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(schema.storageAccounts.userId, input.ownerUserId));
      const events = await transaction
        .insert(schema.noteEvents)
        .values({
          eventId: randomUUID(),
          resourceType: "attachment",
          resourceId: input.attachmentId,
          noteId: input.noteId,
          actorUserId: input.actorUserId,
          eventType: "attachment.deleted",
          noteVersion: input.noteVersion,
          payloadMetadata: serializedEventMetadata(
            { attachmentId: input.attachmentId },
            input.clientInstanceId
          )
        })
        .returning({ cursor: schema.noteEvents.cursor });
      const event = events[0];
      if (!event) {
        throw new Error("Attachment event insert did not return a cursor");
      }
      return event.cursor;
    });
  }
}
