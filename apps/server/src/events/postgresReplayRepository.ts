import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import {
  mapEventRows,
  retentionCursor,
  type CollaborationEvent,
  type EventReplayRepository,
  type EventRetentionResult,
  type EventRow
} from "./replay.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

export class PostgresEventReplayRepository implements EventReplayRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  async listVisible(
    userId: string,
    after: number,
    limit: number
  ): Promise<CollaborationEvent[]> {
    const result = await this.orm.execute<EventRow>(sql`
      SELECT note_events.cursor,
             note_events.event_id AS "eventId",
             note_events.resource_type AS "resourceType",
             note_events.resource_id AS "resourceId",
             note_events.note_id AS "noteId",
             note_events.actor_user_id AS "actorUserId",
             note_events.event_type AS "eventType",
             note_events.note_version AS "noteVersion",
             note_events.payload_metadata AS "payloadMetadata",
             note_events.created_at AS "createdAt"
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
            AND note_events.payload_metadata::jsonb ->> 'membershipUserId' = ${userId}
            AND (event_acknowledgements.cursor IS NULL
                 OR event_acknowledgements.cursor < note_events.cursor)
          )
          OR (
            note_events.event_type = 'note.permanently_deleted'
            AND (note_events.payload_metadata::jsonb -> 'visibleUserIds') ? ${userId}
            AND (event_acknowledgements.cursor IS NULL
                 OR event_acknowledgements.cursor < note_events.cursor)
          )
        )
      ORDER BY note_events.cursor
      LIMIT ${limit}
    `);
    return mapEventRows(result.rows);
  }

  async acknowledge(userId: string, cursor: number): Promise<void> {
    await this.orm.transaction(async (transaction) => {
      await transaction
        .insert(schema.eventCursors)
        .values({ userId, cursor })
        .onConflictDoUpdate({
          target: schema.eventCursors.userId,
          set: {
            cursor: sql`GREATEST(${schema.eventCursors.cursor}, excluded.cursor)`,
            updatedAt: sql`CURRENT_TIMESTAMP`
          }
        });
      await transaction.execute(sql`
        INSERT INTO ${schema.eventAcknowledgements} (user_id, note_id, cursor, updated_at)
        SELECT ${userId}, note_events.note_id, MAX(note_events.cursor), CURRENT_TIMESTAMP
        FROM ${schema.noteEvents} AS note_events
        WHERE note_events.cursor <= ${cursor}
          AND note_events.note_id IS NOT NULL
          AND (
            (note_events.event_type = 'membership.revoked'
             AND note_events.payload_metadata::jsonb ->> 'membershipUserId' = ${userId})
            OR
            (note_events.event_type = 'note.permanently_deleted'
             AND (note_events.payload_metadata::jsonb -> 'visibleUserIds') ? ${userId})
          )
        GROUP BY note_events.note_id
        ON CONFLICT(user_id, note_id) DO UPDATE SET
          cursor = GREATEST(event_acknowledgements.cursor, excluded.cursor),
          updated_at = CURRENT_TIMESTAMP
      `);
    });
  }

  async acknowledgedCursor(userId: string): Promise<number> {
    const rows = await this.orm
      .select({ cursor: schema.eventCursors.cursor })
      .from(schema.eventCursors)
      .where(eq(schema.eventCursors.userId, userId))
      .limit(1);
    return rows[0]?.cursor ?? 0;
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

    return this.orm.transaction(async (transaction) => {
      const deletedEvents = await transaction.execute(sql`
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
                 note_events.payload_metadata::jsonb ->> 'membershipUserId')
              OR
              (note_events.event_type = 'note.permanently_deleted'
               AND (note_events.payload_metadata::jsonb -> 'visibleUserIds') ?
                 tombstone_user.id)
            )
              AND COALESCE(event_cursors.cursor, 0) < note_events.cursor
          )
      `);
      const deletedAcknowledgements = await transaction.execute(sql`
        DELETE FROM ${schema.eventAcknowledgements}
        WHERE NOT EXISTS (
          SELECT 1 FROM note_events
          WHERE note_events.note_id = event_acknowledgements.note_id
            AND note_events.cursor <= event_acknowledgements.cursor
            AND (
              (note_events.event_type = 'membership.revoked'
               AND note_events.payload_metadata::jsonb ->> 'membershipUserId' =
                 event_acknowledgements.user_id)
              OR
              (note_events.event_type = 'note.permanently_deleted'
               AND (note_events.payload_metadata::jsonb -> 'visibleUserIds') ?
                 event_acknowledgements.user_id)
            )
        )
      `);
      return {
        prunedThroughCursor,
        deletedEvents: deletedEvents.rowCount ?? 0,
        deletedAcknowledgements: deletedAcknowledgements.rowCount ?? 0
      };
    });
  }
}
