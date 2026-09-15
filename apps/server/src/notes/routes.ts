import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { canonicalTimestamp, withCanonicalTimestamps } from "../db/timestamps.js";
import { requireSessionAsync } from "../auth/session.js";
import { canOwnNote, canReadNote, getNoteAccessAsync } from "./access.js";
import { requestClientInstanceId } from "./events.js";
import { registerMembershipRoutes } from "./membershipRoutes.js";
import { registerSectionRoutes } from "./sectionRoutes.js";

const createNoteSchema = z.object({
  id: z.uuid(),
  folderId: z.uuid().nullable().optional(),
  rootSectionId: z.uuid(),
  titleCipher: z.string().min(1),
  titleNonce: z.string().min(16),
  titleFormatVersion: z.literal(2),
  encryptedNoteKey: z.string().min(16),
  noteKeyNonce: z.string().min(16),
  noteKeyFormatVersion: z.literal(2)
});

const updateNoteSchema = z
  .object({
    folderId: z.uuid().nullable().optional(),
    titleCipher: z.string().min(1).optional(),
    titleNonce: z.string().min(16).optional(),
    titleFormatVersion: z.literal(2).optional(),
    encryptedNoteKey: z.string().min(16).optional(),
    noteKeyNonce: z.string().min(16).optional(),
    noteKeyFormatVersion: z.literal(2).optional(),
    rootSectionId: z.uuid().optional(),
    rootVersion: z.number().int().positive(),
    keyEpoch: z.number().int().positive()
  })
  .superRefine((value, context) => {
    const titleFieldCount = [
      value.titleCipher,
      value.titleNonce,
      value.titleFormatVersion
    ].filter((field) => field !== undefined).length;
    if (titleFieldCount !== 0 && titleFieldCount !== 3) {
      context.addIssue({ code: "custom", message: "Incomplete encrypted title" });
    }
    const keyFieldCount = [
      value.encryptedNoteKey,
      value.noteKeyNonce,
      value.noteKeyFormatVersion,
      value.rootSectionId
    ].filter((field) => field !== undefined).length;
    if (keyFieldCount !== 0 && keyFieldCount !== 4) {
      context.addIssue({ code: "custom", message: "Incomplete protected note key" });
    }
  });

const rotateNoteKeySchema = z.object({
  mode: z.literal("linked"),
  revokedUserId: z.uuid(),
  rootVersion: z.number().int().positive(),
  sourceEpoch: z.number().int().positive(),
  targetEpoch: z.number().int().positive(),
  encryptedNoteKey: z.string().min(16),
  noteKeyNonce: z.string().min(16),
  noteKeyFormatVersion: z.literal(2),
  titleCipher: z.string().min(1),
  titleNonce: z.string().min(16),
  titleFormatVersion: z.literal(2),
  previousKeyCipher: z.string().min(16),
  previousKeyNonce: z.string().min(16),
  linkFormatVersion: z.literal(2),
  shares: z.array(
    z.object({
      recipientUserId: z.uuid(),
      sharingKeyVersion: z.number().int().positive(),
      encryptedNoteKey: z.string().min(32),
      formatVersion: z.literal(2)
    })
  )
});

function publishEventCursors(context: AppContext, cursors: number[]): void {
  context.realtime?.publishEvents(cursors);
}

