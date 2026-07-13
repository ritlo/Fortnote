import { Buffer } from "node:buffer";
import { desc, eq, sql } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import { LIMITS } from "@fortnote/shared";
import { requireSession } from "../auth/session.js";
import * as schema from "../db/schema.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import {
  deleteEncryptedAttachment,
  readEncryptedAttachment,
  safeDisplayFilename,
  writeEncryptedAttachment
} from "./storage.js";
import { canEditNote, canReadNote, getNoteAccess } from "../notes/access.js";
import { writeRequestEvent } from "../notes/events.js";

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

class StorageQuotaExceededError extends Error {}

function getAttachment(
  context: AppContext,
  attachmentId: string
) {
  return context.db.orm
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, attachmentId))
    .get();
}

function userStorageBytes(
  context: AppContext,
  userId: string,
  db: Pick<AppContext["db"]["orm"], "select"> = context.db.orm
): number {
  const row = db
    .select({ total: sql<number>`COALESCE(SUM(${schema.attachments.size}), 0)`.mapWith(Number) })
    .from(schema.attachments)
    .where(eq(schema.attachments.userId, userId))
    .get();
  return row?.total ?? 0;
}

function publishEventCursor(context: AppContext, cursor: number): void {
  context.realtime?.publishEvents([cursor]);
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

    const access = getNoteAccess(context, request.params.noteId, session.userId);
    if (!canEditNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (access.isDeleted) {
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
    if (
      userStorageBytes(context, access.ownerUserId) + parsed.data.size >
      LIMITS.maxUserStorageBytes
    ) {
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
      await writeEncryptedAttachment(context.config, storageId, encryptedBytes.bytes);
      const cursor = context.db.orm.transaction((tx) => {
        if (
          userStorageBytes(context, access.ownerUserId, tx) + parsed.data.size >
          LIMITS.maxUserStorageBytes
        ) {
          throw new StorageQuotaExceededError();
        }
        tx.insert(schema.attachments).values({
          id: parsed.data.id,
          noteId: access.noteId,
          userId: access.ownerUserId,
          filename: parsed.data.filename.trim(),
          mimeType: parsed.data.mimeType,
          size: parsed.data.size,
          encryptedAttachmentKey: parsed.data.encryptedAttachmentKey,
          attachmentKeyNonce: parsed.data.attachmentKeyNonce,
          fileCipherPath: storageId,
          fileNonce: parsed.data.fileNonce
        }).run();
        return writeRequestEvent(context, request, {
          noteId: access.noteId,
          actorUserId: session.userId,
          eventType: "attachment.created",
          noteVersion: access.version,
          resourceType: "attachment",
          resourceId: parsed.data.id,
          payloadMetadata: {
            attachmentId: parsed.data.id
          }
        }, tx);
      });
      publishEventCursor(context, cursor);
    } catch (error) {
      await deleteEncryptedAttachment(context.config, storageId);
      if (error instanceof StorageQuotaExceededError) {
        sendApiError(response, "quota_exceeded", "Storage quota exceeded");
        return;
      }
      throw error;
    }

    response.status(201).json({ id: parsed.data.id });
  });

  router.get("/notes/:noteId/attachments", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.noteId, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const rows = context.db.orm
      .select({
        id: schema.attachments.id,
        filename: schema.attachments.filename,
        mimeType: schema.attachments.mimeType,
        size: schema.attachments.size,
        encryptedAttachmentKey: schema.attachments.encryptedAttachmentKey,
        attachmentKeyNonce: schema.attachments.attachmentKeyNonce,
        fileNonce: schema.attachments.fileNonce,
        createdAt: schema.attachments.createdAt
      })
      .from(schema.attachments)
      .where(eq(schema.attachments.noteId, access.noteId))
      .orderBy(desc(schema.attachments.createdAt))
      .all();

    response.json({ attachments: rows });
  });

  router.get("/attachments/:id", async (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const attachment = getAttachment(context, request.params.id);
    if (!attachment) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }
    const access = getNoteAccess(context, attachment.noteId, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }

    response.json({
      ...attachment,
      encryptedBytes: (
        await readEncryptedAttachment(context.config, attachment.fileCipherPath)
      ).toString("base64")
    });
  });

  router.delete("/attachments/:id", async (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const attachment = getAttachment(context, request.params.id);
    if (!attachment) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }
    const access = getNoteAccess(context, attachment.noteId, session.userId);
    if (!canEditNote(access)) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }

    const cursor = context.db.orm.transaction((tx) => {
      tx.delete(schema.attachments)
        .where(eq(schema.attachments.id, attachment.id))
        .run();
      return writeRequestEvent(context, request, {
        noteId: attachment.noteId,
        actorUserId: session.userId,
        eventType: "attachment.deleted",
        noteVersion: access.version,
        resourceType: "attachment",
        resourceId: attachment.id,
        payloadMetadata: {
          attachmentId: attachment.id
        }
      }, tx);
    });
    publishEventCursor(context, cursor);
    try {
      await deleteEncryptedAttachment(context.config, attachment.fileCipherPath);
    } catch (error) {
      console.error("Unable to delete attachment ciphertext", error);
    }

    response.status(204).send();
  });

  return router;
}
