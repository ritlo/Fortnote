import { Buffer } from "node:buffer";
import { Router, type Request } from "express";
import { z } from "zod";
import { LIMITS } from "@fortnote/shared";
import { requireSession } from "../auth/session.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import {
  deleteEncryptedAttachment,
  readEncryptedAttachment,
  safeDisplayFilename,
  writeEncryptedAttachment
} from "./storage.js";

const uploadAttachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(120),
  size: z.number().int().nonnegative(),
  encryptedAttachmentKey: z.string().min(16),
  attachmentKeyNonce: z.string().min(16),
  fileNonce: z.string().min(16)
});

type UploadReadResult =
  | { ok: true; bytes: Buffer }
  | {
      ok: false;
      code: "bad_request" | "payload_too_large";
      message: string;
    };

interface NoteOwnerRow {
  id: string;
  userId: string;
  isDeleted: 0 | 1;
}

interface AttachmentRow {
  id: string;
  noteId: string;
  userId: string;
  filename: string;
  mimeType: string;
  size: number;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
  fileCipherPath: string;
  fileNonce: string;
  createdAt: string;
}

function getNote(context: AppContext, noteId: string): NoteOwnerRow | undefined {
  return context.db.sqlite
    .prepare(
      `SELECT id, user_id AS userId, is_deleted AS isDeleted
       FROM notes
       WHERE id = ?`
    )
    .get(noteId) as NoteOwnerRow | undefined;
}

function getAttachment(
  context: AppContext,
  attachmentId: string
): AttachmentRow | undefined {
  return context.db.sqlite
    .prepare(
      `SELECT id,
              note_id AS noteId,
              user_id AS userId,
              filename,
              mime_type AS mimeType,
              size,
              encrypted_attachment_key AS encryptedAttachmentKey,
              attachment_key_nonce AS attachmentKeyNonce,
              file_cipher_path AS fileCipherPath,
              file_nonce AS fileNonce,
              created_at AS createdAt
       FROM attachments
       WHERE id = ?`
    )
    .get(attachmentId) as AttachmentRow | undefined;
}

function userStorageBytes(context: AppContext, userId: string): number {
  const row = context.db.sqlite
    .prepare("SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE user_id = ?")
    .get(userId) as { total: number };
  return row.total;
}

function headerValue(request: Request, name: string): string {
  const value = request.get(name);
  return value ? decodeHeaderValue(value) : "";
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function uploadMetadata(request: Request) {
  return {
    id: headerValue(request, "x-fortnote-attachment-id"),
    filename: headerValue(request, "x-fortnote-filename"),
    mimeType: headerValue(request, "x-fortnote-mime-type"),
    size: Number(headerValue(request, "x-fortnote-size")),
    encryptedAttachmentKey: headerValue(
      request,
      "x-fortnote-encrypted-attachment-key"
    ),
    attachmentKeyNonce: headerValue(request, "x-fortnote-attachment-key-nonce"),
    fileNonce: headerValue(request, "x-fortnote-file-nonce")
  };
}

function declaredContentLength(request: Request): number | null {
  const header = request.get("content-length");
  if (!header) {
    return null;
  }

  const parsed = Number(header);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

function requestChunkToBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  throw new Error("Unsupported upload chunk");
}

async function readEncryptedUpload(
  request: Request,
  expectedBytes: number
): Promise<UploadReadResult> {
  const contentLength = declaredContentLength(request);
  if (Number.isNaN(contentLength)) {
    return { ok: false, code: "bad_request", message: "Invalid Content-Length" };
  }
  if (contentLength !== null && contentLength !== expectedBytes) {
    return {
      ok: false,
      code: "bad_request",
      message: "Attachment size mismatch"
    };
  }

  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of request as AsyncIterable<unknown>) {
      const buffer = requestChunkToBuffer(chunk);
      total += buffer.byteLength;
      if (total > LIMITS.maxAttachmentBytes) {
        return {
          ok: false,
          code: "payload_too_large",
          message: "Attachment too large"
        };
      }
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, code: "bad_request", message: "Unable to read attachment" };
  }

  if (total !== expectedBytes) {
    return {
      ok: false,
      code: "bad_request",
      message: "Attachment size mismatch"
    };
  }

  return { ok: true, bytes: Buffer.concat(chunks, total) };
}

