import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import * as schema from "../db/schema.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { requireSession } from "../auth/session.js";
import { writeRequestEvent } from "../notes/events.js";

const folderPayloadSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().min(1).max(120),
  parentFolderId: z.uuid().nullable().optional()
});

function getFolder(context: AppContext, folderId: string) {
  return context.db.orm
    .select({
      id: schema.folders.id,
      userId: schema.folders.userId,
      name: schema.folders.name,
      parentFolderId: schema.folders.parentFolderId
    })
    .from(schema.folders)
    .where(eq(schema.folders.id, folderId))
    .get();
}

function validateParent(
  context: AppContext,
  userId: string,
  parentFolderId: string | null | undefined,
  ownFolderId?: string
): boolean {
  if (!parentFolderId) {
    return true;
  }

  if (parentFolderId === ownFolderId) {
    return false;
  }

  const parent = getFolder(context, parentFolderId);
  return parent?.userId === userId && parent.parentFolderId === null;
}

function publishEventCursor(context: AppContext, cursor: number): void {
  context.realtime?.publishEvents([cursor]);
}

export function createFoldersRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const rows = context.db.orm
      .select({
        id: schema.folders.id,
        name: schema.folders.name,
        parentFolderId: schema.folders.parentFolderId,
        createdAt: schema.folders.createdAt,
        updatedAt: schema.folders.updatedAt
      })
      .from(schema.folders)
      .where(eq(schema.folders.userId, session.userId))
      .orderBy(sql`${schema.folders.parentFolderId} IS NOT NULL`, schema.folders.name)
      .all();

    response.json({ folders: rows });
  });

  router.post("/", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = folderPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid folder payload");
      return;
    }

    const parentFolderId = parsed.data.parentFolderId ?? null;
    if (!validateParent(context, session.userId, parentFolderId)) {
      sendApiError(response, "bad_request", "Invalid parent folder");
      return;
    }

    const id = parsed.data.id ?? crypto.randomUUID();
    const cursor = context.db.orm.transaction((tx) => {
      tx.insert(schema.folders).values({
        id,
        userId: session.userId,
        name: parsed.data.name,
        parentFolderId
      }).run();
      return writeRequestEvent(context, request, {
        noteId: null,
        actorUserId: session.userId,
        eventType: "folder.created",
        noteVersion: null,
        resourceType: "folder",
        resourceId: id,
        payloadMetadata: {
          folderId: id
        }
      }, tx);
    });
    publishEventCursor(context, cursor);

    response.status(201).json({ id, name: parsed.data.name, parentFolderId });
  });

  router.put("/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = folderPayloadSchema.omit({ id: true }).safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid folder payload");
      return;
    }

    const folder = getFolder(context, request.params.id);
    if (!folder) {
      sendApiError(response, "not_found", "Folder not found");
      return;
    }
    if (folder.userId !== session.userId) {
      sendApiError(response, "not_found", "Folder not found");
      return;
    }

    const parentFolderId = parsed.data.parentFolderId ?? null;
    if (!validateParent(context, session.userId, parentFolderId, folder.id)) {
      sendApiError(response, "bad_request", "Invalid parent folder");
      return;
    }

    const cursor = context.db.orm.transaction((tx) => {
      tx.update(schema.folders)
        .set({
          name: parsed.data.name,
          parentFolderId,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(and(
          eq(schema.folders.id, folder.id),
          eq(schema.folders.userId, session.userId)
        ))
        .run();
      return writeRequestEvent(context, request, {
        noteId: null,
        actorUserId: session.userId,
        eventType: "folder.updated",
        noteVersion: null,
        resourceType: "folder",
        resourceId: folder.id,
        payloadMetadata: {
          folderId: folder.id
        }
      }, tx);
    });
    publishEventCursor(context, cursor);

    response.json({ id: folder.id, name: parsed.data.name, parentFolderId });
  });

  router.delete("/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const folder = getFolder(context, request.params.id);
    if (!folder) {
      sendApiError(response, "not_found", "Folder not found");
      return;
    }
    if (folder.userId !== session.userId) {
      sendApiError(response, "not_found", "Folder not found");
      return;
    }

    const moveTarget = folder.parentFolderId;
    const cursor = context.db.orm.transaction((tx) => {
      tx.delete(schema.folders)
        .where(and(
          eq(schema.folders.id, folder.id),
          eq(schema.folders.userId, session.userId)
        ))
        .run();
      return writeRequestEvent(context, request, {
        noteId: null,
        actorUserId: session.userId,
        eventType: "folder.deleted",
        noteVersion: null,
        resourceType: "folder",
        resourceId: folder.id,
        payloadMetadata: {
          folderId: folder.id,
          parentFolderId: moveTarget
        }
      }, tx);
    });
    publishEventCursor(context, cursor);

    response.status(204).send();
  });

  return router;
}
