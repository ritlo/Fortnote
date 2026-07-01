import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { requireSession } from "../auth/session.js";
import { deleteEncryptedAttachment } from "../attachments/storage.js";

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

interface NoteRow {
  id: string;
  userId: string;
  cryptoOwnerId: string;
  folderId: string | null;
  version: number;
  isDeleted: 0 | 1;
}

function getNote(context: AppContext, noteId: string): NoteRow | undefined {
  return context.db.sqlite
    .prepare(
	      `SELECT id,
	              user_id AS userId,
	              crypto_owner_id AS cryptoOwnerId,
	              folder_id AS folderId,
	              version,
              is_deleted AS isDeleted
       FROM notes
       WHERE id = ?`
    )
    .get(noteId) as NoteRow | undefined;
}

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
        `SELECT id,
                folder_id AS folderId,
                title,
                encrypted_note_key AS encryptedNoteKey,
                note_key_nonce AS noteKeyNonce,
                content_cipher AS contentCipher,
                content_nonce AS contentNonce,
                content_length AS contentLength,
                content_updated_at AS contentUpdatedAt,
                version,
                is_deleted AS isDeleted,
                deleted_at AS deletedAt,
                created_at AS createdAt,
                updated_at AS updatedAt
         FROM notes
         WHERE user_id = ? AND is_deleted = ?
         ORDER BY updated_at DESC`
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
        `SELECT id,
                folder_id AS folderId,
                title,
                encrypted_note_key AS encryptedNoteKey,
                note_key_nonce AS noteKeyNonce,
                content_cipher AS contentCipher,
                content_nonce AS contentNonce,
                content_length AS contentLength,
                content_updated_at AS contentUpdatedAt,
                version,
                is_deleted AS isDeleted,
                deleted_at AS deletedAt,
                created_at AS createdAt,
                updated_at AS updatedAt
         FROM notes
         WHERE id = ? AND user_id = ?`
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

    const note = getNote(context, request.params.id);
    if (!note) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (note.userId !== session.userId) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (note.isDeleted) {
      sendApiError(response, "conflict", "Restore note before updating");
      return;
    }
    if (note.version !== parsed.data.version) {
      sendApiError(response, "conflict", "Note version conflict");
      return;
    }

    const folderId = parsed.data.folderId ?? note.folderId;
    if (!folderBelongsToUser(context, session.userId, folderId)) {
      sendApiError(response, "bad_request", "Invalid folder");
      return;
    }

    const title = parsed.data.title ?? undefined;
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
        note.id,
        session.userId
      );

    response.json({ id: note.id, version: note.version + 1 });
  });

  router.delete("/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const note = getNote(context, request.params.id);
    if (!note) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (note.userId !== session.userId) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    context.db.sqlite
      .prepare(
        `UPDATE notes
         SET is_deleted = 1,
             deleted_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`
      )
      .run(note.id, session.userId);

    response.status(204).send();
  });

  router.post("/:id/restore", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const note = getNote(context, request.params.id);
    if (!note) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (note.userId !== session.userId) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    context.db.sqlite
      .prepare(
        `UPDATE notes
         SET is_deleted = 0,
             deleted_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`
      )
      .run(note.id, session.userId);

    response.json({ id: note.id });
  });

  router.delete("/:id/permanent", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const note = getNote(context, request.params.id);
    if (!note) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (note.userId !== session.userId) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const rows = context.db.sqlite
      .prepare("SELECT file_cipher_path AS fileCipherPath FROM attachments WHERE note_id = ? AND user_id = ?")
      .all(note.id, session.userId) as { fileCipherPath: string }[];

    const remove = context.db.sqlite.transaction(() => {
      context.db.sqlite
        .prepare("DELETE FROM notes WHERE id = ? AND user_id = ?")
        .run(note.id, session.userId);
    });
    remove();
    for (const row of rows) {
      deleteEncryptedAttachment(context.config, row.fileCipherPath);
    }

    response.status(204).send();
  });

  return router;
}
