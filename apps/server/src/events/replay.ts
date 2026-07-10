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

export interface EventRetentionResult {
  prunedThroughCursor: number;
  deletedEvents: number;
  deletedAcknowledgements: number;
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
             note_events.note_id IS NULL
             AND note_events.actor_user_id = ?
           )
           OR (
             note_events.event_type = 'membership.revoked'
             AND json_extract(note_events.payload_metadata, '$.membershipUserId') = ?
             AND (
               event_acknowledgements.cursor IS NULL
               OR event_acknowledgements.cursor < note_events.cursor
             )
           )
           OR (
             note_events.event_type = 'note.permanently_deleted'
             AND EXISTS (
               SELECT 1
               FROM json_each(note_events.payload_metadata, '$.visibleUserIds')
               WHERE json_each.value = ?
             )
             AND (
               event_acknowledgements.cursor IS NULL
               OR event_acknowledgements.cursor < note_events.cursor
             )
           )
         )
       ORDER BY note_events.cursor
       LIMIT ?`
    )
    .all(userId, userId, after, userId, userId, userId, limit) as EventRow[];

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
      `INSERT INTO event_cursors (user_id, cursor, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         cursor = MAX(event_cursors.cursor, excluded.cursor),
         updated_at = CURRENT_TIMESTAMP`
    )
    .run(userId, cursor);

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
         AND (
           (
             note_events.event_type = 'membership.revoked'
             AND json_extract(note_events.payload_metadata, '$.membershipUserId') = ?
           )
           OR (
             note_events.event_type = 'note.permanently_deleted'
             AND EXISTS (
               SELECT 1
               FROM json_each(note_events.payload_metadata, '$.visibleUserIds')
               WHERE json_each.value = ?
             )
           )
         )
       GROUP BY note_events.note_id
       ON CONFLICT(user_id, note_id) DO UPDATE SET
         cursor = MAX(event_acknowledgements.cursor, excluded.cursor),
         updated_at = CURRENT_TIMESTAMP`
    )
    .run(userId, cursor, userId, userId);
}

export function getAcknowledgedEventCursor(
  context: AppContext,
  userId: string
): number {
  const row = context.db.sqlite
    .prepare("SELECT cursor FROM event_cursors WHERE user_id = ?")
    .get(userId) as { cursor: number } | undefined;
  return row?.cursor ?? 0;
}

export function pruneAcknowledgedEvents(
  context: AppContext,
  beforeCursor = Number.POSITIVE_INFINITY
): EventRetentionResult {
  const prunedThroughCursor = Number.isFinite(beforeCursor)
    ? beforeCursor
    : Number.MAX_SAFE_INTEGER;
  if (prunedThroughCursor <= 0) {
    return {
      prunedThroughCursor: Math.max(0, prunedThroughCursor),
      deletedEvents: 0,
      deletedAcknowledgements: 0
    };
  }

  return context.db.sqlite.transaction(() => {
    const deletedEvents = context.db.sqlite
      .prepare(
        `DELETE FROM note_events
         WHERE cursor <= ?
           AND NOT EXISTS (
             SELECT 1
             FROM note_memberships
             LEFT JOIN event_cursors
               ON event_cursors.user_id = note_memberships.user_id
             WHERE note_events.note_id IS NOT NULL
               AND note_memberships.note_id = note_events.note_id
               AND note_memberships.status = 'active'
               AND COALESCE(event_cursors.cursor, 0) < note_events.cursor
           )
           AND NOT EXISTS (
             SELECT 1
             FROM users AS actor
             LEFT JOIN event_cursors
               ON event_cursors.user_id = actor.id
             WHERE note_events.note_id IS NULL
               AND actor.id = note_events.actor_user_id
               AND COALESCE(event_cursors.cursor, 0) < note_events.cursor
           )
           AND NOT EXISTS (
             SELECT 1
             FROM users AS tombstone_user
             LEFT JOIN event_cursors
               ON event_cursors.user_id = tombstone_user.id
             WHERE (
               (
                 note_events.event_type = 'membership.revoked'
                 AND tombstone_user.id =
                   json_extract(note_events.payload_metadata, '$.membershipUserId')
               )
               OR (
                 note_events.event_type = 'note.permanently_deleted'
                 AND EXISTS (
                   SELECT 1
                   FROM json_each(note_events.payload_metadata, '$.visibleUserIds')
                   WHERE json_each.value = tombstone_user.id
                 )
               )
             )
               AND COALESCE(event_cursors.cursor, 0) < note_events.cursor
           )`
      )
      .run(prunedThroughCursor).changes;
    const deletedAcknowledgements = context.db.sqlite
      .prepare(
        `DELETE FROM event_acknowledgements
         WHERE NOT EXISTS (
           SELECT 1
           FROM note_events
           WHERE note_events.note_id = event_acknowledgements.note_id
             AND note_events.cursor <= event_acknowledgements.cursor
             AND (
               (
                 note_events.event_type = 'membership.revoked'
                 AND json_extract(note_events.payload_metadata, '$.membershipUserId') =
                   event_acknowledgements.user_id
               )
               OR (
                 note_events.event_type = 'note.permanently_deleted'
                 AND EXISTS (
                   SELECT 1
                   FROM json_each(note_events.payload_metadata, '$.visibleUserIds')
                   WHERE json_each.value = event_acknowledgements.user_id
                 )
               )
             )
         )`
      )
      .run().changes;
    return {
      prunedThroughCursor,
      deletedEvents,
      deletedAcknowledgements
    };
  })();
}
