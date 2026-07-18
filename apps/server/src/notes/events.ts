import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import * as schema from "../db/schema.js";
import type { AppContext } from "../http/app.js";

const clientInstanceIdSchema = z.uuid();

export type NoteEventType =
  | "note.created"
  | "note.updated"
  | "note.deleted"
  | "note.restored"
  | "note.permanently_deleted"
  | "membership.added"
  | "membership.role_updated"
  | "membership.revoked"
  | "attachment.created"
  | "attachment.deleted"
  | "section.created"
  | "section.deleted"
  | "folder.created"
  | "folder.updated"
  | "folder.deleted";

export interface WriteNoteEventInput {
  noteId: string | null;
  actorUserId: string;
  eventType: NoteEventType;
  noteVersion: number | null;
  resourceType?: "note" | "membership" | "attachment" | "folder" | "section";
  resourceId?: string;
  payloadMetadata?: Record<string, unknown>;
  clientInstanceId?: string;
}

export function writeRequestEvent(
  context: AppContext,
  request: Request,
  input: WriteNoteEventInput,
  db: Pick<AppContext["db"]["orm"], "insert"> = context.db.orm
): number {
  const parsedClientId = clientInstanceIdSchema.safeParse(
    request.get("x-fortnote-client-id")
  );
  const {
    noteId,
    actorUserId,
    eventType,
    noteVersion,
    resourceType = "note",
    resourceId,
    payloadMetadata,
    clientInstanceId
  } = parsedClientId.success
    ? { ...input, clientInstanceId: parsedClientId.data }
    : input;
  const resolvedResourceId = resourceId ?? noteId;
  if (!resolvedResourceId) {
    throw new Error("Event resourceId is required when noteId is null");
  }

  const metadata = {
    ...payloadMetadata,
    ...(clientInstanceId ? { clientInstanceId } : {})
  };
  return db
    .insert(schema.noteEvents)
    .values({
      eventId: randomUUID(),
      resourceType,
      resourceId: resolvedResourceId,
      noteId,
      actorUserId,
      eventType,
      noteVersion,
      payloadMetadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
    })
    .returning({ cursor: schema.noteEvents.cursor })
    .get().cursor;
}
