import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

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

export interface EventReplayRepository {
  listVisible(userId: string, after: number, limit: number): Promise<CollaborationEvent[]>;
  acknowledge(userId: string, cursor: number): Promise<void>;
  acknowledgedCursor(userId: string): Promise<number>;
  prune(beforeCursor?: number): Promise<EventRetentionResult>;
}

export interface EventRow extends Record<string, unknown> {
  cursor: number | string;
  eventId: string;
  resourceType: string;
  resourceId: string;
  noteId: string | null;
  actorUserId: string;
  eventType: string;
  noteVersion: number | null;
  payloadMetadata: string | null;
  createdAt: string | Date;
}

export function mapEventRows(rows: EventRow[]): CollaborationEvent[] {
  return rows.map((row) => ({
    cursor: Number(row.cursor),
    eventId: row.eventId,
    type: row.eventType,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    noteId: row.noteId,
    actorUserId: row.actorUserId,
    version: row.noteVersion,
    metadata: parseMetadata(row.payloadMetadata),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt
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

export function retentionCursor(beforeCursor: number): number {
  return Number.isFinite(beforeCursor) ? beforeCursor : Number.MAX_SAFE_INTEGER;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

export class SqliteEventReplayRepository implements EventReplayRepository {
  constructor(private readonly orm: SqliteDatabase) {}

  listVisible(
    userId: string,
    after: number,
    limit: number
  ): Promise<CollaborationEvent[]> {
    const rows = this.orm.all<EventRow>(sql`
      SELECT note_events.cursor,
             note_events.event_id AS eventId,
             note_events.resource_type AS resourceType,
             note_events.resource_id AS resourceId,
             note_events.note_id AS noteId,
             note_events.actor_user_id AS actorUserId,
             note_events.event_type AS eventType,
             note_events.note_version AS noteVersion,
             note_events.payload_metadata AS payloadMetadata,
             note_events.created_at AS createdAt
      FROM ${schema.noteEvents} AS note_events
      LEFT JOIN ${schema.noteMemberships} AS note_memberships
        ON note_memberships.note_id = note_events.note_id
       AND note_memberships.user_id = ${userId}
       AND note_memberships.status = 'active'
      LEFT JOIN ${schema.eventAcknowledgements} AS event_acknowledgements
        ON event_acknowledgements.note_id = note_events.note_id
       AND event_acknowledgements.user_id = ${userId}
      WHERE note_events.cursor > ${after}
        AND (
          note_memberships.user_id IS NOT NULL
          OR (note_events.note_id IS NULL AND note_events.actor_user_id = ${userId})
          OR (
            note_events.event_type = 'membership.revoked'
            AND json_extract(note_events.payload_metadata, '$.membershipUserId') = ${userId}
            AND (event_acknowledgements.cursor IS NULL
                 OR event_acknowledgements.cursor < note_events.cursor)
          )
          OR (
            note_events.event_type = 'note.permanently_deleted'
            AND EXISTS (
              SELECT 1
              FROM json_each(note_events.payload_metadata, '$.visibleUserIds')
              WHERE json_each.value = ${userId}
            )
            AND (event_acknowledgements.cursor IS NULL
                 OR event_acknowledgements.cursor < note_events.cursor)
          )
        )
      ORDER BY note_events.cursor
      LIMIT ${limit}
    `);
    return Promise.resolve(mapEventRows(rows));
  }

  acknowledge(userId: string, cursor: number): Promise<void> {
    this.orm.transaction((transaction) => {
      transaction
        .insert(schema.eventCursors)
        .values({ userId, cursor })
        .onConflictDoUpdate({
          target: schema.eventCursors.userId,
          set: {
            cursor: sql`MAX(${schema.eventCursors.cursor}, excluded.cursor)`,
            updatedAt: sql`CURRENT_TIMESTAMP`
          }
        })
        .run();
      transaction.run(sql`
        INSERT INTO ${schema.eventAcknowledgements} (user_id, note_id, cursor, updated_at)
        SELECT ${userId}, note_events.note_id, MAX(note_events.cursor), CURRENT_TIMESTAMP
        FROM ${schema.noteEvents} AS note_events
        WHERE note_events.cursor <= ${cursor}
          AND note_events.note_id IS NOT NULL
          AND (
            (note_events.event_type = 'membership.revoked'
             AND json_extract(note_events.payload_metadata, '$.membershipUserId') = ${userId})
            OR
            (note_events.event_type = 'note.permanently_deleted'
             AND EXISTS (
               SELECT 1
               FROM json_each(note_events.payload_metadata, '$.visibleUserIds')
               WHERE json_each.value = ${userId}
             ))
          )
        GROUP BY note_events.note_id
        ON CONFLICT(user_id, note_id) DO UPDATE SET
          cursor = MAX(event_acknowledgements.cursor, excluded.cursor),
          updated_at = CURRENT_TIMESTAMP
      `);
    });
    return Promise.resolve();
  }

  acknowledgedCursor(userId: string): Promise<number> {
    const row = this.orm
      .select({ cursor: schema.eventCursors.cursor })
      .from(schema.eventCursors)
      .where(eq(schema.eventCursors.userId, userId))
      .get();
    return Promise.resolve(row?.cursor ?? 0);
  }

  prune(beforeCursor = Number.POSITIVE_INFINITY): Promise<EventRetentionResult> {
    const prunedThroughCursor = retentionCursor(beforeCursor);
    if (prunedThroughCursor <= 0) {
      return Promise.resolve({
        prunedThroughCursor: Math.max(0, prunedThroughCursor),
        deletedEvents: 0,
        deletedAcknowledgements: 0
      });
    }

    const result = this.orm.transaction((transaction) => {
      const deletedEvents = transaction.run(sql`
        DELETE FROM ${schema.noteEvents}
        WHERE cursor <= ${prunedThroughCursor}
          AND NOT EXISTS (
            SELECT 1 FROM note_memberships
            LEFT JOIN event_cursors ON event_cursors.user_id = note_memberships.user_id
            WHERE note_events.note_id IS NOT NULL
              AND note_memberships.note_id = note_events.note_id
              AND note_memberships.status = 'active'
              AND COALESCE(event_cursors.cursor, 0) < note_events.cursor
          )
          AND NOT EXISTS (
            SELECT 1 FROM users AS actor
            LEFT JOIN event_cursors ON event_cursors.user_id = actor.id
            WHERE note_events.note_id IS NULL
              AND actor.id = note_events.actor_user_id
              AND COALESCE(event_cursors.cursor, 0) < note_events.cursor
          )
          AND NOT EXISTS (
            SELECT 1 FROM users AS tombstone_user
            LEFT JOIN event_cursors ON event_cursors.user_id = tombstone_user.id
            WHERE (
              (note_events.event_type = 'membership.revoked'
               AND tombstone_user.id =
                 json_extract(note_events.payload_metadata, '$.membershipUserId'))
              OR
              (note_events.event_type = 'note.permanently_deleted'
               AND EXISTS (
                 SELECT 1
                 FROM json_each(note_events.payload_metadata, '$.visibleUserIds')
                 WHERE json_each.value = tombstone_user.id
               ))
            )
              AND COALESCE(event_cursors.cursor, 0) < note_events.cursor
          )
      `).changes;
      const deletedAcknowledgements = transaction.run(sql`
        DELETE FROM ${schema.eventAcknowledgements}
        WHERE NOT EXISTS (
          SELECT 1 FROM note_events
          WHERE note_events.note_id = event_acknowledgements.note_id
            AND note_events.cursor <= event_acknowledgements.cursor
            AND (
              (note_events.event_type = 'membership.revoked'
               AND json_extract(note_events.payload_metadata, '$.membershipUserId') =
                 event_acknowledgements.user_id)
              OR
              (note_events.event_type = 'note.permanently_deleted'
               AND EXISTS (
                 SELECT 1
                 FROM json_each(note_events.payload_metadata, '$.visibleUserIds')
                 WHERE json_each.value = event_acknowledgements.user_id
               ))
            )
        )
      `).changes;
      return { prunedThroughCursor, deletedEvents, deletedAcknowledgements };
    });
    return Promise.resolve(result);
  }
}
