import type { AppContext } from "../http/app.js";

export interface CollaborationEvent {
  cursor: number;
  eventId: string;
  type: string;
  resourceType: string;
  resourceId: string;
  noteId: string | null;
  actorUserId: string;
  version: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface EventRow {
  cursor: number;
  eventId: string;
  resourceType: string;
  resourceId: string;
  noteId: string | null;
  actorUserId: string;
  eventType: string;
  noteVersion: number | null;
  payloadMetadata: string | null;
  createdAt: string;
}

export function listVisibleEvents(
  context: AppContext,
  userId: string,
  after: number,
  limit: number
): CollaborationEvent[] {
  const rows = context.db.sqlite
    .prepare(
      `SELECT note_events.cursor,
              note_events.event_id AS eventId,
              note_events.resource_type AS resourceType,
              note_events.resource_id AS resourceId,
              note_events.note_id AS noteId,
              note_events.actor_user_id AS actorUserId,
              note_events.event_type AS eventType,
              note_events.note_version AS noteVersion,
              note_events.payload_metadata AS payloadMetadata,
              note_events.created_at AS createdAt
       FROM note_events
       LEFT JOIN note_memberships
         ON note_memberships.note_id = note_events.note_id
        AND note_memberships.user_id = ?
        AND note_memberships.status = 'active'
       LEFT JOIN event_acknowledgements
         ON event_acknowledgements.note_id = note_events.note_id
        AND event_acknowledgements.user_id = ?
       WHERE note_events.cursor > ?
         AND (
           note_memberships.user_id IS NOT NULL
           OR (
             note_events.event_type = 'membership.revoked'
             AND json_extract(note_events.payload_metadata, '$.membershipUserId') = ?
             AND (
               event_acknowledgements.cursor IS NULL
               OR event_acknowledgements.cursor < note_events.cursor
             )
           )
         )
       ORDER BY note_events.cursor
       LIMIT ?`
    )
    .all(userId, userId, after, userId, limit) as EventRow[];

  return rows.map((row) => ({
    cursor: row.cursor,
    eventId: row.eventId,
    type: row.eventType,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    noteId: row.noteId,
    actorUserId: row.actorUserId,
    version: row.noteVersion,
    metadata: parseMetadata(row.payloadMetadata),
    createdAt: row.createdAt
  }));
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

export function acknowledgeVisibleEvents(
  context: AppContext,
  userId: string,
  cursor: number
): void {
  context.db.sqlite
    .prepare(
      `INSERT INTO event_acknowledgements (user_id, note_id, cursor, updated_at)
       SELECT ?,
              note_events.note_id,
              MAX(note_events.cursor),
              CURRENT_TIMESTAMP
       FROM note_events
       WHERE note_events.cursor <= ?
         AND note_events.note_id IS NOT NULL
         AND note_events.event_type = 'membership.revoked'
         AND json_extract(note_events.payload_metadata, '$.membershipUserId') = ?
       GROUP BY note_events.note_id
       ON CONFLICT(user_id, note_id) DO UPDATE SET
         cursor = MAX(event_acknowledgements.cursor, excluded.cursor),
         updated_at = CURRENT_TIMESTAMP`
    )
    .run(userId, cursor, userId);
}
