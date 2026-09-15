import type { CollaborationEvent, PresenceUser } from "../api";
import {
  decodeCrdtBinaryFrame,
  parseCrdtControlMessage,
  type CrdtAck,
  type CrdtAckV2,
  type CrdtHistoryPageV2,
  type CrdtManifestReferenceV2,
  type CrdtReject,
  type CrdtRejectV2,
  type EncryptedCrdtMessage
} from "@fortnote/shared";
import type { ReceivedBinaryCrdtMessage } from "./crdt";

export const CLIENT_REALTIME_FRAME_MAX_BYTES = 256 * 1024;

export type RealtimeMessage =
  | { type: "connected"; userId: string; username: string; capabilities: string[] }
  | { type: "replay"; events: CollaborationEvent[] }
  | { type: "event"; event: CollaborationEvent }
  | { type: "presence"; noteId: string; users: PresenceUser[] }
  | { type: "crdt-sync"; noteId: string; keyEpoch: number; hasUpdates: boolean }
  | EncryptedCrdtMessage
  | ReceivedBinaryCrdtMessage
  | CrdtAck
  | CrdtAckV2
  | CrdtReject
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
  try {
    const control = parseCrdtControlMessage(parsed);
    if (
      control.type === "crdt-ack" ||
      control.type === "crdt-reject" ||
      control.type === "crdt-history-page" ||
      control.type === "crdt-manifest"
    ) {
      return control;
    }
  } catch {
    // Legacy realtime JSON is validated below during migration.
  }
  if (!isRealtimeMessage(parsed)) {
    return null;
  }
  return parsed;
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
    case "crdt-update":
      return isCrdtEnvelope(value);
    case "crdt-sync":
      return (
        typeof value.noteId === "string" &&
        typeof value.keyEpoch === "number" &&
        Number.isInteger(value.keyEpoch) &&
        value.keyEpoch > 0 &&
        typeof value.hasUpdates === "boolean"
      );
    case "crdt-checkpoint":
      return (
        isCrdtEnvelope(value) &&
        Array.isArray(value.compactedUpdateIds) &&
        value.compactedUpdateIds.every((id) => typeof id === "string")
      );
    case "crdt-ack":
      return typeof value.updateId === "string";
    case "crdt-reject":
      return typeof value.code === "string"
        ? typeof value.updateId === "string" &&
            typeof value.sectionId === "string" &&
            [
              "storage-limit",
              "frame-too-large",
              "stale-epoch",
              "rotation-pending",
              "forbidden"
            ].includes(value.code)
        : typeof value.noteId === "string" &&
            typeof value.updateId === "string" &&
            (value.reason === "forbidden" ||
              value.reason === "payload-too-large" ||
              value.reason === "storage-limit");
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

function isCrdtEnvelope(value: Record<string, unknown>): boolean {
  return (
    value.formatVersion === 1 &&
    typeof value.updateId === "string" &&
    typeof value.noteId === "string" &&
    typeof value.cryptoOwnerId === "string" &&
    typeof value.keyEpoch === "number" &&
    typeof value.cipher === "string" &&
    typeof value.nonce === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
