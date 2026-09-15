import type { CollaborationEvent, PresenceUser } from "../api";
import {
  decodeCrdtBinaryFrame,
  parseCrdtControlMessage,
  type CrdtAckV2,
  type CrdtHistoryPageV2,
  type CrdtManifestReferenceV2,
  type CrdtRejectV2
} from "@fortnote/shared";
import type { ReceivedBinaryCrdtMessage } from "./crdt";

export const CLIENT_REALTIME_FRAME_MAX_BYTES = 256 * 1024;

export type RealtimeMessage =
  | { type: "connected"; userId: string; username: string; capabilities: string[] }
  | { type: "replay"; events: CollaborationEvent[] }
  | { type: "event"; event: CollaborationEvent }
  | { type: "presence"; noteId: string; users: PresenceUser[] }
  | ReceivedBinaryCrdtMessage
  | CrdtAckV2
  | CrdtRejectV2
  | CrdtHistoryPageV2
  | CrdtManifestReferenceV2
  | { type: "pong" };

export function parseRealtimeMessage(data: unknown): RealtimeMessage | null {
  if (typeof data !== "string") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (
    isRecord(parsed) &&
    typeof parsed.type === "string" &&
    parsed.type.startsWith("crdt-")
  ) {
    try {
      const control = parseCrdtControlMessage(parsed);
      return control.type === "crdt-subscribe" || control.type === "crdt-unsubscribe"
        ? null
        : control;
    } catch {
      return null;
    }
  }
  return isRealtimeMessage(parsed) ? parsed : null;
}

export function parseRealtimeBinaryMessage(
  data: unknown
): ReceivedBinaryCrdtMessage | null {
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    return null;
  }
  try {
    const decoded = decodeCrdtBinaryFrame(bytes, CLIENT_REALTIME_FRAME_MAX_BYTES);
    return { ...decoded.header, cipher: decoded.cipher };
  } catch {
    return null;
  }
}

export function isRealtimeMessage(value: unknown): value is RealtimeMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "connected":
      return (
        typeof value.userId === "string" &&
        typeof value.username === "string" &&
        Array.isArray(value.capabilities) &&
        value.capabilities.every((capability) => typeof capability === "string")
      );
    case "replay":
      return Array.isArray(value.events) && value.events.every(isCollaborationEvent);
    case "event":
      return isCollaborationEvent(value.event);
    case "presence":
      return (
        typeof value.noteId === "string" &&
        Array.isArray(value.users) &&
        value.users.every(isPresenceUser)
      );
    case "pong":
      return true;
    default:
      return false;
  }
}

function isCollaborationEvent(value: unknown): value is CollaborationEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.cursor === "number" &&
    typeof value.eventId === "string" &&
    typeof value.type === "string" &&
    typeof value.resourceType === "string" &&
    typeof value.resourceId === "string" &&
    (typeof value.noteId === "string" || value.noteId === null) &&
    typeof value.actorUserId === "string" &&
    (typeof value.version === "number" || value.version === null) &&
    (isRecord(value.metadata) || value.metadata === null) &&
    typeof value.createdAt === "string"
  );
}

function isPresenceUser(value: unknown): value is PresenceUser {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.userId === "string" &&
    typeof value.username === "string" &&
    (value.state === "idle" || value.state === "editing") &&
    typeof value.updatedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