export function createNotesRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const includeDeleted = request.query.deleted === "true";
    const notes = await context.db.noteQueries.list(session.userId, includeDeleted);
    response.json({ notes: notes.map(withCanonicalTimestamps) });
  });

  router.post("/", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = createNoteSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid note payload");
      return;
    }

    const payload = parsed.data;
    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.noteMutations.create({
      noteId: payload.id,
      actorUserId: session.userId,
      folderId: payload.folderId ?? null,
      titleCipher: payload.titleCipher,
      titleNonce: payload.titleNonce,
      titleFormatVersion: payload.titleFormatVersion,
      encryptedNoteKey: payload.encryptedNoteKey,
      noteKeyNonce: payload.noteKeyNonce,
      noteKeyFormatVersion: payload.noteKeyFormatVersion,
      rootSectionId: payload.rootSectionId,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.kind === "invalid-folder") {
      sendApiError(response, "bad_request", "Invalid folder");
      return;
    }
    publishEventCursors(context, [outcome.eventCursor]);

    response.status(201).json({
      id: payload.id,
      version: 1,
      rootVersion: 1,
      keyEpoch: 1,
      rootSectionId: payload.rootSectionId
    });
  });

  router.get("/:id", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const row = await context.db.noteQueries.find(request.params.id, session.userId);

    if (!row) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    response.json(withCanonicalTimestamps(row));
  });

  registerSectionRoutes(router, context);
  registerMembershipRoutes(router, context);

  router.get("/:id/key-share", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const access = await getNoteAccessAsync(context, request.params.id, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (access.role === "owner") {
      sendApiError(response, "not_found", "Note key share not found");
      return;
    }

    const row = await context.db.noteQueries.keyShare(access.noteId, session.userId);

    if (!row) {
      sendApiError(response, "not_found", "Note key share not found");
      return;
    }

    response.json(withCanonicalTimestamps(row));
  });

  router.get("/:id/epoch-links", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }
    const access = await getNoteAccessAsync(context, request.params.id, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    const links = await context.db.noteQueries.epochLinks(access.noteId);
    response.json({ links: links.map(withCanonicalTimestamps) });
  });

  router.post("/:id/key-rotation", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = rotateNoteKeySchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid key rotation payload");
      return;
    }

    const rotation = parsed.data;
    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.noteRotations.rotateLinked({
      noteId: request.params.id,
      actorUserId: session.userId,
      revokedUserId: rotation.revokedUserId,
      rootVersion: rotation.rootVersion,
      sourceEpoch: rotation.sourceEpoch,
      targetEpoch: rotation.targetEpoch,
      encryptedNoteKey: rotation.encryptedNoteKey,
      noteKeyNonce: rotation.noteKeyNonce,
      noteKeyFormatVersion: rotation.noteKeyFormatVersion,
      titleCipher: rotation.titleCipher,
      titleNonce: rotation.titleNonce,
      titleFormatVersion: rotation.titleFormatVersion,
      previousKeyCipher: rotation.previousKeyCipher,
      previousKeyNonce: rotation.previousKeyNonce,
      linkFormatVersion: rotation.linkFormatVersion,
      shares: rotation.shares,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.kind === "not-found") {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (outcome.kind === "invalid-set") {
      sendApiError(response, "bad_request", "Key shares must match active members");
      return;
    }
    if (outcome.kind === "conflict") {
      sendApiError(response, "conflict", "Note rotation state changed");
      return;
    }
    context.realtime?.closeNoteAccess(request.params.id, rotation.revokedUserId);
    publishEventCursors(context, [outcome.eventCursor]);
    response.json({
      id: request.params.id,
      version: outcome.version,
      rootVersion: outcome.rootVersion,
      keyEpoch: outcome.keyEpoch
    });
  });

  router.put("/:id", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = updateNoteSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid note payload");
      return;
    }

    const update = parsed.data;
    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.noteMutations.updateProtected({
      noteId: request.params.id,
      actorUserId: session.userId,
      expectedRootVersion: update.rootVersion,
      expectedKeyEpoch: update.keyEpoch,
      folderId: update.folderId,
      titleCipher: update.titleCipher,
      titleNonce: update.titleNonce,
      titleFormatVersion: update.titleFormatVersion,
      encryptedNoteKey: update.encryptedNoteKey,
      noteKeyNonce: update.noteKeyNonce,
      noteKeyFormatVersion: update.noteKeyFormatVersion,
      rootSectionId: update.rootSectionId,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.kind === "not-found") {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (outcome.kind === "invalid-folder") {
      sendApiError(response, "bad_request", "Invalid folder");
      return;
    }
    if (outcome.kind === "conflict") {
      sendApiError(response, "conflict", "Note metadata changed");
      return;
    }
    publishEventCursors(context, [outcome.eventCursor]);
    response.json({
      id: request.params.id,
      rootVersion: outcome.rootVersion,
      keyEpoch: outcome.keyEpoch,
      updatedAt: canonicalTimestamp(outcome.updatedAt)
    });
  });

  router.delete("/:id", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const access = await getNoteAccessAsync(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const clientInstanceId = requestClientInstanceId(request);
    const cursor = await context.db.noteLifecycle.setDeleted({
      noteId: access.noteId,
      ownerUserId: session.userId,
      actorUserId: session.userId,
      noteVersion: access.version,
      deleted: true,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (cursor === null) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    publishEventCursors(context, [cursor]);

    response.status(204).send();
  });

  router.post("/:id/restore", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const access = await getNoteAccessAsync(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const clientInstanceId = requestClientInstanceId(request);
    const cursor = await context.db.noteLifecycle.setDeleted({
      noteId: access.noteId,
      ownerUserId: session.userId,
      actorUserId: session.userId,
      noteVersion: access.version,
      deleted: false,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (cursor === null) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    publishEventCursors(context, [cursor]);

    response.json({ id: access.noteId });
  });

  router.delete("/:id/permanent", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const access = await getNoteAccessAsync(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.noteLifecycle.permanentlyDelete({
      noteId: access.noteId,
      ownerUserId: session.userId,
      actorUserId: session.userId,
      noteVersion: access.version,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (!outcome) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    publishEventCursors(context, [outcome.cursor]);
    await Promise.all(
      outcome.storageKeys.map((storageKey) =>
        context.db.attachmentStorage.delete(storageKey).catch((error: unknown) => {
          console.error("Unable to delete attachment ciphertext", error);
        })
      )
    );

    response.status(204).send();
  });

  return router;
}
