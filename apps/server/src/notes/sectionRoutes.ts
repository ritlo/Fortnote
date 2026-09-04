import type { Router } from "express";
import { z } from "zod";
import { requireSessionAsync } from "../auth/session.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { canReadNote, getNoteAccessAsync } from "./access.js";
import { requestClientInstanceId } from "./events.js";

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

export function registerSectionRoutes(router: Router, context: AppContext): void {
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
      publishEventCursor(context, outcome.eventCursor);
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
      publishEventCursor(context, outcome.eventCursor);
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
      publishEventCursor(context, outcome.eventCursor);
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
        publishEventCursor(context, outcome.eventCursor);
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
}

function publishEventCursor(context: AppContext, cursor: number): void {
  context.realtime?.publishEvents([cursor]);
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
