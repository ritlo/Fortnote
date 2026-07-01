import { randomUUID } from "node:crypto";
import type { AppContext } from "../http/app.js";

export type NoteEventType =
  | "note.created"
  | "note.updated"
  | "note.deleted"
  | "note.restored"
  | "note.permanently_deleted";

interface WriteNoteEventInput {
  noteId: string;
  actorUserId: string;
  eventType: NoteEventType;
  noteVersion: number | null;
  payloadMetadata?: Record<string, unknown>;
}

export function writeNoteEvent(
  context: AppContext,
  {
    noteId,
    actorUserId,
    eventType,
    noteVersion,
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
      ) VALUES (?, 'note', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      noteId,
      noteId,
      actorUserId,
      eventType,
      noteVersion,
      payloadMetadata ? JSON.stringify(payloadMetadata) : null
    );
}