export function createAttachmentsRouter(context: AppContext): Router {
  const router = Router();

  router.post("/notes/:noteId/attachments", async (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = uploadAttachmentSchema.safeParse(uploadMetadata(request));
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid attachment payload");
      return;
    }

    const note = getNote(context, request.params.noteId);
    if (!note) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (note.userId !== session.userId) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (note.isDeleted) {
      sendApiError(response, "conflict", "Restore note before attaching files");
      return;
    }
    if (!safeDisplayFilename(parsed.data.filename)) {
      sendApiError(response, "bad_request", "Invalid attachment filename");
      return;
    }
    if (parsed.data.size > LIMITS.maxAttachmentBytes) {
      sendApiError(response, "payload_too_large", "Attachment too large");
      return;
    }
    if (userStorageBytes(context, session.userId) + parsed.data.size > LIMITS.maxUserStorageBytes) {
      sendApiError(response, "quota_exceeded", "Storage quota exceeded");
      return;
    }

    const encryptedBytes = await readEncryptedUpload(request, parsed.data.size);
    if (!encryptedBytes.ok) {
      sendApiError(response, encryptedBytes.code, encryptedBytes.message);
      return;
    }

    const storageId = crypto.randomUUID();
    try {
      writeEncryptedAttachment(context.config, storageId, encryptedBytes.bytes);
      context.db.sqlite
        .prepare(
          `INSERT INTO attachments (
            id,
            note_id,
            user_id,
            filename,
            mime_type,
            size,
            encrypted_attachment_key,
            attachment_key_nonce,
            file_cipher_path,
            file_nonce
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          parsed.data.id,
          note.id,
          session.userId,
          parsed.data.filename.trim(),
          parsed.data.mimeType,
          parsed.data.size,
          parsed.data.encryptedAttachmentKey,
          parsed.data.attachmentKeyNonce,
          storageId,
          parsed.data.fileNonce
        );
    } catch (error) {
      deleteEncryptedAttachment(context.config, storageId);
      throw error;
    }

    response.status(201).json({ id: parsed.data.id });
  });

  router.get("/notes/:noteId/attachments", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const note = getNote(context, request.params.noteId);
    if (!note) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (note.userId !== session.userId) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const rows = context.db.sqlite
      .prepare(
        `SELECT id,
                filename,
                mime_type AS mimeType,
                size,
                encrypted_attachment_key AS encryptedAttachmentKey,
                attachment_key_nonce AS attachmentKeyNonce,
                file_nonce AS fileNonce,
                created_at AS createdAt
         FROM attachments
         WHERE note_id = ? AND user_id = ?
         ORDER BY created_at DESC`
      )
      .all(note.id, session.userId);

    response.json({ attachments: rows });
  });

  router.get("/attachments/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const attachment = getAttachment(context, request.params.id);
    if (!attachment) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }
    if (attachment.userId !== session.userId) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }

    response.json({
      ...attachment,
      encryptedBytes: readEncryptedAttachment(context.config, attachment.fileCipherPath).toString("base64")
    });
  });

  router.delete("/attachments/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const attachment = getAttachment(context, request.params.id);
    if (!attachment) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }
    if (attachment.userId !== session.userId) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }

    context.db.sqlite
      .prepare("DELETE FROM attachments WHERE id = ? AND user_id = ?")
      .run(attachment.id, session.userId);
    deleteEncryptedAttachment(context.config, attachment.fileCipherPath);

    response.status(204).send();
  });

  return router;
}
