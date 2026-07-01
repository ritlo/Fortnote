import { randomUUID } from "node:crypto";
import type { AppContext } from "../http/app.js";

export type NoteEventType =
  | "note.created"
  | "note.updated"
  | "note.deleted"
  | "note.restored"
  | "note.permanently_deleted"
  | "membership.added"
  | "membership.role_updated"
  | "membership.revoked";

interface WriteNoteEventInput {
  noteId: string;
  actorUserId: string;
  eventType: NoteEventType;
  noteVersion: number | null;
  resourceType?: "note" | "membership";
  resourceId?: string;
  payloadMetadata?: Record<string, unknown>;
}

export function writeNoteEvent(
  context: AppContext,
  {
    noteId,
    actorUserId,
    eventType,
    noteVersion,
    resourceType = "note",
    resourceId = noteId,
    payloadMetadata
  }: WriteNoteEventInput
): void {
  context.db.sqlite
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
      resourceId,
      noteId,
      actorUserId,
      eventType,
      noteVersion,
      payloadMetadata ? JSON.stringify(payloadMetadata) : null
    );
}
