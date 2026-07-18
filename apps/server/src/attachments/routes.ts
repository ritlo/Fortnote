import { and, desc, eq, gt, sql } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { LIMITS } from "@fortnote/shared";
import { requireSession } from "../auth/session.js";
import * as schema from "../db/schema.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import {
  AttachmentCiphertextSizeError,
  deleteEncryptedAttachment,
  readEncryptedAttachment,
  safeDisplayFilename,
  writeEncryptedAttachment
} from "./storage.js";
import { canEditNote, canReadNote, getNoteAccess } from "../notes/access.js";
import { writeRequestEvent } from "../notes/events.js";

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
  return context.db.orm
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, attachmentId))
    .get();
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

type AttachmentGateError =
  | "conflict"
  | "duplicate"
  | "not-found"
  | "quota"
  | "rotation-pending"
  | "stale-epoch"
  | "unauthorized";

function attachmentMutationState(
  db: Pick<AppContext["db"]["orm"], "select">,
  noteId: string,
  userId: string
) {
  return db
    .select({
      noteId: schema.notes.id,
      ownerUserId: schema.notes.userId,
      version: schema.notes.version,
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
        eq(schema.notes.id, noteId),
        eq(schema.noteMemberships.userId, userId)
      )
    )
    .get();
}

function canMutateAttachment(
  state: ReturnType<typeof attachmentMutationState>
): state is NonNullable<typeof state> {
  return (
    state?.status === "active" &&
    (state.role === "owner" || state.role === "editor")
  );
}

