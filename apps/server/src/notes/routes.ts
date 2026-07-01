import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { requireSession } from "../auth/session.js";
import { deleteEncryptedAttachment } from "../attachments/storage.js";
import { canEditNote, canOwnNote, getNoteAccess } from "./access.js";
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
	                notes.encrypted_note_key AS encryptedNoteKey,
	                notes.note_key_nonce AS noteKeyNonce,
	                notes.content_cipher AS contentCipher,
	                notes.content_nonce AS contentNonce,
	                notes.content_length AS contentLength,
	                notes.content_updated_at AS contentUpdatedAt,
	                notes.version,
	                notes.is_deleted AS isDeleted,
	                notes.deleted_at AS deletedAt,
	                notes.created_at AS createdAt,
	                notes.updated_at AS updatedAt
         FROM notes
         JOIN note_memberships ON note_memberships.note_id = notes.id
         WHERE note_memberships.user_id = ?
           AND note_memberships.role = 'owner'
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
	                notes.encrypted_note_key AS encryptedNoteKey,
	                notes.note_key_nonce AS noteKeyNonce,
	                notes.content_cipher AS contentCipher,
	                notes.content_nonce AS contentNonce,
	                notes.content_length AS contentLength,
	                notes.content_updated_at AS contentUpdatedAt,
	                notes.version,
	                notes.is_deleted AS isDeleted,
	                notes.deleted_at AS deletedAt,
	                notes.created_at AS createdAt,
	                notes.updated_at AS updatedAt
         FROM notes
         JOIN note_memberships ON note_memberships.note_id = notes.id
         WHERE notes.id = ?
           AND note_memberships.user_id = ?
           AND note_memberships.role = 'owner'
           AND note_memberships.status = 'active'`
      )
      .get(request.params.id, session.userId);

    if (!row) {
      sendApiError(response, "not_found", "Note not found");
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
    if (access.role !== "owner") {
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
    if (!folderBelongsToUser(context, session.userId, folderId)) {
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
           WHERE id = ? AND user_id = ?`
        )
        .run(
          folderId,
          title,
          parsed.data.contentCipher,
          parsed.data.contentNonce,
          parsed.data.contentLength,
          access.noteId,
          session.userId
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
