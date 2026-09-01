import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { LIMITS } from "@fortnote/shared";
import { requireSessionAsync } from "../auth/session.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import {
  AttachmentCiphertextSizeError,
  safeDisplayFilename
} from "./storage.js";
import {
  canEditNote,
  canReadNote,
  getNoteAccessAsync
} from "../notes/access.js";
import { requestClientInstanceId } from "../notes/events.js";
import type { AttachmentGateError } from "./mutationRepository.js";

const uploadAttachmentBaseSchema = z.object({
  id: z.uuid(),
  size: z.number().int().nonnegative(),
  encryptedAttachmentKey: z.string().min(16),
  attachmentKeyNonce: z.string().min(16),
  fileNonce: z.string().min(16)
});
const protectedUploadAttachmentSchema = uploadAttachmentBaseSchema.extend({
  expectedKeyEpoch: z.number().int().positive(),
  metadataCipher: z.string().min(1),
  metadataNonce: z.string().min(16),
  metadataFormatVersion: z.literal(2)
});
const legacyUploadAttachmentSchema = uploadAttachmentBaseSchema.extend({
  filename: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(120)
});
const uploadAttachmentSchema = z.union([
  protectedUploadAttachmentSchema,
  legacyUploadAttachmentSchema
]);

function getAttachment(
  context: AppContext,
  attachmentId: string
) {
  return context.db.attachmentMetadata.find(attachmentId);
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
    expectedKeyEpoch: Number(headerValue(request, "x-fortnote-expected-key-epoch")),
    metadataCipher: headerValue(request, "x-fortnote-metadata-cipher"),
    metadataNonce: headerValue(request, "x-fortnote-metadata-nonce"),
    metadataFormatVersion: Number(
      headerValue(request, "x-fortnote-metadata-format-version")
    ),
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

function sendAttachmentGateError(response: Response, kind: AttachmentGateError): void {
  if (kind === "not-found") {
    sendApiError(response, "not_found", "Note not found");
  } else if (kind === "unauthorized") {
    sendApiError(response, "unauthorized", "Session expired during upload");
  } else if (kind === "stale-epoch") {
    sendApiError(response, "stale_epoch", "Note protection changed; encrypt again");
  } else if (kind === "rotation-pending") {
    sendApiError(response, "rotation_pending", "Note protection is changing");
  } else if (kind === "quota") {
    sendApiError(response, "quota_exceeded", "Storage quota exceeded");
  } else if (kind === "duplicate") {
    sendApiError(response, "conflict", "Attachment already exists");
  } else {
    sendApiError(response, "conflict", "Restore note before attaching files");
  }
}

export function createAttachmentsRouter(context: AppContext): Router {
  const router = Router();

  router.post("/notes/:noteId/attachments", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = uploadAttachmentSchema.safeParse(uploadMetadata(request));
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid attachment payload");
      return;
    }

    const payload = parsed.data;
    const contentLength = declaredContentLength(request);
    if (Number.isNaN(contentLength)) {
      sendApiError(response, "bad_request", "Invalid Content-Length");
      return;
    }
    if (payload.size > LIMITS.maxAttachmentBytes) {
      sendApiError(response, "payload_too_large", "Attachment too large");
      return;
    }
    if (contentLength !== null && contentLength !== payload.size) {
      sendApiError(response, "bad_request", "Attachment size mismatch");
      return;
    }
    if ("filename" in payload && !safeDisplayFilename(payload.filename)) {
      sendApiError(response, "bad_request", "Invalid attachment filename");
      return;
    }
    const reservation = await context.db.attachmentMutations.reserve({
      noteId: request.params.noteId,
      userId: session.userId,
      attachmentId: payload.id,
      size: payload.size,
      storageQuotaBytes: context.config.storageQuotaBytes,
      ...("expectedKeyEpoch" in payload
        ? { expectedKeyEpoch: payload.expectedKeyEpoch }
        : {})
    });
    if (reservation.kind !== "reserved") {
      sendAttachmentGateError(response, reservation.kind);
      return;
    }

    const storageId = crypto.randomUUID();
    let committed = false;
    try {
      await context.db.attachmentStorage.write({
        storageId,
        source: request,
        expectedBytes: payload.size,
        maxBytes: LIMITS.maxAttachmentBytes
      });
      const clientInstanceId = requestClientInstanceId(request);
      const outcome = await context.db.attachmentMutations.commit({
        sessionId: session.id,
        actorUserId: session.userId,
        noteId: request.params.noteId,
        ownerUserId: reservation.ownerUserId,
        expectedKeyEpoch: reservation.expectedKeyEpoch,
        storageKey: storageId,
        attachment: {
          id: payload.id,
          filename: "filename" in payload ? payload.filename.trim() : "",
          mimeType: "mimeType" in payload ? payload.mimeType : "",
          metadataCipher: "metadataCipher" in payload ? payload.metadataCipher : null,
          metadataNonce: "metadataNonce" in payload ? payload.metadataNonce : null,
          metadataFormatVersion:
            "metadataFormatVersion" in payload ? payload.metadataFormatVersion : null,
          size: payload.size,
          encryptedAttachmentKey: payload.encryptedAttachmentKey,
          attachmentKeyNonce: payload.attachmentKeyNonce,
          fileNonce: payload.fileNonce
        },
        ...(clientInstanceId ? { clientInstanceId } : {})
      });
      if (outcome.kind !== "committed") {
        sendAttachmentGateError(response, outcome.kind);
        return;
      }
      committed = true;
      publishEventCursor(context, outcome.cursor);
      response.status(201).json({
        id: payload.id,
        keyEpoch: reservation.expectedKeyEpoch
      });
    } catch (error) {
      if (error instanceof AttachmentCiphertextSizeError) {
        sendApiError(
          response,
          error.kind === "too-large" ? "payload_too_large" : "bad_request",
          error.message
        );
        return;
      }
      throw error;
    } finally {
      if (!committed) {
        await context.db.attachmentMutations.release(
          reservation.ownerUserId,
          payload.size
        );
        await context.db.attachmentStorage.delete(storageId);
      }
    }
  });

  router.get("/notes/:noteId/attachments", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const access = await getNoteAccessAsync(
      context,
      request.params.noteId,
      session.userId
    );
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const rows = await context.db.attachmentMetadata.list(access.noteId);

    response.json({
      attachments: rows.map((row) => ({
        ...row,
        filename: row.metadataFormatVersion === 2 ? undefined : row.filename,
        mimeType: row.metadataFormatVersion === 2 ? undefined : row.mimeType
      }))
    });
  });

  router.get("/attachments/:id", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const attachment = await getAttachment(context, request.params.id);
    if (!attachment) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }
    const access = await getNoteAccessAsync(
      context,
      attachment.noteId,
      session.userId
    );
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }

    response.status(200);
    response.set({
      "content-type": "application/octet-stream",
      "content-length": String(attachment.size),
      "x-fortnote-attachment-id": attachment.id,
      "x-fortnote-note-id": attachment.noteId,
      "x-fortnote-key-epoch": String(attachment.keyEpoch)
    });
    const stream = await context.db.attachmentStorage.read(attachment.storageKey);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });

  router.delete("/attachments/:id", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const attachment = await getAttachment(context, request.params.id);
    if (!attachment) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }
    const access = await getNoteAccessAsync(
      context,
      attachment.noteId,
      session.userId
    );
    if (!canEditNote(access)) {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }

    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.attachmentMutations.delete({
      attachmentId: attachment.id,
      noteId: attachment.noteId,
      ownerUserId: attachment.userId,
      size: attachment.size,
      actorUserId: session.userId,
      noteVersion: access.version,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.kind === "not-found") {
      sendApiError(response, "not_found", "Attachment not found");
      return;
    }
    publishEventCursor(context, outcome.cursor);
    try {
      await context.db.attachmentStorage.delete(attachment.storageKey);
    } catch (error) {
      console.error("Unable to delete attachment ciphertext", error);
    }

    response.status(204).send();
  });

  return router;
}
