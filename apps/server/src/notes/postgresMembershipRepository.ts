import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "./events.js";
import type {
  ChangeNoteMemberInput,
  InviteNoteMemberInput,
  InviteNoteMemberOutcome,
  NoteMembershipRepository,
  UpdateNoteMemberRoleInput
} from "./membershipRepository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

async function lockNote(
  db: Pick<PostgresDatabase, "select">,
  noteId: string
): Promise<boolean> {
  const notes = await db
    .select({ id: schema.notes.id })
    .from(schema.notes)
    .where(eq(schema.notes.id, noteId))
    .limit(1)
    .for("update");
  return Boolean(notes[0]);
}

export class PostgresNoteMembershipRepository implements NoteMembershipRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  invite(input: InviteNoteMemberInput): Promise<InviteNoteMemberOutcome> {
    return this.orm.transaction(async (transaction) => {
      if (!(await lockNote(transaction, input.noteId))) {
        return { status: "note_not_found" };
      }
      const recipients = await transaction
        .select({ userId: schema.users.id, username: schema.users.username })
        .from(schema.users)
        .innerJoin(
          schema.userSharingKeys,
          eq(schema.userSharingKeys.userId, schema.users.id)
        )
        .where(
          and(
            eq(schema.users.username, input.username),
            eq(schema.userSharingKeys.sharingKeyVersion, input.sharingKeyVersion)
          )
        )
        .limit(1)
        .for("update");
      const recipient = recipients[0];
      if (!recipient) {
        return { status: "sharing_key_not_found" };
      }
      if (recipient.userId === input.actorUserId) {
        return { status: "self" };
      }

      const memberships = await transaction
        .select({ role: schema.noteMemberships.role })
        .from(schema.noteMemberships)
        .where(
          and(
            eq(schema.noteMemberships.noteId, input.noteId),
            eq(schema.noteMemberships.userId, recipient.userId)
          )
        )
        .limit(1)
        .for("update");
      if (memberships[0]?.role === "owner") {
        return { status: "owner" };
      }

      await transaction
        .insert(schema.noteMemberships)
        .values({
          noteId: input.noteId,
          userId: recipient.userId,
          role: input.role,
          status: "active"
        })
        .onConflictDoUpdate({
          target: [schema.noteMemberships.noteId, schema.noteMemberships.userId],
          set: {
            role: input.role,
            status: "active",
            updatedAt: sql`CURRENT_TIMESTAMP`
          }
        });
      await transaction
        .insert(schema.noteKeyShares)
        .values({
          noteId: input.noteId,
          recipientUserId: recipient.userId,
          senderUserId: input.actorUserId,
          sharingKeyVersion: input.sharingKeyVersion,
          encryptedNoteKey: input.encryptedNoteKey,
          formatVersion: input.formatVersion
        })
        .onConflictDoUpdate({
          target: [schema.noteKeyShares.noteId, schema.noteKeyShares.recipientUserId],
          set: {
            senderUserId: input.actorUserId,
            sharingKeyVersion: input.sharingKeyVersion,
            encryptedNoteKey: input.encryptedNoteKey,
            formatVersion: input.formatVersion,
            createdAt: sql`CURRENT_TIMESTAMP`
          }
        });
      const events = await transaction
        .insert(schema.noteEvents)
        .values({
          eventId: randomUUID(),
          resourceType: "membership",
          resourceId: `${input.noteId}:${recipient.userId}`,
          noteId: input.noteId,
          actorUserId: input.actorUserId,
          eventType: "membership.added",
          noteVersion: input.noteVersion,
          payloadMetadata: serializedEventMetadata(
            { membershipUserId: recipient.userId, role: input.role },
            input.clientInstanceId
          )
        })
        .returning({ cursor: schema.noteEvents.cursor });
      const event = events[0];
      if (!event) {
        throw new Error("Membership invite event insert did not return a cursor");
      }
      return {
        status: "invited",
        cursor: event.cursor,
        userId: recipient.userId,
        username: recipient.username
      };
    });
  }

  updateRole(input: UpdateNoteMemberRoleInput): Promise<number | null> {
    return this.orm.transaction(async (transaction) => {
      if (!(await lockNote(transaction, input.noteId))) {
        return null;
      }
      const updated = await transaction
        .update(schema.noteMemberships)
        .set({ role: input.role, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(schema.noteMemberships.noteId, input.noteId),
            eq(schema.noteMemberships.userId, input.targetUserId),
            ne(schema.noteMemberships.role, "owner"),
            eq(schema.noteMemberships.status, "active")
          )
        )
        .returning({ userId: schema.noteMemberships.userId });
      if (updated.length === 0) {
        return null;
      }
      const events = await transaction
        .insert(schema.noteEvents)
        .values({
          eventId: randomUUID(),
          resourceType: "membership",
          resourceId: `${input.noteId}:${input.targetUserId}`,
          noteId: input.noteId,
          actorUserId: input.actorUserId,
          eventType: "membership.role_updated",
          noteVersion: input.noteVersion,
          payloadMetadata: serializedEventMetadata(
            { membershipUserId: input.targetUserId, role: input.role },
            input.clientInstanceId
          )
        })
        .returning({ cursor: schema.noteEvents.cursor });
      const event = events[0];
      if (!event) {
        throw new Error("Membership update event insert did not return a cursor");
      }
      return event.cursor;
    });
  }

  revoke(input: ChangeNoteMemberInput): Promise<number | null> {
    return this.orm.transaction(async (transaction) => {
      if (!(await lockNote(transaction, input.noteId))) {
        return null;
      }
      const updated = await transaction
        .update(schema.noteMemberships)
        .set({ status: "revoked", updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(schema.noteMemberships.noteId, input.noteId),
            eq(schema.noteMemberships.userId, input.targetUserId),
            ne(schema.noteMemberships.role, "owner"),
            ne(schema.noteMemberships.status, "revoked")
          )
        )
        .returning({ userId: schema.noteMemberships.userId });
      if (updated.length === 0) {
        return null;
      }
      await transaction
        .delete(schema.noteKeyShares)
        .where(
          and(
            eq(schema.noteKeyShares.noteId, input.noteId),
            eq(schema.noteKeyShares.recipientUserId, input.targetUserId)
          )
        );
      const events = await transaction
        .insert(schema.noteEvents)
        .values({
          eventId: randomUUID(),
          resourceType: "membership",
          resourceId: `${input.noteId}:${input.targetUserId}`,
          noteId: input.noteId,
          actorUserId: input.actorUserId,
          eventType: "membership.revoked",
          noteVersion: input.noteVersion,
          payloadMetadata: serializedEventMetadata(
            { membershipUserId: input.targetUserId },
            input.clientInstanceId
          )
        })
        .returning({ cursor: schema.noteEvents.cursor });
      const event = events[0];
      if (!event) {
        throw new Error("Membership revoke event insert did not return a cursor");
      }
      return event.cursor;
    });
  }
}
