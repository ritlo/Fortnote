import type { CollaborationEvent, PresenceState, PresenceUser } from "../api";
import {
  CRDT_REALTIME_CAPABILITY,
  type CrdtAck,
  type CrdtReject,
  type EncryptedCrdtMessage
} from "@fortnote/shared";

export type ClientPresenceState = PresenceState | "left";

export type RealtimeMessage =
  | { type: "connected"; userId: string; username: string; capabilities: string[] }
  | { type: "replay"; events: CollaborationEvent[] }
  | { type: "event"; event: CollaborationEvent }
  | { type: "presence"; noteId: string; users: PresenceUser[] }
  | { type: "crdt-sync"; noteId: string; keyEpoch: number; hasUpdates: boolean }
  | EncryptedCrdtMessage
  | CrdtAck
  | CrdtReject
  | { type: "pong" };

const CRDT_OUTBOX_KEY_PREFIX = "fortnote:crdt-outbox:v1:";
const volatileCrdtOutboxes = new Map<string, Map<string, EncryptedCrdtMessage>>();

interface RealtimeClientOptions {
  after: number;
  userId: string;
  onMessage: (message: RealtimeMessage) => void;
  onCrdtError?: (message: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
}

export interface RealtimeConnection {
  close: () => void;
  discardCrdtUpdates: (noteId: string, beforeKeyEpoch: number) => void;
  sendPresence: (noteId: string, state: ClientPresenceState) => void;
  subscribeCrdt: (noteId: string) => void;
  sendCrdtUpdate: (update: EncryptedCrdtMessage) => Promise<void>;
}

export function connectRealtime({
  after,
  userId,
  onMessage,
  onCrdtError,
  onOpen,
  onClose,
  onError
}: RealtimeClientOptions): RealtimeConnection {
  const socket = new WebSocket(realtimeUrl(after));
  const pendingSubscriptions = new Set<string>();
  const pendingCrdtAcks = new Map<
    string,
    { reject: (error: Error) => void; resolve: () => void }
  >();
  let crdtEnabled = false;
  socket.addEventListener("open", () => {
    onOpen?.();
  });
  socket.addEventListener("message", (event) => {
    const message = parseRealtimeMessage(event.data);
    if (message) {
      if (message.type === "connected") {
        if (message.userId !== userId) {
          for (const pending of pendingCrdtAcks.values()) {
            pending.reject(new Error("Realtime session changed."));
          }
          pendingCrdtAcks.clear();
          socket.close();
          onCrdtError?.("Realtime session changed; reconnect to continue editing.");
          return;
        }
        crdtEnabled = message.capabilities.includes(CRDT_REALTIME_CAPABILITY);
        if (crdtEnabled) {
          for (const noteId of pendingSubscriptions) {
            socket.send(JSON.stringify({ type: "crdt-subscribe", noteId }));
          }
          flushCrdtOutbox(socket, userId);
        }
      } else if (message.type === "crdt-ack") {
        acknowledgeCrdtUpdate(message.updateId);
      } else if (message.type === "crdt-reject" && message.reason !== "storage-limit") {
        readCrdtOutbox(userId).delete(message.updateId);
        persistCrdtOutbox(userId);
        rejectPendingAck(
          message.updateId,
          message.reason === "forbidden"
            ? "Realtime write access was revoked."
            : "Realtime update is too large."
        );
      }
      onMessage(message);
    }
  });
  socket.addEventListener("close", () => {
    onClose?.();
  });
  socket.addEventListener("error", () => {
    onError?.();
  });

  function acknowledgeCrdtUpdate(updateId: string): void {
    const outbox = readCrdtOutbox(userId);
    const acknowledged = outbox.get(updateId);
    outbox.delete(updateId);
    persistCrdtOutbox(userId);
    pendingCrdtAcks.get(updateId)?.resolve();
    pendingCrdtAcks.delete(updateId);
    if (acknowledged?.type === "crdt-checkpoint") {
      flushCrdtOutbox(socket, userId, crdtEnabled);
    }
  }

  function discardCrdtUpdates(noteId: string, beforeKeyEpoch: number): void {
    const outbox = readCrdtOutbox(userId);
    for (const [updateId, update] of outbox) {
      if (update.noteId === noteId && update.keyEpoch < beforeKeyEpoch) {
        outbox.delete(updateId);
        rejectPendingAck(updateId, "Superseded by note-key rotation.");
      }
    }
    persistCrdtOutbox(userId);
  }

  function rejectPendingAck(updateId: string, message: string): void {
    pendingCrdtAcks.get(updateId)?.reject(new Error(message));
    pendingCrdtAcks.delete(updateId);
  }

  return {
    discardCrdtUpdates: (noteId, beforeKeyEpoch) => {
      discardCrdtUpdates(noteId, beforeKeyEpoch);
    },
    sendPresence: (noteId, state) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({ type: "presence", noteId, state }));
    },
    subscribeCrdt: (noteId) => {
      pendingSubscriptions.add(noteId);
      if (socket.readyState === WebSocket.OPEN && crdtEnabled) {
        socket.send(JSON.stringify({ type: "crdt-subscribe", noteId }));
      }
    },
    sendCrdtUpdate: (update) => {
      const delivered = new Promise<void>((resolve, reject) => {
        pendingCrdtAcks.set(update.updateId, { reject, resolve });
      });
      try {
        readCrdtOutbox(userId).set(update.updateId, update);
        persistCrdtOutbox(userId, true);
      } catch {
        onCrdtError?.(
          "Offline edits could not be saved durably; keep this tab open until realtime reconnects."
        );
      }
      flushCrdtOutbox(socket, userId, crdtEnabled);
      return delivered;
    },
    close: () => {
      for (const pending of pendingCrdtAcks.values()) {
        pending.reject(new Error("Realtime connection closed."));
      }
      pendingCrdtAcks.clear();
      socket.close();
    }
  };
}

