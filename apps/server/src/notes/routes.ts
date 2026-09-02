import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { requireSessionAsync } from "../auth/session.js";
import {
  canOwnNote,
  canReadNote,
  getNoteAccessAsync
} from "./access.js";
import { requestClientInstanceId } from "./events.js";

const legacyCreateNoteSchema = z.object({
  id: z.uuid(),
  folderId: z.uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  encryptedNoteKey: z.string().min(16),
  noteKeyNonce: z.string().min(16),
  contentCipher: z.string().min(1),
  contentNonce: z.string().min(16),
  contentLength: z.number().int().nonnegative()
});

const protectedCreateNoteSchema = z.object({
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

const createNoteSchema = z.union([protectedCreateNoteSchema, legacyCreateNoteSchema]);

const legacyUpdateNoteSchema = z.object({
  folderId: z.uuid().nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  contentCipher: z.string().min(1),
  contentNonce: z.string().min(16),
  contentLength: z.number().int().nonnegative(),
  version: z.number().int().positive()
});
const protectedUpdateNoteSchema = z
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
const updateNoteSchema = z.union([protectedUpdateNoteSchema, legacyUpdateNoteSchema]);
const legacySectionReservationSchema = z.object({
  sectionId: z.uuid(),
  expectedKeyEpoch: z.number().int().positive(),
  expectedRootVersion: z.number().int().positive()
});
const sectionInitializationSchema = z.object({
  manifestId: z.string().min(1),
  expectedKeyEpoch: z.number().int().positive(),
  expectedRootVersion: z.number().int().positive()
});
const sectionMutationSchema = z.object({
  expectedKeyEpoch: z.number().int().positive(),
  expectedRootVersion: z.number().int().positive()
});
const sectionCreateSchema = sectionMutationSchema.extend({ sectionId: z.uuid() });
const legacyRotateNoteKeySchema = z.object({
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
const linkedRotateNoteKeySchema = z.object({
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
const rotateNoteKeySchema = z.union([
  linkedRotateNoteKeySchema,
  legacyRotateNoteKeySchema
]);

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

function publishEventCursors(context: AppContext, cursors: number[]): void {
  context.realtime?.publishEvents(cursors);
}

function responseTimestamp(value: string): string {
  return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
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
    response.json({ notes });
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
    const folderId = payload.folderId ?? null;
    const rootSectionId = "rootSectionId" in payload ? payload.rootSectionId : null;
    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.noteMutations.create({
      noteId: payload.id,
      actorUserId: session.userId,
      folderId,
      title: "title" in payload ? payload.title : "",
      titleCipher: "titleCipher" in payload ? payload.titleCipher : null,
      titleNonce: "titleCipher" in payload ? payload.titleNonce : null,
      titleFormatVersion:
        "titleCipher" in payload ? payload.titleFormatVersion : null,
      encryptedNoteKey: payload.encryptedNoteKey,
      noteKeyNonce: payload.noteKeyNonce,
      noteKeyFormatVersion:
        "titleCipher" in payload ? payload.noteKeyFormatVersion : 1,
      contentCipher: "contentCipher" in payload ? payload.contentCipher : "",
      contentNonce: "contentCipher" in payload ? payload.contentNonce : "",
      contentLength: "contentCipher" in payload ? payload.contentLength : 0,
      rootSectionId,
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
      rootSectionId
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

    response.json(row);
  });

  router.get("/:id/legacy-content", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }
    const access = await getNoteAccessAsync(context, request.params.id, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    const legacy = await context.db.noteQueries.legacyContent(access.noteId);
    if (!legacy) {
      sendApiError(response, "conflict", "Legacy note content is already migrated");
      return;
    }
    response.json(legacy);
  });

  router.post("/:id/sections/legacy-reservation", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }
    const parsed = legacySectionReservationSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid legacy migration reservation");
      return;
    }
    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.noteSections.reserveLegacy({
      sessionId: session.id,
      userId: session.userId,
      noteId: request.params.id,
      sectionId: parsed.data.sectionId,
      expectedKeyEpoch: parsed.data.expectedKeyEpoch,
      expectedRootVersion: parsed.data.expectedRootVersion,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.status === "rejected") {
      if (outcome.code === "forbidden") {
        sendApiError(response, "not_found", "Note not found");
      } else {
        sendApiError(response, "conflict", legacyMigrationConflict(outcome.code));
      }
      return;
    }
    if (outcome.eventCursor !== null) {
      publishEventCursors(context, [outcome.eventCursor]);
    }
    response.status(outcome.changed ? 201 : 200).json({
      status: outcome.status,
      sectionId: outcome.sectionId,
      keyEpoch: outcome.keyEpoch,
      rootVersion: outcome.rootVersion,
      version: outcome.version,
      ...(outcome.manifestId ? { manifestId: outcome.manifestId } : {})
    });
  });

  router.post("/:id/sections", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }
    const parsed = sectionCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid section creation");
      return;
    }
    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.noteSections.create({
      sessionId: session.id,
      userId: session.userId,
      noteId: request.params.id,
      sectionId: parsed.data.sectionId,
      expectedKeyEpoch: parsed.data.expectedKeyEpoch,
      expectedRootVersion: parsed.data.expectedRootVersion,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.status === "rejected") {
      sendSectionMutationError(response, outcome.code);
      return;
    }
    if (outcome.eventCursor !== null) {
      publishEventCursors(context, [outcome.eventCursor]);
    }
    response.status(outcome.status === "created" ? 201 : 200).json({
      status: outcome.status,
      rootVersion: outcome.rootVersion,
      version: outcome.version,
      section: {
        id: parsed.data.sectionId,
        noteId: request.params.id,
        createdEpoch: parsed.data.expectedKeyEpoch,
        currentSequence: 0,
        initialized: false,
        isDeleted: false
      }
    });
  });

  router.delete("/:id/sections/:sectionId", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }
    const parsed = sectionMutationSchema.safeParse(request.body);
    if (!parsed.success || !z.uuid().safeParse(request.params.sectionId).success) {
      sendApiError(response, "bad_request", "Invalid section deletion");
      return;
    }
    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.noteSections.tombstone({
      sessionId: session.id,
      userId: session.userId,
      noteId: request.params.id,
      sectionId: request.params.sectionId,
      expectedKeyEpoch: parsed.data.expectedKeyEpoch,
      expectedRootVersion: parsed.data.expectedRootVersion,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.status === "rejected") {
      sendSectionMutationError(response, outcome.code);
      return;
    }
    if (outcome.eventCursor !== null) {
      publishEventCursors(context, [outcome.eventCursor]);
    }
    response.json({
      status: outcome.status,
      rootVersion: outcome.rootVersion,
      version: outcome.version
    });
  });

  router.post(
    "/:id/sections/:sectionId/initialization",
    async (request, response) => {
      const session = await requireSessionAsync(context.db, request, response);
      if (!session) {
        return;
      }
      const parsed = sectionInitializationSchema.safeParse(request.body);
      if (!parsed.success) {
        sendApiError(response, "bad_request", "Invalid section initialization");
        return;
      }
      const clientInstanceId = requestClientInstanceId(request);
      const outcome = await context.db.noteSections.initialize({
        sessionId: session.id,
        userId: session.userId,
        noteId: request.params.id,
        sectionId: request.params.sectionId,
        expectedKeyEpoch: parsed.data.expectedKeyEpoch,
        expectedRootVersion: parsed.data.expectedRootVersion,
        manifestId: parsed.data.manifestId,
        ...(clientInstanceId ? { clientInstanceId } : {})
      });
      if (outcome.status === "rejected") {
        if (outcome.code === "forbidden") {
          sendApiError(response, "not_found", "Note not found");
        } else {
          sendApiError(response, "conflict", legacyMigrationConflict(outcome.code));
        }
        return;
      }
      if (outcome.eventCursor !== null) {
        publishEventCursors(context, [outcome.eventCursor]);
      }
      response.json({
        status: outcome.status,
        manifestId: outcome.manifestId,
        rootVersion: outcome.rootVersion,
        version: outcome.version
      });
    }
  );

  router.get("/:id/sections", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }
    const access = await getNoteAccessAsync(
      context,
      request.params.id,
      session.userId
    );
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    const sections = await context.db.noteSections.list(access.noteId);
    response.json({
      sections: sections.map((section) => ({
        id: section.id,
        noteId: section.noteId,
        createdEpoch: section.createdEpoch,
        currentSequence: section.currentSequence,
        initialized: section.initializationManifestId !== null,
        isDeleted: section.isDeleted
      }))
    });
  });
  router.get("/:id/memberships", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const access = await getNoteAccessAsync(context, request.params.id, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const memberships = await context.db.noteQueries.memberships(access.noteId);
    response.json({ memberships });
  });

  router.post("/:id/memberships", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = inviteMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid membership payload");
      return;
    }

    const access = await getNoteAccessAsync(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.noteMemberships.invite({
      noteId: access.noteId,
      actorUserId: session.userId,
      noteVersion: access.version,
      username: parsed.data.username,
      role: parsed.data.role,
      sharingKeyVersion: parsed.data.sharingKeyVersion,
      encryptedNoteKey: parsed.data.encryptedNoteKey,
      formatVersion: parsed.data.formatVersion,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.status === "note_not_found") {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (outcome.status === "sharing_key_not_found") {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }
    if (outcome.status === "self") {
      sendApiError(response, "bad_request", "Cannot invite yourself");
      return;
    }
    if (outcome.status === "owner") {
      sendApiError(response, "bad_request", "Cannot replace note owner");
      return;
    }
    publishEventCursors(context, [outcome.cursor]);

    response.status(201).json({
      noteId: access.noteId,
      userId: outcome.userId,
      username: outcome.username,
      role: parsed.data.role,
      status: "active"
    });
  });

  router.patch("/:id/memberships/:userId", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = updateMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid membership payload");
      return;
    }

    const access = await getNoteAccessAsync(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (request.params.userId === session.userId) {
      sendApiError(response, "bad_request", "Cannot change owner role");
      return;
    }

    const clientInstanceId = requestClientInstanceId(request);
    const updateCursor = await context.db.noteMemberships.updateRole({
      noteId: access.noteId,
      actorUserId: session.userId,
      targetUserId: request.params.userId,
      noteVersion: access.version,
      role: parsed.data.role,
      ...(clientInstanceId ? { clientInstanceId } : {})
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

  router.delete("/:id/memberships/:userId", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const access = await getNoteAccessAsync(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (request.params.userId === session.userId) {
      sendApiError(response, "bad_request", "Cannot revoke note owner");
      return;
    }

    const clientInstanceId = requestClientInstanceId(request);
    const revokeCursor = await context.db.noteMemberships.revoke({
      noteId: access.noteId,
      actorUserId: session.userId,
      targetUserId: request.params.userId,
      noteVersion: access.version,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (revokeCursor === null) {
      sendApiError(response, "not_found", "Membership not found");
      return;
    }
    context.realtime?.closeNoteAccess(access.noteId, request.params.userId);
    publishEventCursors(context, [revokeCursor]);

    response.status(204).send();
  });

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

    response.json(row);
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
    response.json({ links });
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

    const clientInstanceId = requestClientInstanceId(request);
    if ("mode" in parsed.data) {
      const rotation = parsed.data;
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
      context.realtime?.closeNoteAccess(
        request.params.id,
        rotation.revokedUserId
      );
      publishEventCursors(context, [outcome.eventCursor]);
      response.json({
        id: request.params.id,
        version: outcome.version,
        rootVersion: outcome.rootVersion,
        keyEpoch: outcome.keyEpoch
      });
      return;
    }

    const rotation = parsed.data;
    const outcome = await context.db.noteRotations.rotateLegacy({
      noteId: request.params.id,
      actorUserId: session.userId,
      encryptedNoteKey: rotation.encryptedNoteKey,
      noteKeyNonce: rotation.noteKeyNonce,
      contentCipher: rotation.contentCipher,
      contentNonce: rotation.contentNonce,
      contentLength: rotation.contentLength,
      version: rotation.version,
      shares: rotation.shares,
      attachmentKeys: rotation.attachmentKeys,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.kind === "not-found") {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (outcome.kind === "deleted") {
      sendApiError(response, "conflict", "Restore note before rotating keys");
      return;
    }
    if (outcome.kind === "conflict") {
      sendApiError(response, "conflict", "Note version conflict");
      return;
    }
    if (outcome.kind === "invalid-members") {
      sendApiError(response, "bad_request", "Key shares must cover all active members");
      return;
    }
    if (outcome.kind === "invalid-sharing-key") {
      sendApiError(response, "bad_request", "Invalid sharing key version");
      return;
    }
    if (outcome.kind === "invalid-attachments") {
      sendApiError(response, "bad_request", "Attachment keys must cover all attachments");
      return;
    }
    publishEventCursors(context, [outcome.eventCursor]);
    response.json({
      id: request.params.id,
      version: outcome.version,
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

    const clientInstanceId = requestClientInstanceId(request);
    if ("rootVersion" in parsed.data) {
      const update = parsed.data;
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
        updatedAt: responseTimestamp(outcome.updatedAt)
      });
      return;
    }

    const update = parsed.data;
    const outcome = await context.db.noteMutations.updateLegacy({
      noteId: request.params.id,
      actorUserId: session.userId,
      expectedVersion: update.version,
      folderId: update.folderId,
      title: update.title,
      contentCipher: update.contentCipher,
      contentNonce: update.contentNonce,
      contentLength: update.contentLength,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.kind === "not-found") {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (outcome.kind === "deleted") {
      sendApiError(response, "conflict", "Restore note before updating");
      return;
    }
    if (outcome.kind === "conflict") {
      sendApiError(response, "conflict", "Note version conflict");
      return;
    }
    if (outcome.kind === "shared-folder") {
      sendApiError(response, "bad_request", "Shared notes cannot be moved");
      return;
    }
    if (outcome.kind === "invalid-folder") {
      sendApiError(response, "bad_request", "Invalid folder");
      return;
    }
    publishEventCursors(context, [outcome.eventCursor]);
    response.json({
      id: request.params.id,
      version: outcome.version,
      updatedAt: responseTimestamp(outcome.updatedAt)
    });
  });
  router.delete("/:id", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const access = await getNoteAccessAsync(
      context,
      request.params.id,
      session.userId
    );
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

    const access = await getNoteAccessAsync(
      context,
      request.params.id,
      session.userId
    );
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

    const access = await getNoteAccessAsync(
      context,
      request.params.id,
      session.userId
    );
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

function legacyMigrationConflict(
  code: "rotation-pending" | "stale-epoch" | "stale-version"
): string {
  if (code === "rotation-pending") {
    return "Note-key rotation is pending";
  }
  return code === "stale-epoch"
    ? "Note key epoch changed"
    : "Note metadata changed";
}

function sendSectionMutationError(
  response: Parameters<typeof sendApiError>[0],
  code:
    | "forbidden"
    | "last-section"
    | "rotation-pending"
    | "stale-epoch"
    | "stale-version"
): void {
  if (code === "forbidden") {
    sendApiError(response, "not_found", "Note not found");
    return;
  }
  if (code === "last-section") {
    sendApiError(response, "conflict", "A note must keep at least one section");
    return;
  }
  sendApiError(response, "conflict", legacyMigrationConflict(code));
}
