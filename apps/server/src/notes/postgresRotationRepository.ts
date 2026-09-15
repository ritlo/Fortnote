import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "./events.js";
import type {
  LinkedNoteRotationInput,
  LinkedNoteRotationOutcome,
  NoteRotationRepository
} from "./rotationRepository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export class PostgresNoteRotationRepository implements NoteRotationRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  rotateLinked(input: LinkedNoteRotationInput): Promise<LinkedNoteRotationOutcome> {
    return this.orm.transaction(async (transaction) => {
      const currentRows = await transaction
        .select({
          noteId: schema.notes.id,
          version: schema.notes.version,
          rootVersion: schema.notes.rootVersion,
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
            eq(schema.notes.id, input.noteId),
            eq(schema.noteMemberships.userId, input.actorUserId)
          )
        )
        .limit(1)
        .for("update");
      const current = currentRows[0];
      if (current?.role !== "owner" || current.status !== "active") {
        return { kind: "not-found" } as const;
      }
      if (
        current.isDeleted ||
        current.rotationFenced ||
        current.rootVersion !== input.rootVersion ||
        current.keyEpoch !== input.sourceEpoch ||
        input.targetEpoch !== input.sourceEpoch + 1
      ) {
        return { kind: "conflict" } as const;
      }

      const members = await transaction
        .select({
          userId: schema.noteMemberships.userId,
          role: schema.noteMemberships.role,
          status: schema.noteMemberships.status
        })
        .from(schema.noteMemberships)
        .where(eq(schema.noteMemberships.noteId, current.noteId))
        .for("update");
      const revoked = members.find(
        (member) =>
          member.userId === input.revokedUserId &&
          member.status === "active" &&
          member.role !== "owner"
      );
      if (!revoked) {
        return { kind: "not-found" } as const;
      }
      const remainingIds = members
        .filter(
          (member) =>
            member.status === "active" &&
            member.role !== "owner" &&
            member.userId !== input.revokedUserId
        )
        .map((member) => member.userId);
      if (
        !sameMembers(
          remainingIds,
          input.shares.map((share) => share.recipientUserId)
        )
      ) {
        return { kind: "invalid-set" } as const;
      }
      for (const share of input.shares) {
        const trustedKeys = await transaction
          .select({ userId: schema.userSharingKeys.userId })
          .from(schema.userSharingKeys)
          .where(
            and(
              eq(schema.userSharingKeys.userId, share.recipientUserId),
              eq(schema.userSharingKeys.sharingKeyVersion, share.sharingKeyVersion)
            )
          )
          .limit(1);
        if (!trustedKeys[0]) {
          return { kind: "invalid-set" } as const;
        }
      }

      const fenced = await transaction
        .update(schema.notes)
        .set({ rotationFenced: true })
        .where(
          and(
            eq(schema.notes.id, current.noteId),
            eq(schema.notes.rootVersion, input.rootVersion),
            eq(schema.notes.keyEpoch, input.sourceEpoch),
            eq(schema.notes.rotationFenced, false)
          )
        )
        .returning({ id: schema.notes.id });
      if (fenced.length !== 1) {
        return { kind: "conflict" } as const;
      }
      const revokedMembership = await transaction
        .update(schema.noteMemberships)
        .set({ status: "revoked", updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(schema.noteMemberships.noteId, current.noteId),
            eq(schema.noteMemberships.userId, input.revokedUserId),
            eq(schema.noteMemberships.status, "active"),
            ne(schema.noteMemberships.role, "owner")
          )
        )
        .returning({ userId: schema.noteMemberships.userId });
      if (revokedMembership.length !== 1) {
        throw new Error("Linked rotation membership changed after validation");
      }
      await transaction
        .delete(schema.noteKeyShares)
        .where(
          and(
            eq(schema.noteKeyShares.noteId, current.noteId),
            eq(schema.noteKeyShares.recipientUserId, input.revokedUserId)
          )
        );
      for (const share of input.shares) {
        await transaction
          .insert(schema.noteKeyShares)
          .values({
            noteId: current.noteId,
            recipientUserId: share.recipientUserId,
            senderUserId: input.actorUserId,
            sharingKeyVersion: share.sharingKeyVersion,
            encryptedNoteKey: share.encryptedNoteKey,
            formatVersion: share.formatVersion
          })
          .onConflictDoUpdate({
            target: [schema.noteKeyShares.noteId, schema.noteKeyShares.recipientUserId],
            set: {
              senderUserId: input.actorUserId,
              sharingKeyVersion: share.sharingKeyVersion,
              encryptedNoteKey: share.encryptedNoteKey,
              formatVersion: share.formatVersion,
              createdAt: sql`CURRENT_TIMESTAMP`
            }
          });
      }
      await transaction.insert(schema.noteEpochLinks).values({
        noteId: current.noteId,
        sourceEpoch: input.sourceEpoch,
        targetEpoch: input.targetEpoch,
        previousKeyCipher: input.previousKeyCipher,
        nonce: input.previousKeyNonce,
        formatVersion: input.linkFormatVersion
      });
      const rotated = await transaction
        .update(schema.notes)
        .set({
          encryptedNoteKey: input.encryptedNoteKey,
          noteKeyNonce: input.noteKeyNonce,
          noteKeyFormatVersion: input.noteKeyFormatVersion,
          titleCipher: input.titleCipher,
          titleNonce: input.titleNonce,
          titleFormatVersion: input.titleFormatVersion,
          keyEpoch: input.targetEpoch,
          rootVersion: sql`${schema.notes.rootVersion} + 1`,
          version: sql`${schema.notes.version} + 1`,
          rotationFenced: false,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(eq(schema.notes.id, current.noteId), eq(schema.notes.rotationFenced, true))
        )
        .returning({ id: schema.notes.id });
      if (rotated.length !== 1) {
        throw new Error("Linked rotation note changed after fencing");
      }
      const events = await transaction
        .insert(schema.noteEvents)
        .values({
          eventId: randomUUID(),
          resourceType: "membership",
          resourceId: `${current.noteId}:${input.revokedUserId}`,
          noteId: current.noteId,
          actorUserId: input.actorUserId,
          eventType: "membership.revoked",
          noteVersion: current.version + 1,
          payloadMetadata: serializedEventMetadata(
            {
              membershipUserId: input.revokedUserId,
              targetEpoch: input.targetEpoch
            },
            input.clientInstanceId
          )
        })
        .returning({ cursor: schema.noteEvents.cursor });
      const event = events[0];
      if (!event) {
        throw new Error("Linked rotation event insert did not return a cursor");
      }
      return {
        kind: "rotated",
        eventCursor: event.cursor,
        version: current.version + 1,
        rootVersion: current.rootVersion + 1,
        keyEpoch: input.targetEpoch
      } as const;
    });
  }
}
