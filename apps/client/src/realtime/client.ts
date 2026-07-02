import type { CollaborationEvent, PresenceState, PresenceUser } from "../api";

export type ClientPresenceState = PresenceState | "left";

export type RealtimeMessage =
  | { type: "connected"; userId: string; username: string }
  | { type: "replay"; events: CollaborationEvent[] }
  | { type: "event"; event: CollaborationEvent }
  | { type: "presence"; noteId: string; users: PresenceUser[] }
  | { type: "pong" };

interface RealtimeClientOptions {
  after: number;
  onMessage: (message: RealtimeMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
}

export interface RealtimeConnection {
  close: () => void;
  sendPresence: (noteId: string, state: ClientPresenceState) => void;
}

export function connectRealtime({
  after,
  onMessage,
  onOpen,
  onClose,
  onError
}: RealtimeClientOptions): RealtimeConnection {
  const socket = new WebSocket(realtimeUrl(after));
  socket.addEventListener("open", () => {
    onOpen?.();
  });
  socket.addEventListener("message", (event) => {
    const message = parseRealtimeMessage(event.data);
    if (message) {
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
    sendPresence: (noteId, state) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({ type: "presence", noteId, state }));
    },
    close: () => {
      socket.close();
    }
  };
}

function realtimeUrl(after: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/realtime?after=${String(after)}`;
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
      return typeof value.userId === "string" && typeof value.username === "string";
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
