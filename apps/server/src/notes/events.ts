import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
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
  | "folder.created"
  | "folder.updated"
  | "folder.deleted";

export interface WriteNoteEventInput {
  noteId: string | null;
  actorUserId: string;
  eventType: NoteEventType;
  noteVersion: number | null;
  resourceType?: "note" | "membership" | "attachment" | "folder";
  resourceId?: string;
  payloadMetadata?: Record<string, unknown>;
  clientInstanceId?: string;
}

export function writeRequestEvent(
  context: AppContext,
  request: Request,
  input: WriteNoteEventInput
): number {
  const parsedClientId = clientInstanceIdSchema.safeParse(
    request.get("x-fortnote-client-id")
  );
  return writeNoteEvent(
    context,
    parsedClientId.success
      ? { ...input, clientInstanceId: parsedClientId.data }
      : input
  );
}

export function writeNoteEvent(
  context: AppContext,
  {
    noteId,
    actorUserId,
    eventType,
    noteVersion,
    resourceType = "note",
    resourceId,
    payloadMetadata,
    clientInstanceId
  }: WriteNoteEventInput
): number {
  const resolvedResourceId = resourceId ?? noteId;
  if (!resolvedResourceId) {
    throw new Error("Event resourceId is required when noteId is null");
  }

  const metadata = {
    ...payloadMetadata,
    ...(clientInstanceId ? { clientInstanceId } : {})
  };
  const result = context.db.sqlite
    .prepare(
      `INSERT INTO note_events (
        event_id,
        resource_type,
        resource_id,
        note_id,
        actor_user_id,
        event_type,
        note_version,
        payload_metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      resourceType,
      resolvedResourceId,
      noteId,
      actorUserId,
      eventType,
      noteVersion,
      Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
    );
  return Number(result.lastInsertRowid);
}
