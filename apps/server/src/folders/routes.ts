import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { requireSession } from "../auth/session.js";
import { writeRequestEvent } from "../notes/events.js";

const folderPayloadSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().min(1).max(120),
  parentFolderId: z.uuid().nullable().optional()
});

interface FolderRow {
  id: string;
  userId: string;
  name: string;
  parentFolderId: string | null;
}

function getFolder(context: AppContext, folderId: string): FolderRow | undefined {
  return context.db.sqlite
    .prepare(
      `SELECT id,
              user_id AS userId,
              name,
              parent_folder_id AS parentFolderId
       FROM folders
       WHERE id = ?`
    )
    .get(folderId) as FolderRow | undefined;
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

    const rows = context.db.sqlite
      .prepare(
        `SELECT id, name, parent_folder_id AS parentFolderId, created_at AS createdAt, updated_at AS updatedAt
         FROM folders
         WHERE user_id = ?
         ORDER BY parent_folder_id IS NOT NULL, name`
      )
      .all(session.userId);

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
    const createFolder = context.db.sqlite.transaction(() => {
      context.db.sqlite
        .prepare(
          `INSERT INTO folders (id, user_id, name, parent_folder_id)
           VALUES (?, ?, ?, ?)`
        )
        .run(id, session.userId, parsed.data.name, parentFolderId);
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
      });
    });
    publishEventCursor(context, createFolder());

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

    const updateFolder = context.db.sqlite.transaction(() => {
      context.db.sqlite
        .prepare(
          `UPDATE folders
           SET name = ?, parent_folder_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ?`
        )
        .run(parsed.data.name, parentFolderId, folder.id, session.userId);
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
      });
    });
    publishEventCursor(context, updateFolder());

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
    const remove = context.db.sqlite.transaction(() => {
      context.db.sqlite
        .prepare(
          `UPDATE notes
           SET folder_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ? AND folder_id = ?`
        )
        .run(moveTarget, session.userId, folder.id);
      context.db.sqlite
        .prepare(
          `UPDATE folders
           SET parent_folder_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ? AND parent_folder_id = ?`
        )
        .run(moveTarget, session.userId, folder.id);
      context.db.sqlite
        .prepare("DELETE FROM folders WHERE id = ? AND user_id = ?")
        .run(folder.id, session.userId);
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
      });
    });
    publishEventCursor(context, remove());

    response.status(204).send();
  });

  return router;
}
