import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "./events.js";

export interface RotatedNoteKeyShare {
  recipientUserId: string;
  sharingKeyVersion: number;
  encryptedNoteKey: string;
  formatVersion: number;
}

export interface RotatedAttachmentKey {
  attachmentId: string;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
}

interface RotationInput {
  noteId: string;
  actorUserId: string;
  clientInstanceId?: string;
}

export interface LinkedNoteRotationInput extends RotationInput {
  revokedUserId: string;
  rootVersion: number;
  sourceEpoch: number;
  targetEpoch: number;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  noteKeyFormatVersion: number;
  titleCipher: string;
  titleNonce: string;
  titleFormatVersion: number;
  previousKeyCipher: string;
  previousKeyNonce: string;
  linkFormatVersion: number;
  shares: RotatedNoteKeyShare[];
}

export type LinkedNoteRotationOutcome =
  | {
      kind: "rotated";
      eventCursor: number;
      version: number;
      rootVersion: number;
      keyEpoch: number;
    }
  | { kind: "not-found" }
  | { kind: "invalid-set" }
  | { kind: "conflict" };

export interface LegacyNoteRotationInput extends RotationInput {
  encryptedNoteKey: string;
  noteKeyNonce: string;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
  version: number;
  shares: RotatedNoteKeyShare[];
  attachmentKeys: RotatedAttachmentKey[];
}

export type LegacyNoteRotationOutcome =
  | {
      kind: "rotated";
      eventCursor: number;
      version: number;
      keyEpoch: number;
    }
  | { kind: "not-found" }
  | { kind: "deleted" }
  | { kind: "conflict" }
  | { kind: "invalid-members" }
  | { kind: "invalid-sharing-key" }
  | { kind: "invalid-attachments" };

export interface NoteRotationRepository {
  rotateLinked(input: LinkedNoteRotationInput): Promise<LinkedNoteRotationOutcome>;
  rotateLegacy(input: LegacyNoteRotationInput): Promise<LegacyNoteRotationOutcome>;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export class SqliteNoteRotationRepository implements NoteRotationRepository {
  constructor(private readonly orm: SqliteDatabase) {}

  rotateLinked(input: LinkedNoteRotationInput): Promise<LinkedNoteRotationOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const current = transaction
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
        .get();
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

      const members = transaction
        .select({
          userId: schema.noteMemberships.userId,
          role: schema.noteMemberships.role,
          status: schema.noteMemberships.status
        })
        .from(schema.noteMemberships)
        .where(eq(schema.noteMemberships.noteId, current.noteId))
        .all();
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
        const trustedKey = transaction
          .select({ userId: schema.userSharingKeys.userId })
          .from(schema.userSharingKeys)
          .where(
            and(
              eq(schema.userSharingKeys.userId, share.recipientUserId),
              eq(
                schema.userSharingKeys.sharingKeyVersion,
                share.sharingKeyVersion
              )
            )
          )
          .get();
        if (!trustedKey) {
          return { kind: "invalid-set" } as const;
        }
      }

