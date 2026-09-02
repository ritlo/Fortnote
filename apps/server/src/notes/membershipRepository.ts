import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "./events.js";

export type EditableMemberRole = "editor" | "viewer";

export interface InviteNoteMemberInput {
  noteId: string;
  actorUserId: string;
  noteVersion: number;
  username: string;
  role: EditableMemberRole;
  sharingKeyVersion: number;
  encryptedNoteKey: string;
  formatVersion: number;
  clientInstanceId?: string;
}

export type InviteNoteMemberOutcome =
  | { status: "invited"; cursor: number; userId: string; username: string }
  | { status: "note_not_found" }
  | { status: "sharing_key_not_found" }
  | { status: "self" }
  | { status: "owner" };

export interface ChangeNoteMemberInput {
  noteId: string;
  actorUserId: string;
  targetUserId: string;
  noteVersion: number;
  clientInstanceId?: string;
}

export interface UpdateNoteMemberRoleInput extends ChangeNoteMemberInput {
  role: EditableMemberRole;
}

export interface NoteMembershipRepository {
  invite(input: InviteNoteMemberInput): Promise<InviteNoteMemberOutcome>;
  updateRole(input: UpdateNoteMemberRoleInput): Promise<number | null>;
  revoke(input: ChangeNoteMemberInput): Promise<number | null>;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

export class SqliteNoteMembershipRepository
  implements NoteMembershipRepository
{
  constructor(private readonly orm: SqliteDatabase) {}

  invite(input: InviteNoteMemberInput): Promise<InviteNoteMemberOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const note = transaction
        .select({ id: schema.notes.id })
        .from(schema.notes)
        .where(eq(schema.notes.id, input.noteId))
        .get();
      if (!note) {
        return { status: "note_not_found" } as const;
      }
      const recipient = transaction
        .select({ userId: schema.users.id, username: schema.users.username })
        .from(schema.users)
        .innerJoin(
          schema.userSharingKeys,
          eq(schema.userSharingKeys.userId, schema.users.id)
        )
        .where(
          and(
            eq(schema.users.username, input.username),
            eq(
              schema.userSharingKeys.sharingKeyVersion,
              input.sharingKeyVersion
            )
          )
        )
        .get();
      if (!recipient) {
        return { status: "sharing_key_not_found" } as const;
      }
      if (recipient.userId === input.actorUserId) {
        return { status: "self" } as const;
      }

      const existing = transaction
        .select({ role: schema.noteMemberships.role })
        .from(schema.noteMemberships)
        .where(
          and(
            eq(schema.noteMemberships.noteId, input.noteId),
            eq(schema.noteMemberships.userId, recipient.userId)
          )
        )
        .get();
      if (existing?.role === "owner") {
        return { status: "owner" } as const;
      }

      transaction
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
        })
        .run();
      transaction
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
          target: [
            schema.noteKeyShares.noteId,
            schema.noteKeyShares.recipientUserId
          ],
          set: {
            senderUserId: input.actorUserId,
            sharingKeyVersion: input.sharingKeyVersion,
            encryptedNoteKey: input.encryptedNoteKey,
            formatVersion: input.formatVersion,
            createdAt: sql`CURRENT_TIMESTAMP`
          }
        })
        .run();
      const cursor = transaction
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
        .returning({ cursor: schema.noteEvents.cursor })
        .get().cursor;
      return {
        status: "invited",
        cursor,
        userId: recipient.userId,
        username: recipient.username
      } as const;
    });
    return Promise.resolve(outcome);
  }

  updateRole(input: UpdateNoteMemberRoleInput): Promise<number | null> {
    const cursor = this.orm.transaction((transaction) => {
      const updated = transaction
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
        .run();
      if (updated.changes === 0) {
        return null;
      }
      return transaction
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
        .returning({ cursor: schema.noteEvents.cursor })
        .get().cursor;
    });
    return Promise.resolve(cursor);
  }

  revoke(input: ChangeNoteMemberInput): Promise<number | null> {
    const cursor = this.orm.transaction((transaction) => {
      const updated = transaction
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
        .run();
      if (updated.changes === 0) {
        return null;
      }
      transaction
        .delete(schema.noteKeyShares)
        .where(
          and(
            eq(schema.noteKeyShares.noteId, input.noteId),
            eq(schema.noteKeyShares.recipientUserId, input.targetUserId)
          )
        )
        .run();
      return transaction
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
        .returning({ cursor: schema.noteEvents.cursor })
        .get().cursor;
    });
    return Promise.resolve(cursor);
  }
}
