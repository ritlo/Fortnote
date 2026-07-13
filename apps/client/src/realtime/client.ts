import type { CollaborationEvent, PresenceState, PresenceUser } from "../api";
import {
  CRDT_REALTIME_CAPABILITY,
  type CrdtAck,
  type EncryptedCrdtMessage
} from "@fortnote/shared";

export type ClientPresenceState = PresenceState | "left";

export type RealtimeMessage =
  | { type: "connected"; userId: string; username: string; protocolVersion: number; capabilities: string[] }
  | { type: "replay"; events: CollaborationEvent[] }
  | { type: "event"; event: CollaborationEvent }
  | { type: "presence"; noteId: string; users: PresenceUser[] }
  | EncryptedCrdtMessage
  | CrdtAck
  | { type: "pong" };

const CRDT_OUTBOX_KEY = "fortnote:crdt-outbox:v1";
const volatileCrdtOutbox = new Map<string, EncryptedCrdtMessage>();

interface RealtimeClientOptions {
  after: number;
  onMessage: (message: RealtimeMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
}

export interface RealtimeConnection {
  close: () => void;
  discardCrdtUpdates: (noteId: string, beforeKeyEpoch: number) => void;
  sendPresence: (noteId: string, state: ClientPresenceState) => void;
  subscribeCrdt: (noteId: string) => void;
  sendCrdtUpdate: (update: EncryptedCrdtMessage) => void;
}

export function connectRealtime({
  after,
  onMessage,
  onOpen,
  onClose,
  onError
}: RealtimeClientOptions): RealtimeConnection {
  const socket = new WebSocket(realtimeUrl(after));
  const pendingSubscriptions = new Set<string>();
  let crdtEnabled = false;
  socket.addEventListener("open", () => {
    onOpen?.();
  });
  socket.addEventListener("message", (event) => {
    const message = parseRealtimeMessage(event.data);
    if (message) {
      if (message.type === "connected") {
        crdtEnabled = message.capabilities.includes(CRDT_REALTIME_CAPABILITY);
        if (crdtEnabled) {
          for (const noteId of pendingSubscriptions) {
            socket.send(JSON.stringify({ type: "crdt-subscribe", noteId }));
          }
          flushCrdtOutbox(socket);
        }
      } else if (message.type === "crdt-ack") {
        acknowledgeCrdtUpdate(message.updateId);
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

  return {
    discardCrdtUpdates,
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
      queueCrdtUpdate(update);
      flushCrdtOutbox(socket, crdtEnabled);
    },
    close: () => {
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
        typeof value.protocolVersion === "number" &&
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
      return (
        value.formatVersion === 1 &&
        typeof value.updateId === "string" &&
        typeof value.noteId === "string" &&
        typeof value.cryptoOwnerId === "string" &&
        typeof value.keyEpoch === "number" &&
        typeof value.cipher === "string" &&
        typeof value.nonce === "string"
      );
    case "crdt-checkpoint":
      return (
        value.formatVersion === 1 &&
        typeof value.updateId === "string" &&
        typeof value.noteId === "string" &&
        typeof value.cryptoOwnerId === "string" &&
        typeof value.keyEpoch === "number" &&
        typeof value.cipher === "string" &&
        typeof value.nonce === "string" &&
        Array.isArray(value.compactedUpdateIds) &&
        value.compactedUpdateIds.every((id) => typeof id === "string")
      );
    case "crdt-ack":
      return typeof value.updateId === "string";
    case "pong":
      return true;
    default:
      return false;
  }
}

function queueCrdtUpdate(update: EncryptedCrdtMessage): void {
  readCrdtOutbox();
  volatileCrdtOutbox.set(update.updateId, update);
  persistCrdtOutbox();
}

function acknowledgeCrdtUpdate(updateId: string): void {
  readCrdtOutbox();
  volatileCrdtOutbox.delete(updateId);
  persistCrdtOutbox();
}

function discardCrdtUpdates(noteId: string, beforeKeyEpoch: number): void {
  readCrdtOutbox();
  for (const [updateId, update] of volatileCrdtOutbox) {
    if (update.noteId === noteId && update.keyEpoch < beforeKeyEpoch) {
      volatileCrdtOutbox.delete(updateId);
    }
  }
  persistCrdtOutbox();
}

function flushCrdtOutbox(socket: WebSocket, enabled = true): void {
  if (socket.readyState !== WebSocket.OPEN || !enabled) {
    return;
  }
  for (const update of readCrdtOutbox().values()) {
    socket.send(JSON.stringify(update));
  }
}

function readCrdtOutbox(): Map<string, EncryptedCrdtMessage> {
  try {
    const stored = JSON.parse(localStorage.getItem(CRDT_OUTBOX_KEY) ?? "[]") as unknown;
    if (Array.isArray(stored)) {
      for (const value of stored) {
        if (
          isRealtimeMessage(value) &&
          (value.type === "crdt-update" || value.type === "crdt-checkpoint")
        ) {
          volatileCrdtOutbox.set(value.updateId, value);
        }
      }
    }
  } catch {
    // ponytail: memory fallback; use IndexedDB if outboxes approach localStorage limits.
  }
  return volatileCrdtOutbox;
}

function persistCrdtOutbox(): void {
  try {
    localStorage.setItem(
      CRDT_OUTBOX_KEY,
      JSON.stringify([...volatileCrdtOutbox.values()])
    );
  } catch {
    // The in-memory copy still covers reconnects in this tab.
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
