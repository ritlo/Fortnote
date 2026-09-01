import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "../notes/events.js";

export type AttachmentGateError =
  | "conflict"
  | "duplicate"
  | "not-found"
  | "quota"
  | "rotation-pending"
  | "stale-epoch"
  | "unauthorized";

export type AttachmentReservationOutcome =
  | {
      kind: "reserved";
      expectedKeyEpoch: number;
      ownerUserId: string;
    }
  | { kind: AttachmentGateError };

export interface ReserveAttachmentUploadInput {
  noteId: string;
  userId: string;
  attachmentId: string;
  size: number;
  expectedKeyEpoch?: number;
  storageQuotaBytes: number;
}

export interface CommitAttachmentUploadInput {
  sessionId: string;
  actorUserId: string;
  noteId: string;
  ownerUserId: string;
  expectedKeyEpoch: number;
  storageKey: string;
  attachment: {
    id: string;
    size: number;
    filename: string;
    mimeType: string;
    metadataCipher: string | null;
    metadataNonce: string | null;
    metadataFormatVersion: number | null;
    encryptedAttachmentKey: string;
    attachmentKeyNonce: string;
    fileNonce: string;
  };
  clientInstanceId?: string;
}

export type CommitAttachmentUploadOutcome =
  | { kind: "committed"; cursor: number }
  | { kind: AttachmentGateError };

export interface DeleteAttachmentInput {
  attachmentId: string;
  noteId: string;
  ownerUserId: string;
  size: number;
  actorUserId: string;
  noteVersion: number;
  clientInstanceId?: string;
}

export type DeleteAttachmentOutcome =
  | { kind: "deleted"; cursor: number }
  | { kind: "not-found" };

export interface AttachmentMutationRepository {
  reserve(
    input: ReserveAttachmentUploadInput
  ): Promise<AttachmentReservationOutcome>;
  commit(
    input: CommitAttachmentUploadInput
  ): Promise<CommitAttachmentUploadOutcome>;
  release(ownerUserId: string, size: number): Promise<void>;
  delete(input: DeleteAttachmentInput): Promise<DeleteAttachmentOutcome>;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

function attachmentMutationState(
  db: Pick<SqliteDatabase, "select">,
  noteId: string,
  userId: string
) {
  return db
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
    .get();
}

function canMutateAttachment(
  state: ReturnType<typeof attachmentMutationState>
): state is NonNullable<typeof state> {
  return (
    state?.status === "active" &&
    (state.role === "owner" || state.role === "editor")
  );
}

export class SqliteAttachmentMutationRepository
  implements AttachmentMutationRepository
{
  constructor(private readonly orm: SqliteDatabase) {}

  reserve(
    input: ReserveAttachmentUploadInput
  ): Promise<AttachmentReservationOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const current = attachmentMutationState(
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
      const duplicate = transaction
        .select({ id: schema.attachments.id })
        .from(schema.attachments)
        .where(eq(schema.attachments.id, input.attachmentId))
        .get();
      if (duplicate) {
        return { kind: "duplicate" as const };
      }

      transaction
        .insert(schema.storageAccounts)
        .values({ userId: current.ownerUserId })
        .onConflictDoNothing()
        .run();
      const reserved = transaction
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
        .run();
      if (reserved.changes !== 1) {
        return { kind: "quota" as const };
      }
      return {
        kind: "reserved" as const,
        expectedKeyEpoch,
        ownerUserId: current.ownerUserId
      };
    });
    return Promise.resolve(outcome);
  }

  commit(
    input: CommitAttachmentUploadInput
  ): Promise<CommitAttachmentUploadOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const now = new Date().toISOString();
      const activeSession = transaction
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, input.sessionId),
            gt(schema.sessions.idleExpiresAt, now),
            gt(schema.sessions.absoluteExpiresAt, now)
          )
        )
        .get();
      if (!activeSession) {
        return { kind: "unauthorized" as const };
      }
      const current = attachmentMutationState(
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
      const duplicate = transaction
        .select({ id: schema.attachments.id })
        .from(schema.attachments)
        .where(eq(schema.attachments.id, input.attachment.id))
        .get();
      if (duplicate) {
        return { kind: "duplicate" as const };
      }
      const quota = transaction
        .select({ reservedBytes: schema.storageAccounts.reservedBytes })
        .from(schema.storageAccounts)
        .where(eq(schema.storageAccounts.userId, input.ownerUserId))
        .get();
      if (!quota || quota.reservedBytes < input.attachment.size) {
        return { kind: "quota" as const };
      }

      transaction
        .insert(schema.attachments)
        .values({
          ...input.attachment,
          noteId: current.noteId,
          userId: input.ownerUserId,
          keyEpoch: input.expectedKeyEpoch,
          storageKey: input.storageKey
        })
        .run();
      transaction
        .update(schema.storageAccounts)
        .set({
          usedBytes: sql`${schema.storageAccounts.usedBytes} + ${input.attachment.size}`,
          reservedBytes: sql`${schema.storageAccounts.reservedBytes} - ${input.attachment.size}`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(schema.storageAccounts.userId, input.ownerUserId))
        .run();
      const cursor = transaction
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
        .returning({ cursor: schema.noteEvents.cursor })
        .get().cursor;
      return { kind: "committed" as const, cursor };
    });
    return Promise.resolve(outcome);
  }

  release(ownerUserId: string, size: number): Promise<void> {
    this.orm
      .update(schema.storageAccounts)
      .set({
        reservedBytes: sql`MAX(${schema.storageAccounts.reservedBytes} - ${size}, 0)`,
        updatedAt: sql`CURRENT_TIMESTAMP`
      })
      .where(eq(schema.storageAccounts.userId, ownerUserId))
      .run();
    return Promise.resolve();
  }

  delete(input: DeleteAttachmentInput): Promise<DeleteAttachmentOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const deleted = transaction
        .delete(schema.attachments)
        .where(
          and(
            eq(schema.attachments.id, input.attachmentId),
            eq(schema.attachments.noteId, input.noteId),
            eq(schema.attachments.userId, input.ownerUserId)
          )
        )
        .run();
      if (deleted.changes !== 1) {
        return { kind: "not-found" as const };
      }
      transaction
        .update(schema.storageAccounts)
        .set({
          usedBytes: sql`MAX(${schema.storageAccounts.usedBytes} - ${input.size}, 0)`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(schema.storageAccounts.userId, input.ownerUserId))
        .run();
      const cursor = transaction
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
        .returning({ cursor: schema.noteEvents.cursor })
        .get().cursor;
      return { kind: "deleted" as const, cursor };
    });
    return Promise.resolve(outcome);
  }
}
