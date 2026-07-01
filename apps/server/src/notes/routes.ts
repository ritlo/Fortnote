import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { requireSession } from "../auth/session.js";
import { deleteEncryptedAttachment } from "../attachments/storage.js";
import { canEditNote, canOwnNote, canReadNote, getNoteAccess } from "./access.js";
import { writeNoteEvent } from "./events.js";

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

  const row = context.db.sqlite
    .prepare("SELECT id FROM folders WHERE id = ? AND user_id = ?")
    .get(folderId, userId);
  return Boolean(row);
}

export function createNotesRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const includeDeleted = request.query.deleted === "true";
    const rows = context.db.sqlite
      .prepare(
	        `SELECT notes.id,
	                notes.folder_id AS folderId,
	                notes.title,
	                CASE
	                  WHEN note_memberships.role = 'owner' THEN notes.encrypted_note_key
	                  ELSE NULL
	                END AS encryptedNoteKey,
	                CASE
	                  WHEN note_memberships.role = 'owner' THEN notes.note_key_nonce
	                  ELSE NULL
	                END AS noteKeyNonce,
	                notes.content_cipher AS contentCipher,
	                notes.content_nonce AS contentNonce,
	                notes.content_length AS contentLength,
	                notes.content_updated_at AS contentUpdatedAt,
	                notes.version,
	                notes.is_deleted AS isDeleted,
	                notes.deleted_at AS deletedAt,
	                notes.created_at AS createdAt,
	                notes.updated_at AS updatedAt,
	                notes.user_id AS ownerUserId,
	                notes.crypto_owner_id AS cryptoOwnerId,
	                note_memberships.role
         FROM notes
         JOIN note_memberships ON note_memberships.note_id = notes.id
         WHERE note_memberships.user_id = ?
           AND note_memberships.status = 'active'
           AND notes.is_deleted = ?
         ORDER BY notes.updated_at DESC`
      )
      .all(session.userId, includeDeleted ? 1 : 0);

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

    const createOwnedNote = context.db.sqlite.transaction(() => {
      context.db.sqlite
        .prepare(
          `INSERT INTO notes (
            id,
            user_id,
            crypto_owner_id,
            folder_id,
            title,
            encrypted_note_key,
            note_key_nonce,
            content_cipher,
            content_nonce,
            content_length,
            content_updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        )
        .run(
          parsed.data.id,
          session.userId,
          session.userId,
          folderId,
          parsed.data.title,
          parsed.data.encryptedNoteKey,
          parsed.data.noteKeyNonce,
          parsed.data.contentCipher,
          parsed.data.contentNonce,
          parsed.data.contentLength
        );
      context.db.sqlite
        .prepare(
          `INSERT INTO note_memberships (note_id, user_id, role, status)
           VALUES (?, ?, 'owner', 'active')`
        )
        .run(parsed.data.id, session.userId);
      writeNoteEvent(context, {
        noteId: parsed.data.id,
        actorUserId: session.userId,
        eventType: "note.created",
        noteVersion: 1
      });
    });
    createOwnedNote();

    response.status(201).json({ id: parsed.data.id, version: 1 });
  });

  router.get("/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const row = context.db.sqlite
      .prepare(
	        `SELECT notes.id,
	                notes.folder_id AS folderId,
	                notes.title,
	                CASE
	                  WHEN note_memberships.role = 'owner' THEN notes.encrypted_note_key
	                  ELSE NULL
	                END AS encryptedNoteKey,
	                CASE
	                  WHEN note_memberships.role = 'owner' THEN notes.note_key_nonce
	                  ELSE NULL
	                END AS noteKeyNonce,
	                notes.content_cipher AS contentCipher,
	                notes.content_nonce AS contentNonce,
	                notes.content_length AS contentLength,
	                notes.content_updated_at AS contentUpdatedAt,
	                notes.version,
	                notes.is_deleted AS isDeleted,
	                notes.deleted_at AS deletedAt,
	                notes.created_at AS createdAt,
	                notes.updated_at AS updatedAt,
	                notes.user_id AS ownerUserId,
	                notes.crypto_owner_id AS cryptoOwnerId,
	                note_memberships.role
         FROM notes
         JOIN note_memberships ON note_memberships.note_id = notes.id
         WHERE notes.id = ?
           AND note_memberships.user_id = ?
           AND note_memberships.status = 'active'`
      )
      .get(request.params.id, session.userId);

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

    const rows = context.db.sqlite
      .prepare(
        `SELECT note_memberships.user_id AS userId,
                users.username,
                note_memberships.role,
                note_memberships.status,
                note_memberships.created_at AS createdAt,
                note_memberships.updated_at AS updatedAt
         FROM note_memberships
         JOIN users ON users.id = note_memberships.user_id
         WHERE note_memberships.note_id = ?
         ORDER BY note_memberships.role = 'owner' DESC, users.username`
      )
      .all(access.noteId);

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

    const recipient = context.db.sqlite
      .prepare(
        `SELECT users.id AS userId,
                users.username
         FROM users
         JOIN user_sharing_keys ON user_sharing_keys.user_id = users.id
         WHERE users.username = ?
           AND user_sharing_keys.sharing_key_version = ?`
      )
      .get(parsed.data.username, parsed.data.sharingKeyVersion) as
      | { userId: string; username: string }
      | undefined;

    if (!recipient) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }
    if (recipient.userId === session.userId) {
      sendApiError(response, "bad_request", "Cannot invite yourself");
      return;
    }

    const existing = context.db.sqlite
      .prepare(
        `SELECT role
         FROM note_memberships
         WHERE note_id = ? AND user_id = ?`
      )
      .get(access.noteId, recipient.userId) as { role: string } | undefined;
    if (existing?.role === "owner") {
      sendApiError(response, "bad_request", "Cannot replace note owner");
      return;
    }

    const inviteMember = context.db.sqlite.transaction(() => {
      context.db.sqlite
        .prepare(
          `INSERT INTO note_memberships (note_id, user_id, role, status)
           VALUES (?, ?, ?, 'active')
           ON CONFLICT(note_id, user_id) DO UPDATE SET
             role = excluded.role,
             status = 'active',
             updated_at = CURRENT_TIMESTAMP`
        )
        .run(access.noteId, recipient.userId, parsed.data.role);
      context.db.sqlite
        .prepare(
          `INSERT INTO note_key_shares (
            note_id,
            recipient_user_id,
            sender_user_id,
            sharing_key_version,
            encrypted_note_key,
            format_version
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(note_id, recipient_user_id) DO UPDATE SET
            sender_user_id = excluded.sender_user_id,
            sharing_key_version = excluded.sharing_key_version,
            encrypted_note_key = excluded.encrypted_note_key,
            format_version = excluded.format_version,
            created_at = CURRENT_TIMESTAMP`
        )
        .run(
          access.noteId,
          recipient.userId,
          session.userId,
          parsed.data.sharingKeyVersion,
          parsed.data.encryptedNoteKey,
          parsed.data.formatVersion
        );
      writeNoteEvent(context, {
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
      });
    });
    inviteMember();

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

    const updateMember = context.db.sqlite.transaction(() => {
      const result = context.db.sqlite
        .prepare(
          `UPDATE note_memberships
           SET role = ?, updated_at = CURRENT_TIMESTAMP
           WHERE note_id = ?
             AND user_id = ?
             AND role != 'owner'
             AND status = 'active'`
        )
        .run(parsed.data.role, access.noteId, request.params.userId);
      if (result.changes === 0) {
        return false;
      }
      writeNoteEvent(context, {
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
      });
      return true;
    });

    if (!updateMember()) {
      sendApiError(response, "not_found", "Membership not found");
      return;
    }

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

    const revokeMember = context.db.sqlite.transaction(() => {
      const result = context.db.sqlite
        .prepare(
          `UPDATE note_memberships
           SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
           WHERE note_id = ?
             AND user_id = ?
             AND role != 'owner'
             AND status != 'revoked'`
        )
        .run(access.noteId, request.params.userId);
      if (result.changes === 0) {
        return false;
      }
      context.db.sqlite
        .prepare(
          `DELETE FROM note_key_shares
           WHERE note_id = ? AND recipient_user_id = ?`
        )
        .run(access.noteId, request.params.userId);
      writeNoteEvent(context, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "membership.revoked",
        noteVersion: access.version,
        resourceType: "membership",
        resourceId: `${access.noteId}:${request.params.userId}`,
        payloadMetadata: {
          membershipUserId: request.params.userId
        }
      });
      return true;
    });

    if (!revokeMember()) {
      sendApiError(response, "not_found", "Membership not found");
      return;
    }

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

    const row = context.db.sqlite
      .prepare(
        `SELECT note_id AS noteId,
                recipient_user_id AS recipientUserId,
                sender_user_id AS senderUserId,
                sharing_key_version AS sharingKeyVersion,
                encrypted_note_key AS encryptedNoteKey,
                format_version AS formatVersion,
                created_at AS createdAt
         FROM note_key_shares
         WHERE note_id = ? AND recipient_user_id = ?`
      )
      .get(access.noteId, session.userId);

    if (!row) {
      sendApiError(response, "not_found", "Note key share not found");
      return;
    }

    response.json(row);
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
    const updateNote = context.db.sqlite.transaction(() => {
      context.db.sqlite
        .prepare(
          `UPDATE notes
           SET folder_id = ?,
               title = COALESCE(?, title),
               content_cipher = ?,
               content_nonce = ?,
               content_length = ?,
               content_updated_at = CURRENT_TIMESTAMP,
               version = version + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(
          folderId,
          title,
          parsed.data.contentCipher,
          parsed.data.contentNonce,
          parsed.data.contentLength,
          access.noteId
        );
      writeNoteEvent(context, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.updated",
        noteVersion: nextVersion
      });
    });
    updateNote();

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

    const deleteNote = context.db.sqlite.transaction(() => {
      context.db.sqlite
        .prepare(
          `UPDATE notes
           SET is_deleted = 1,
               deleted_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ?`
        )
        .run(access.noteId, session.userId);
      writeNoteEvent(context, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.deleted",
        noteVersion: access.version
      });
    });
    deleteNote();

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

    const restoreNote = context.db.sqlite.transaction(() => {
      context.db.sqlite
        .prepare(
          `UPDATE notes
           SET is_deleted = 0,
               deleted_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ?`
        )
        .run(access.noteId, session.userId);
      writeNoteEvent(context, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.restored",
        noteVersion: access.version
      });
    });
    restoreNote();

    response.json({ id: access.noteId });
  });

  router.delete("/:id/permanent", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const rows = context.db.sqlite
      .prepare(
        "SELECT file_cipher_path AS fileCipherPath FROM attachments WHERE note_id = ? AND user_id = ?"
      )
      .all(access.noteId, session.userId) as { fileCipherPath: string }[];

    const memberRows = context.db.sqlite
      .prepare(
        `SELECT user_id AS userId
         FROM note_memberships
         WHERE note_id = ? AND status = 'active'`
      )
      .all(access.noteId) as { userId: string }[];

    const remove = context.db.sqlite.transaction(() => {
      context.db.sqlite
        .prepare("DELETE FROM notes WHERE id = ? AND user_id = ?")
        .run(access.noteId, session.userId);
      writeNoteEvent(context, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.permanently_deleted",
        noteVersion: access.version,
        payloadMetadata: {
          visibleUserIds: memberRows.map((row) => row.userId)
        }
      });
    });
    remove();
    for (const row of rows) {
      deleteEncryptedAttachment(context.config, row.fileCipherPath);
    }

    response.status(204).send();
  });

  return router;
}