function realtimeUrl(after: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({
    after: String(after),
    capabilities: CRDT_REALTIME_CAPABILITY
  });
  return `${protocol}//${window.location.host}/api/realtime?${query.toString()}`;
}

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
  if (!isRealtimeMessage(parsed)) {
    return null;
  }
  return parsed;
}

function isRealtimeMessage(value: unknown): value is RealtimeMessage {
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
      return (
        typeof value.noteId === "string" &&
        typeof value.updateId === "string" &&
        (value.reason === "forbidden" ||
          value.reason === "payload-too-large" ||
          value.reason === "storage-limit")
      );
    case "pong":
      return true;
    default:
      return false;
  }
}

function flushCrdtOutbox(socket: WebSocket, userId: string, enabled = true): void {
  if (socket.readyState !== WebSocket.OPEN || !enabled) {
    return;
  }
  for (const update of readCrdtOutbox(userId).values()) {
    socket.send(JSON.stringify(update));
  }
}

function readCrdtOutbox(userId: string): Map<string, EncryptedCrdtMessage> {
  const existing = volatileCrdtOutboxes.get(userId);
  if (existing) {
    return existing;
  }
  const outbox = new Map<string, EncryptedCrdtMessage>();
  try {
    const stored = JSON.parse(localStorage.getItem(outboxKey(userId)) ?? "[]") as unknown;
    if (Array.isArray(stored)) {
      for (const value of stored) {
        if (
          isRealtimeMessage(value) &&
          (value.type === "crdt-update" || value.type === "crdt-checkpoint")
        ) {
          outbox.set(value.updateId, value);
        }
      }
    }
  } catch {
    // Corrupt storage is ignored; new writes replace it.
  }
  volatileCrdtOutboxes.set(userId, outbox);
  return outbox;
}

function persistCrdtOutbox(userId: string, required = false): void {
  try {
    localStorage.setItem(
      outboxKey(userId),
      JSON.stringify([...(volatileCrdtOutboxes.get(userId)?.values() ?? [])])
    );
  } catch {
    if (required) {
      throw new Error("CRDT outbox storage is full");
    }
  }
}

function outboxKey(userId: string): string {
  return `${CRDT_OUTBOX_KEY_PREFIX}${userId}`;
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
