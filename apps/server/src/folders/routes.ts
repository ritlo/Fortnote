import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { withCanonicalTimestamps } from "../db/timestamps.js";
import { requireSessionAsync } from "../auth/session.js";
import { requestClientInstanceId } from "../notes/events.js";

const legacyFolderPayloadSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().min(1).max(120),
  parentFolderId: z.uuid().nullable().optional()
});
const protectedFolderPayloadSchema = z.object({
  id: z.uuid().optional(),
  nameCipher: z.string().min(1),
  nameNonce: z.string().min(16),
  nameFormatVersion: z.literal(2),
  parentFolderId: z.uuid().nullable().optional()
});
const folderPayloadSchema = z.union([
  protectedFolderPayloadSchema,
  legacyFolderPayloadSchema
]);

function protectedFolderValues(
  payload:
    | z.infer<typeof protectedFolderPayloadSchema>
    | z.infer<typeof legacyFolderPayloadSchema>
) {
  return "nameCipher" in payload
    ? {
        name: "",
        nameCipher: payload.nameCipher,
        nameNonce: payload.nameNonce,
        nameFormatVersion: payload.nameFormatVersion
      }
    : {
        name: payload.name,
        nameCipher: null,
        nameNonce: null,
        nameFormatVersion: null
      };
}

function publishEventCursor(context: AppContext, cursor: number): void {
  context.realtime?.publishEvents([cursor]);
}

export function createFoldersRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const rows = await context.db.folders.list(session.userId);

    response.json({ folders: rows.map(withCanonicalTimestamps) });
  });

  router.post("/", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = folderPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid folder payload");
      return;
    }

    const parentFolderId = parsed.data.parentFolderId ?? null;
    const id = parsed.data.id ?? crypto.randomUUID();
    const nameValues = protectedFolderValues(parsed.data);
    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.folders.create({
      folderId: id,
      userId: session.userId,
      ...nameValues,
      parentFolderId,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.kind === "invalid-parent") {
      sendApiError(response, "bad_request", "Invalid parent folder");
      return;
    }
    if (outcome.kind === "not-found") {
      sendApiError(response, "not_found", "Folder not found");
      return;
    }
    publishEventCursor(context, outcome.cursor);

    response.status(201).json({
      id,
      ...nameValues,
      parentFolderId
    });
  });

  router.put("/:id", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = z
      .union([
        protectedFolderPayloadSchema.omit({ id: true }),
        legacyFolderPayloadSchema.omit({ id: true })
      ])
      .safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid folder payload");
      return;
    }

    const parentFolderId = parsed.data.parentFolderId ?? null;
    const nameValues = protectedFolderValues(parsed.data);
    const clientInstanceId = requestClientInstanceId(request);
    const outcome = await context.db.folders.update({
      folderId: request.params.id,
      userId: session.userId,
      ...nameValues,
      parentFolderId,
      ...(clientInstanceId ? { clientInstanceId } : {})
    });
    if (outcome.kind === "invalid-parent") {
      sendApiError(response, "bad_request", "Invalid parent folder");
      return;
    }
    if (outcome.kind === "not-found") {
      sendApiError(response, "not_found", "Folder not found");
      return;
    }
    publishEventCursor(context, outcome.cursor);

    response.json({
      id: request.params.id,
      ...nameValues,
      parentFolderId
    });
  });

  router.delete("/:id", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const outcome = await context.db.folders.delete(
      request.params.id,
      session.userId,
      requestClientInstanceId(request)
    );
    if (outcome.kind === "not-found") {
      sendApiError(response, "not_found", "Folder not found");
      return;
    }
    publishEventCursor(context, outcome.cursor);

    response.status(204).send();
  });

  return router;
}
