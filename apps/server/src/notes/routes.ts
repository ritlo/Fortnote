import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import * as schema from "../db/schema.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { requireSession } from "../auth/session.js";
import { deleteEncryptedAttachment } from "../attachments/storage.js";
import { canEditNote, canOwnNote, canReadNote, getNoteAccess } from "./access.js";
import { writeRequestEvent } from "./events.js";

const createNoteSchema = z.object({
  id: z.uuid(),
  folderId: z.uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  encryptedNoteKey: z.string().min(16),
  noteKeyNonce: z.string().min(16),
  contentCipher: z.string().min(1),
  contentNonce: z.string().min(16),
  contentLength: z.number().int().nonnegative()
});

const updateNoteSchema = z.object({
  folderId: z.uuid().nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  contentCipher: z.string().min(1),
  contentNonce: z.string().min(16),
  contentLength: z.number().int().nonnegative(),
  version: z.number().int().positive()
});
const rotateNoteKeySchema = z.object({
  encryptedNoteKey: z.string().min(16),
  noteKeyNonce: z.string().min(16),
  contentCipher: z.string().min(1),
  contentNonce: z.string().min(16),
  contentLength: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  shares: z.array(
    z.object({
      recipientUserId: z.uuid(),
      sharingKeyVersion: z.number().int().positive(),
      encryptedNoteKey: z.string().min(32),
      formatVersion: z.number().int().positive()
    })
  ),
  attachmentKeys: z.array(
    z.object({
      attachmentId: z.uuid(),
      encryptedAttachmentKey: z.string().min(16),
      attachmentKeyNonce: z.string().min(16)
    })
  )
});

const memberRoleSchema = z.enum(["editor", "viewer"]);

const inviteMemberSchema = z.object({
  username: z.string().min(1).max(64),
  role: memberRoleSchema,
  sharingKeyVersion: z.number().int().positive(),
  encryptedNoteKey: z.string().min(32),
  formatVersion: z.number().int().positive()
});

const updateMemberSchema = z.object({
  role: memberRoleSchema
});

function folderBelongsToUser(
  context: AppContext,
  userId: string,
  folderId: string | null | undefined
): boolean {
  if (!folderId) {
    return true;
  }

  const row = context.db.orm
    .select({ id: schema.folders.id })
    .from(schema.folders)
    .where(and(eq(schema.folders.id, folderId), eq(schema.folders.userId, userId)))
    .get();
  return Boolean(row);
}

function publishEventCursors(context: AppContext, cursors: number[]): void {
  context.realtime?.publishEvents(cursors);
}

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

const noteSelection = {
  id: schema.notes.id,
  folderId: schema.notes.folderId,
  title: schema.notes.title,
  encryptedNoteKey: sql<string | null>`CASE WHEN ${schema.noteMemberships.role} = 'owner' THEN ${schema.notes.encryptedNoteKey} ELSE NULL END`,
  noteKeyNonce: sql<string | null>`CASE WHEN ${schema.noteMemberships.role} = 'owner' THEN ${schema.notes.noteKeyNonce} ELSE NULL END`,
  contentCipher: schema.notes.contentCipher,
  contentNonce: schema.notes.contentNonce,
  contentLength: schema.notes.contentLength,
  contentUpdatedAt: schema.notes.contentUpdatedAt,
  version: schema.notes.version,
  isDeleted: schema.notes.isDeleted,
  deletedAt: schema.notes.deletedAt,
  createdAt: schema.notes.createdAt,
  updatedAt: schema.notes.updatedAt,
  ownerUserId: schema.notes.userId,
  cryptoOwnerId: schema.notes.cryptoOwnerId,
  role: schema.noteMemberships.role
};

