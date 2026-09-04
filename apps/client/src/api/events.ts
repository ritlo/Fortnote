import type { CollaborationEvent } from "./contracts";
import { apiRequest } from "./http";

export function listCollaborationEvents(
  after: number,
  limit = 100
): Promise<{ events: CollaborationEvent[] }> {
  return apiRequest<{ events: CollaborationEvent[] }>(
    `/events?after=${String(after)}&limit=${String(limit)}`
  );
}

export function getCollaborationEventCursor(): Promise<{ cursor: number }> {
  return apiRequest<{ cursor: number }>("/events/cursor");
}

export function acknowledgeCollaborationEvents(cursor: number): Promise<undefined> {
  return apiRequest<undefined>("/events/ack", {
    method: "POST",
    body: JSON.stringify({ cursor })
  });
}
