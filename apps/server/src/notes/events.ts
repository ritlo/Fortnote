import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import * as schema from "../db/schema.js";
import type { AppContext } from "../http/app.js";

const clientInstanceIdSchema = z.uuid();

export function requestClientInstanceId(request: Request): string | undefined {
  const parsed = clientInstanceIdSchema.safeParse(
    request.get("x-fortnote-client-id")
  );
  return parsed.success ? parsed.data : undefined;
}

export function serializedEventMetadata(
  payloadMetadata: Record<string, unknown> | undefined,
  clientInstanceId: string | undefined
): string | null {
  const metadata = {
    ...payloadMetadata,
    ...(clientInstanceId ? { clientInstanceId } : {})
  };
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
}

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
  const requestClientId = requestClientInstanceId(request);
  const {
    noteId,
    actorUserId,
    eventType,
    noteVersion,
    resourceType = "note",
    resourceId,
    payloadMetadata,
    clientInstanceId
  } = requestClientId
    ? { ...input, clientInstanceId: requestClientId }
    : input;
  const resolvedResourceId = resourceId ?? noteId;
  if (!resolvedResourceId) {
    throw new Error("Event resourceId is required when noteId is null");
  }

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
      payloadMetadata: serializedEventMetadata(payloadMetadata, clientInstanceId)
    })
    .returning({ cursor: schema.noteEvents.cursor })
    .get().cursor;
}