export function createNotesRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const includeDeleted = request.query.deleted === "true";
    const rows = context.db.orm
      .select(noteSelection)
      .from(schema.notes)
      .innerJoin(
        schema.noteMemberships,
        eq(schema.noteMemberships.noteId, schema.notes.id)
      )
      .where(and(
        eq(schema.noteMemberships.userId, session.userId),
        eq(schema.noteMemberships.status, "active"),
        eq(schema.notes.isDeleted, includeDeleted)
      ))
      .orderBy(desc(schema.notes.updatedAt))
      .all();

    response.json({ notes: rows });
  });

  router.post("/", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = createNoteSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid note payload");
      return;
    }

    const folderId = parsed.data.folderId ?? null;
    if (!folderBelongsToUser(context, session.userId, folderId)) {
      sendApiError(response, "bad_request", "Invalid folder");
      return;
    }

    const cursor = context.db.orm.transaction((tx) => {
      tx.insert(schema.notes).values({
        id: parsed.data.id,
        userId: session.userId,
        cryptoOwnerId: session.userId,
        folderId,
        title: parsed.data.title,
        encryptedNoteKey: parsed.data.encryptedNoteKey,
        noteKeyNonce: parsed.data.noteKeyNonce,
        contentCipher: parsed.data.contentCipher,
        contentNonce: parsed.data.contentNonce,
        contentLength: parsed.data.contentLength,
        contentUpdatedAt: sql`CURRENT_TIMESTAMP`
      }).run();
      tx.insert(schema.noteMemberships).values({
        noteId: parsed.data.id,
        userId: session.userId,
        role: "owner",
        status: "active"
      }).run();
      return writeRequestEvent(context, request, {
        noteId: parsed.data.id,
        actorUserId: session.userId,
        eventType: "note.created",
        noteVersion: 1
      }, tx);
    });
    publishEventCursors(context, [cursor]);

    response.status(201).json({ id: parsed.data.id, version: 1 });
  });

  router.get("/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const row = context.db.orm
      .select(noteSelection)
      .from(schema.notes)
      .innerJoin(
        schema.noteMemberships,
        eq(schema.noteMemberships.noteId, schema.notes.id)
      )
      .where(and(
        eq(schema.notes.id, request.params.id),
        eq(schema.noteMemberships.userId, session.userId),
        eq(schema.noteMemberships.status, "active")
      ))
      .get();

    if (!row) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    response.json(row);
  });

  router.get("/:id/memberships", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const rows = context.db.orm
      .select({
        userId: schema.noteMemberships.userId,
        username: schema.users.username,
        role: schema.noteMemberships.role,
        status: schema.noteMemberships.status,
        createdAt: schema.noteMemberships.createdAt,
        updatedAt: schema.noteMemberships.updatedAt
      })
      .from(schema.noteMemberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.noteMemberships.userId))
      .where(eq(schema.noteMemberships.noteId, access.noteId))
      .orderBy(sql`${schema.noteMemberships.role} = 'owner' DESC`, schema.users.username)
      .all();

    response.json({ memberships: rows });
  });

  router.post("/:id/memberships", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = inviteMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid membership payload");
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const recipient = context.db.orm
      .select({ userId: schema.users.id, username: schema.users.username })
      .from(schema.users)
      .innerJoin(
        schema.userSharingKeys,
        eq(schema.userSharingKeys.userId, schema.users.id)
      )
      .where(and(
        eq(schema.users.username, parsed.data.username),
        eq(schema.userSharingKeys.sharingKeyVersion, parsed.data.sharingKeyVersion)
      ))
      .get();

    if (!recipient) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }
    if (recipient.userId === session.userId) {
      sendApiError(response, "bad_request", "Cannot invite yourself");
      return;
    }

    const existing = context.db.orm
      .select({ role: schema.noteMemberships.role })
      .from(schema.noteMemberships)
      .where(and(
        eq(schema.noteMemberships.noteId, access.noteId),
        eq(schema.noteMemberships.userId, recipient.userId)
      ))
      .get();
    if (existing?.role === "owner") {
      sendApiError(response, "bad_request", "Cannot replace note owner");
      return;
    }

    const cursor = context.db.orm.transaction((tx) => {
      tx.insert(schema.noteMemberships)
        .values({
          noteId: access.noteId,
          userId: recipient.userId,
          role: parsed.data.role,
          status: "active"
        })
        .onConflictDoUpdate({
          target: [schema.noteMemberships.noteId, schema.noteMemberships.userId],
          set: {
            role: parsed.data.role,
            status: "active",
            updatedAt: sql`CURRENT_TIMESTAMP`
          }
        })
        .run();
      tx.insert(schema.noteKeyShares)
        .values({
          noteId: access.noteId,
          recipientUserId: recipient.userId,
          senderUserId: session.userId,
          sharingKeyVersion: parsed.data.sharingKeyVersion,
          encryptedNoteKey: parsed.data.encryptedNoteKey,
          formatVersion: parsed.data.formatVersion
        })
        .onConflictDoUpdate({
          target: [schema.noteKeyShares.noteId, schema.noteKeyShares.recipientUserId],
          set: {
            senderUserId: session.userId,
            sharingKeyVersion: parsed.data.sharingKeyVersion,
            encryptedNoteKey: parsed.data.encryptedNoteKey,
            formatVersion: parsed.data.formatVersion,
            createdAt: sql`CURRENT_TIMESTAMP`
          }
        })
        .run();
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "membership.added",
        noteVersion: access.version,
        resourceType: "membership",
        resourceId: `${access.noteId}:${recipient.userId}`,
        payloadMetadata: {
          membershipUserId: recipient.userId,
          role: parsed.data.role
        }
      }, tx);
    });
    publishEventCursors(context, [cursor]);

    response.status(201).json({
      noteId: access.noteId,
      userId: recipient.userId,
      username: recipient.username,
      role: parsed.data.role,
      status: "active"
    });
  });

  router.patch("/:id/memberships/:userId", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = updateMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid membership payload");
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (request.params.userId === session.userId) {
      sendApiError(response, "bad_request", "Cannot change owner role");
      return;
    }

    const updateCursor = context.db.orm.transaction((tx) => {
      const result = tx.update(schema.noteMemberships)
        .set({ role: parsed.data.role, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(
          eq(schema.noteMemberships.noteId, access.noteId),
          eq(schema.noteMemberships.userId, request.params.userId),
          ne(schema.noteMemberships.role, "owner"),
          eq(schema.noteMemberships.status, "active")
        ))
        .run();
      if (result.changes === 0) {
        return null;
      }
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "membership.role_updated",
        noteVersion: access.version,
        resourceType: "membership",
        resourceId: `${access.noteId}:${request.params.userId}`,
        payloadMetadata: {
          membershipUserId: request.params.userId,
          role: parsed.data.role
        }
      }, tx);
    });
    if (updateCursor === null) {
      sendApiError(response, "not_found", "Membership not found");
      return;
    }
    publishEventCursors(context, [updateCursor]);

    response.json({
      noteId: access.noteId,
      userId: request.params.userId,
      role: parsed.data.role,
      status: "active"
    });
  });

  router.delete("/:id/memberships/:userId", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (request.params.userId === session.userId) {
      sendApiError(response, "bad_request", "Cannot revoke note owner");
      return;
    }

    const revokeCursor = context.db.orm.transaction((tx) => {
      const result = tx.update(schema.noteMemberships)
        .set({ status: "revoked", updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(
          eq(schema.noteMemberships.noteId, access.noteId),
          eq(schema.noteMemberships.userId, request.params.userId),
          ne(schema.noteMemberships.role, "owner"),
          ne(schema.noteMemberships.status, "revoked")
        ))
        .run();
      if (result.changes === 0) {
        return null;
      }
      tx.delete(schema.noteKeyShares)
        .where(and(
          eq(schema.noteKeyShares.noteId, access.noteId),
          eq(schema.noteKeyShares.recipientUserId, request.params.userId)
        ))
        .run();
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "membership.revoked",
        noteVersion: access.version,
        resourceType: "membership",
        resourceId: `${access.noteId}:${request.params.userId}`,
        payloadMetadata: {
          membershipUserId: request.params.userId
        }
      }, tx);
    });
    if (revokeCursor === null) {
      sendApiError(response, "not_found", "Membership not found");
      return;
    }
    publishEventCursors(context, [revokeCursor]);

    response.status(204).send();
  });

  router.get("/:id/key-share", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (access.role === "owner") {
      sendApiError(response, "not_found", "Note key share not found");
      return;
    }

    const row = context.db.orm
      .select()
      .from(schema.noteKeyShares)
      .where(and(
        eq(schema.noteKeyShares.noteId, access.noteId),
        eq(schema.noteKeyShares.recipientUserId, session.userId)
      ))
      .get();

    if (!row) {
      sendApiError(response, "not_found", "Note key share not found");
      return;
    }

    response.json(row);
  });

  router.post("/:id/key-rotation", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = rotateNoteKeySchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid key rotation payload");
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (access.isDeleted) {
      sendApiError(response, "conflict", "Restore note before rotating keys");
      return;
    }
    if (access.version !== parsed.data.version) {
      sendApiError(response, "conflict", "Note version conflict");
      return;
    }

    const activeMembers = context.db.orm
      .select({ userId: schema.noteMemberships.userId })
      .from(schema.noteMemberships)
      .where(and(
        eq(schema.noteMemberships.noteId, access.noteId),
        eq(schema.noteMemberships.status, "active"),
        ne(schema.noteMemberships.role, "owner")
      ))
      .all();
    const activeMemberIds = activeMembers.map((member) => member.userId);
    const shareRecipientIds = parsed.data.shares.map((share) => share.recipientUserId);
    if (!sameMembers(activeMemberIds, shareRecipientIds)) {
      sendApiError(response, "bad_request", "Key shares must cover all active members");
      return;
    }

    const validShareRows = parsed.data.shares.length
      ? context.db.orm.all<{ userId: string; sharingKeyVersion: number }>(sql`
          SELECT user_id AS userId, sharing_key_version AS sharingKeyVersion
          FROM ${schema.userSharingKeys}
          WHERE (user_id, sharing_key_version) IN (
            ${sql.join(
              parsed.data.shares.map((share) =>
                sql`(${share.recipientUserId}, ${share.sharingKeyVersion})`
              ),
              sql`, `
            )}
          )
        `)
      : [];
    const validShareKeys = new Set(
      validShareRows.map((row) => `${row.userId}:${String(row.sharingKeyVersion)}`)
    );
    if (
      parsed.data.shares.some(
        (share) =>
          !validShareKeys.has(`${share.recipientUserId}:${String(share.sharingKeyVersion)}`)
      )
    ) {
      sendApiError(response, "bad_request", "Invalid sharing key version");
      return;
    }

    const attachmentRows = context.db.orm
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(eq(schema.attachments.noteId, access.noteId))
      .all();
    const attachmentIds = attachmentRows.map((attachment) => attachment.id);
    const rotatedAttachmentIds = parsed.data.attachmentKeys.map(
      (attachment) => attachment.attachmentId
    );
    if (!sameMembers(attachmentIds, rotatedAttachmentIds)) {
      sendApiError(response, "bad_request", "Attachment keys must cover all attachments");
      return;
    }

    const nextVersion = access.version + 1;
    const eventCursor = context.db.orm.transaction((tx) => {
      const updateResult = tx.update(schema.notes)
        .set({
          encryptedNoteKey: parsed.data.encryptedNoteKey,
          noteKeyNonce: parsed.data.noteKeyNonce,
          contentCipher: parsed.data.contentCipher,
          contentNonce: parsed.data.contentNonce,
          contentLength: parsed.data.contentLength,
          contentUpdatedAt: sql`CURRENT_TIMESTAMP`,
          version: sql`${schema.notes.version} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(and(
          eq(schema.notes.id, access.noteId),
          eq(schema.notes.version, parsed.data.version)
        ))
        .run();
      if (updateResult.changes !== 1) {
        return null;
      }
      for (const share of parsed.data.shares) {
        tx.insert(schema.noteKeyShares)
          .values({
            noteId: access.noteId,
            recipientUserId: share.recipientUserId,
            senderUserId: session.userId,
            sharingKeyVersion: share.sharingKeyVersion,
            encryptedNoteKey: share.encryptedNoteKey,
            formatVersion: share.formatVersion
          })
          .onConflictDoUpdate({
            target: [schema.noteKeyShares.noteId, schema.noteKeyShares.recipientUserId],
            set: {
              senderUserId: session.userId,
              sharingKeyVersion: share.sharingKeyVersion,
              encryptedNoteKey: share.encryptedNoteKey,
              formatVersion: share.formatVersion,
              createdAt: sql`CURRENT_TIMESTAMP`
            }
          })
          .run();
      }
      for (const attachmentKey of parsed.data.attachmentKeys) {
        tx.update(schema.attachments)
          .set({
            encryptedAttachmentKey: attachmentKey.encryptedAttachmentKey,
            attachmentKeyNonce: attachmentKey.attachmentKeyNonce
          })
          .where(and(
            eq(schema.attachments.id, attachmentKey.attachmentId),
            eq(schema.attachments.noteId, access.noteId)
          ))
          .run();
      }
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.updated",
        noteVersion: nextVersion,
        payloadMetadata: {
          keyRotated: true
        }
      }, tx);
    });
    if (eventCursor === null) {
      sendApiError(response, "conflict", "Note version conflict");
      return;
    }
    publishEventCursors(context, [eventCursor]);

    response.json({ id: access.noteId, version: nextVersion });
  });

  router.put("/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = updateNoteSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid note payload");
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canEditNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (access.isDeleted) {
      sendApiError(response, "conflict", "Restore note before updating");
      return;
    }
    if (access.version !== parsed.data.version) {
      sendApiError(response, "conflict", "Note version conflict");
      return;
    }

    const folderId = parsed.data.folderId ?? access.folderId;
    if (
      access.role !== "owner" &&
      parsed.data.folderId !== undefined &&
      parsed.data.folderId !== access.folderId
    ) {
      sendApiError(response, "bad_request", "Shared notes cannot be moved");
      return;
    }
    if (access.role === "owner" && !folderBelongsToUser(context, session.userId, folderId)) {
      sendApiError(response, "bad_request", "Invalid folder");
      return;
    }

    const title = parsed.data.title ?? undefined;
    const nextVersion = access.version + 1;
    const eventCursor = context.db.orm.transaction((tx) => {
      const updateResult = tx.update(schema.notes)
        .set({
          folderId,
          title,
          contentCipher: parsed.data.contentCipher,
          contentNonce: parsed.data.contentNonce,
          contentLength: parsed.data.contentLength,
          contentUpdatedAt: sql`CURRENT_TIMESTAMP`,
          version: sql`${schema.notes.version} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(and(
          eq(schema.notes.id, access.noteId),
          eq(schema.notes.version, parsed.data.version)
        ))
        .run();
      if (updateResult.changes !== 1) {
        return null;
      }
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.updated",
        noteVersion: nextVersion
      }, tx);
    });
    if (eventCursor === null) {
      sendApiError(response, "conflict", "Note version conflict");
      return;
    }
    publishEventCursors(context, [eventCursor]);

    response.json({ id: access.noteId, version: nextVersion });
  });

  router.delete("/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const cursor = context.db.orm.transaction((tx) => {
      tx.update(schema.notes)
        .set({
          isDeleted: true,
          deletedAt: sql`CURRENT_TIMESTAMP`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(and(
          eq(schema.notes.id, access.noteId),
          eq(schema.notes.userId, session.userId)
        ))
        .run();
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.deleted",
        noteVersion: access.version
      }, tx);
    });
    publishEventCursors(context, [cursor]);

    response.status(204).send();
  });

  router.post("/:id/restore", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const cursor = context.db.orm.transaction((tx) => {
      tx.update(schema.notes)
        .set({ isDeleted: false, deletedAt: null, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(
          eq(schema.notes.id, access.noteId),
          eq(schema.notes.userId, session.userId)
        ))
        .run();
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.restored",
        noteVersion: access.version
      }, tx);
    });
    publishEventCursors(context, [cursor]);

    response.json({ id: access.noteId });
  });

  router.delete("/:id/permanent", async (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const rows = context.db.orm
      .select({ fileCipherPath: schema.attachments.fileCipherPath })
      .from(schema.attachments)
      .where(and(
        eq(schema.attachments.noteId, access.noteId),
        eq(schema.attachments.userId, session.userId)
      ))
      .all();

    const memberRows = context.db.orm
      .select({ userId: schema.noteMemberships.userId })
      .from(schema.noteMemberships)
      .where(and(
        eq(schema.noteMemberships.noteId, access.noteId),
        eq(schema.noteMemberships.status, "active")
      ))
      .all();

    const cursor = context.db.orm.transaction((tx) => {
      tx.delete(schema.notes)
        .where(and(
          eq(schema.notes.id, access.noteId),
          eq(schema.notes.userId, session.userId)
        ))
        .run();
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.permanently_deleted",
        noteVersion: access.version,
        payloadMetadata: {
          visibleUserIds: memberRows.map((row) => row.userId)
        }
      }, tx);
    });
    publishEventCursors(context, [cursor]);
    await Promise.all(
      rows.map((row) =>
        deleteEncryptedAttachment(context.config, row.fileCipherPath).catch((error: unknown) => {
          console.error("Unable to delete attachment ciphertext", error);
        })
      )
    );

    response.status(204).send();
  });

  return router;
}
