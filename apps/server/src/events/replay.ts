import { canonicalTimestamp } from "../db/timestamps.js";

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
  listVisible(
    userId: string,
    after: number,
    limit: number
  ): Promise<CollaborationEvent[]>;
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
    createdAt: canonicalTimestamp(row.createdAt)
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
