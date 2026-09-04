import type { Router } from "express";
import { z } from "zod";
import { requireSessionAsync } from "../auth/session.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { canOwnNote, canReadNote, getNoteAccessAsync } from "./access.js";
import { requestClientInstanceId } from "./events.js";

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

export function registerMembershipRoutes(router: Router, context: AppContext): void {
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
    publishEventCursor(context, outcome.cursor);

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
    publishEventCursor(context, updateCursor);

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
    publishEventCursor(context, revokeCursor);

    response.status(204).send();
  });
}

function publishEventCursor(context: AppContext, cursor: number): void {
  context.realtime?.publishEvents([cursor]);
}