function releaseAttachmentReservation(
  context: AppContext,
  ownerUserId: string,
  size: number
): void {
  context.db.orm
    .update(schema.storageAccounts)
    .set({
      reservedBytes: sql`MAX(${schema.storageAccounts.reservedBytes} - ${size}, 0)`,
      updatedAt: sql`CURRENT_TIMESTAMP`
    })
    .where(eq(schema.storageAccounts.userId, ownerUserId))
    .run();
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
    const session = requireSession(context.db, request, response);
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
    const reservation = context.db.orm.transaction((tx) => {
      const current = attachmentMutationState(
        tx,
        request.params.noteId,
        session.userId
      );
      if (!canMutateAttachment(current)) {
        return { kind: "not-found" as const };
      }
      if (current.isDeleted) {
        return { kind: "conflict" as const };
      }
      if (current.rotationFenced) {
        return { kind: "rotation-pending" as const };
      }
      const expectedKeyEpoch =
        "expectedKeyEpoch" in payload ? payload.expectedKeyEpoch : current.keyEpoch;
      if (current.keyEpoch !== expectedKeyEpoch) {
        return { kind: "stale-epoch" as const };
      }
      const duplicate = tx
        .select({ id: schema.attachments.id })
        .from(schema.attachments)
        .where(eq(schema.attachments.id, payload.id))
        .get();
      if (duplicate) {
        return { kind: "duplicate" as const };
      }

      tx.insert(schema.storageAccounts)
        .values({ userId: current.ownerUserId })
        .onConflictDoNothing()
        .run();
      const reserved = tx
        .update(schema.storageAccounts)
        .set({
          reservedBytes: sql`${schema.storageAccounts.reservedBytes} + ${payload.size}`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.storageAccounts.userId, current.ownerUserId),
            sql`${schema.storageAccounts.usedBytes} + ${schema.storageAccounts.reservedBytes} + ${payload.size} <= ${context.config.storageQuotaBytes}`
          )
        )
        .run();
      if (reserved.changes !== 1) {
        return { kind: "quota" as const };
      }
      return {
        kind: "reserved" as const,
        expectedKeyEpoch,
        ownerUserId: current.ownerUserId
      };
    });
    if (reservation.kind !== "reserved") {
      sendAttachmentGateError(response, reservation.kind);
      return;
    }

    const storageId = crypto.randomUUID();
    let committed = false;
    try {
      await writeEncryptedAttachment(
        context.config,
        storageId,
        request,
        payload.size,
        LIMITS.maxAttachmentBytes
      );
      const outcome = context.db.orm.transaction((tx) => {
        const now = new Date().toISOString();
        const activeSession = tx
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.id, session.id),
              gt(schema.sessions.idleExpiresAt, now),
              gt(schema.sessions.absoluteExpiresAt, now)
            )
          )
          .get();
        if (!activeSession) {
          return { kind: "unauthorized" as const };
        }
        const current = attachmentMutationState(
          tx,
          request.params.noteId,
          session.userId
        );
        if (!canMutateAttachment(current)) {
          return { kind: "not-found" as const };
        }
        if (current.isDeleted) {
          return { kind: "conflict" as const };
        }
        if (current.rotationFenced) {
          return { kind: "rotation-pending" as const };
        }
        if (
          current.ownerUserId !== reservation.ownerUserId ||
          current.keyEpoch !== reservation.expectedKeyEpoch
        ) {
          return { kind: "stale-epoch" as const };
        }
        const duplicate = tx
          .select({ id: schema.attachments.id })
          .from(schema.attachments)
          .where(eq(schema.attachments.id, payload.id))
          .get();
        if (duplicate) {
          return { kind: "duplicate" as const };
        }
        const quota = tx
          .select({ reservedBytes: schema.storageAccounts.reservedBytes })
          .from(schema.storageAccounts)
          .where(eq(schema.storageAccounts.userId, reservation.ownerUserId))
          .get();
        if (!quota || quota.reservedBytes < payload.size) {
          return { kind: "quota" as const };
        }

        tx.insert(schema.attachments).values({
          id: payload.id,
          noteId: current.noteId,
          userId: reservation.ownerUserId,
          filename: "filename" in payload ? payload.filename.trim() : "",
          mimeType: "mimeType" in payload ? payload.mimeType : "",
          metadataCipher: "metadataCipher" in payload ? payload.metadataCipher : null,
          metadataNonce: "metadataNonce" in payload ? payload.metadataNonce : null,
          metadataFormatVersion:
            "metadataFormatVersion" in payload ? payload.metadataFormatVersion : null,
          keyEpoch: reservation.expectedKeyEpoch,
          size: payload.size,
          encryptedAttachmentKey: payload.encryptedAttachmentKey,
          attachmentKeyNonce: payload.attachmentKeyNonce,
          fileCipherPath: storageId,
          fileNonce: payload.fileNonce
        }).run();
        tx.update(schema.storageAccounts)
          .set({
            usedBytes: sql`${schema.storageAccounts.usedBytes} + ${payload.size}`,
            reservedBytes: sql`${schema.storageAccounts.reservedBytes} - ${payload.size}`,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(eq(schema.storageAccounts.userId, reservation.ownerUserId))
          .run();
        const cursor = writeRequestEvent(context, request, {
          noteId: current.noteId,
          actorUserId: session.userId,
          eventType: "attachment.created",
          noteVersion: current.version,
          resourceType: "attachment",
          resourceId: payload.id,
          payloadMetadata: {
            attachmentId: payload.id,
            keyEpoch: reservation.expectedKeyEpoch
          }
        }, tx);
        return { kind: "committed" as const, cursor };
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
        releaseAttachmentReservation(
          context,
          reservation.ownerUserId,
          payload.size
        );
        await deleteEncryptedAttachment(context.config, storageId);
      }
    }
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
        metadataCipher: schema.attachments.metadataCipher,
        metadataNonce: schema.attachments.metadataNonce,
        metadataFormatVersion: schema.attachments.metadataFormatVersion,
        keyEpoch: schema.attachments.keyEpoch,
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

    response.json({
      attachments: rows.map((row) => ({
        ...row,
        filename: row.metadataFormatVersion === 2 ? undefined : row.filename,
        mimeType: row.metadataFormatVersion === 2 ? undefined : row.mimeType
      }))
    });
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
    const access = getNoteAccess(context, attachment.noteId, session.userId);
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
    const stream = readEncryptedAttachment(
      context.config,
      attachment.fileCipherPath
    );
    stream.on("error", () => response.destroy());
    stream.pipe(response);
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
      tx.update(schema.storageAccounts)
        .set({
          usedBytes: sql`MAX(${schema.storageAccounts.usedBytes} - ${attachment.size}, 0)`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(schema.storageAccounts.userId, attachment.userId))
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
