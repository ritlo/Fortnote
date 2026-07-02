import type { CollaborationEvent, PresenceUser } from "../api";

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
  sendPresence: (noteId: string, state: "idle" | "editing") => void;
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

function parseRealtimeMessage(data: unknown): RealtimeMessage | null {
  if (typeof data !== "string") {
    return null;
  }

  const parsed = JSON.parse(data) as unknown;
  if (!isRealtimeMessage(parsed)) {
    return null;
  }
  return parsed;
}

function isRealtimeMessage(value: unknown): value is RealtimeMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  const { type } = value;
  return (
    type === "connected" ||
    type === "replay" ||
    type === "event" ||
    type === "presence" ||
    type === "pong"
  );
}
