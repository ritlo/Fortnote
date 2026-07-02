import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../auth/session.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";

const listEventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(500).default(100)
});

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

export function createEventsRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = listEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid event query");
      return;
    }

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
         WHERE note_events.cursor > ?
           AND (
             note_memberships.user_id IS NOT NULL
             OR (
               note_events.event_type = 'membership.revoked'
               AND json_extract(note_events.payload_metadata, '$.membershipUserId') = ?
             )
           )
         ORDER BY note_events.cursor
         LIMIT ?`
      )
      .all(
        session.userId,
        parsed.data.after,
        session.userId,
        parsed.data.limit
      ) as EventRow[];

    response.json({
      events: rows.map((row) => ({
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
      }))
    });
  });

  return router;
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