      const fenced = transaction
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
        .run();
      if (fenced.changes !== 1) {
        return { kind: "conflict" } as const;
      }
      const revokedMembership = transaction
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
        .run();
      if (revokedMembership.changes !== 1) {
        throw new Error("Linked rotation membership changed after validation");
      }
      transaction
        .delete(schema.noteKeyShares)
        .where(
          and(
            eq(schema.noteKeyShares.noteId, current.noteId),
            eq(schema.noteKeyShares.recipientUserId, input.revokedUserId)
          )
        )
        .run();
      for (const share of input.shares) {
        transaction
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
            target: [
              schema.noteKeyShares.noteId,
              schema.noteKeyShares.recipientUserId
            ],
            set: {
              senderUserId: input.actorUserId,
              sharingKeyVersion: share.sharingKeyVersion,
              encryptedNoteKey: share.encryptedNoteKey,
              formatVersion: share.formatVersion,
              createdAt: sql`CURRENT_TIMESTAMP`
            }
          })
          .run();
      }
      transaction
        .insert(schema.noteEpochLinks)
        .values({
          noteId: current.noteId,
          sourceEpoch: input.sourceEpoch,
          targetEpoch: input.targetEpoch,
          previousKeyCipher: input.previousKeyCipher,
          nonce: input.previousKeyNonce,
          formatVersion: input.linkFormatVersion
        })
        .run();
      const rotated = transaction
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
          and(
            eq(schema.notes.id, current.noteId),
            eq(schema.notes.rotationFenced, true)
          )
        )
        .run();
      if (rotated.changes !== 1) {
        throw new Error("Linked rotation note changed after fencing");
      }
      const event = transaction
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
        .returning({ cursor: schema.noteEvents.cursor })
        .get();
      return {
        kind: "rotated",
        eventCursor: event.cursor,
        version: current.version + 1,
        rootVersion: current.rootVersion + 1,
        keyEpoch: input.targetEpoch
      } as const;
    });
    return Promise.resolve(outcome);
  }

  rotateLegacy(input: LegacyNoteRotationInput): Promise<LegacyNoteRotationOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const current = transaction
        .select({
          noteId: schema.notes.id,
          version: schema.notes.version,
          keyEpoch: schema.notes.keyEpoch,
          isDeleted: schema.notes.isDeleted,
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
        .get();
      if (current?.role !== "owner" || current.status !== "active") {
        return { kind: "not-found" } as const;
      }
      if (current.isDeleted) {
        return { kind: "deleted" } as const;
      }
      if (current.version !== input.version) {
        return { kind: "conflict" } as const;
      }

      const members = transaction
        .select({ userId: schema.noteMemberships.userId })
        .from(schema.noteMemberships)
        .where(
          and(
            eq(schema.noteMemberships.noteId, current.noteId),
            eq(schema.noteMemberships.status, "active"),
            ne(schema.noteMemberships.role, "owner")
          )
        )
        .all();
      if (
        !sameMembers(
          members.map((member) => member.userId),
          input.shares.map((share) => share.recipientUserId)
        )
      ) {
        return { kind: "invalid-members" } as const;
      }
      for (const share of input.shares) {
        const trustedKey = transaction
          .select({ userId: schema.userSharingKeys.userId })
          .from(schema.userSharingKeys)
          .where(
            and(
              eq(schema.userSharingKeys.userId, share.recipientUserId),
              eq(
                schema.userSharingKeys.sharingKeyVersion,
                share.sharingKeyVersion
              )
            )
          )
          .get();
        if (!trustedKey) {
          return { kind: "invalid-sharing-key" } as const;
        }
      }

      const attachments = transaction
        .select({ id: schema.attachments.id })
        .from(schema.attachments)
        .where(eq(schema.attachments.noteId, current.noteId))
        .all();
      if (
        !sameMembers(
          attachments.map((attachment) => attachment.id),
          input.attachmentKeys.map((attachment) => attachment.attachmentId)
        )
      ) {
        return { kind: "invalid-attachments" } as const;
      }

      const rotated = transaction
        .update(schema.notes)
        .set({
          encryptedNoteKey: input.encryptedNoteKey,
          noteKeyNonce: input.noteKeyNonce,
          contentCipher: input.contentCipher,
          contentNonce: input.contentNonce,
          contentLength: input.contentLength,
          contentUpdatedAt: sql`CURRENT_TIMESTAMP`,
          version: sql`${schema.notes.version} + 1`,
          keyEpoch: sql`${schema.notes.keyEpoch} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.notes.id, current.noteId),
            eq(schema.notes.version, input.version)
          )
        )
        .run();
      if (rotated.changes !== 1) {
        return { kind: "conflict" } as const;
      }
      for (const share of input.shares) {
        transaction
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
            target: [
              schema.noteKeyShares.noteId,
              schema.noteKeyShares.recipientUserId
            ],
            set: {
              senderUserId: input.actorUserId,
              sharingKeyVersion: share.sharingKeyVersion,
              encryptedNoteKey: share.encryptedNoteKey,
              formatVersion: share.formatVersion,
              createdAt: sql`CURRENT_TIMESTAMP`
            }
          })
          .run();
      }
      for (const attachmentKey of input.attachmentKeys) {
        const updated = transaction
          .update(schema.attachments)
          .set({
            encryptedAttachmentKey: attachmentKey.encryptedAttachmentKey,
            attachmentKeyNonce: attachmentKey.attachmentKeyNonce
          })
          .where(
            and(
              eq(schema.attachments.id, attachmentKey.attachmentId),
              eq(schema.attachments.noteId, current.noteId)
            )
          )
          .run();
        if (updated.changes !== 1) {
          throw new Error("Legacy rotation attachment changed after validation");
        }
      }
      const event = transaction
        .insert(schema.noteEvents)
        .values({
          eventId: randomUUID(),
          resourceType: "note",
          resourceId: current.noteId,
          noteId: current.noteId,
          actorUserId: input.actorUserId,
          eventType: "note.updated",
          noteVersion: current.version + 1,
          payloadMetadata: serializedEventMetadata(
            { keyRotated: true },
            input.clientInstanceId
          )
        })
        .returning({ cursor: schema.noteEvents.cursor })
        .get();
      return {
        kind: "rotated",
        eventCursor: event.cursor,
        version: current.version + 1,
        keyEpoch: current.keyEpoch + 1
      } as const;
    });
    return Promise.resolve(outcome);
  }
}
