import type { EncryptedCrdtMessage } from "@fortnote/shared";
import { isRealtimeMessage } from "./protocol";

const CRDT_OUTBOX_KEY_PREFIX = "fortnote:crdt-outbox:v1:";
const volatileCrdtOutboxes = new Map<string, Map<string, EncryptedCrdtMessage>>();

export function flushCrdtOutbox(socket: WebSocket, userId: string, enabled = true): void {
  if (socket.readyState !== WebSocket.OPEN || !enabled) {
    return;
  }
  for (const update of readCrdtOutbox(userId).values()) {
    socket.send(JSON.stringify(update));
  }
}

export function readCrdtOutbox(userId: string): Map<string, EncryptedCrdtMessage> {
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

export function persistCrdtOutbox(userId: string, required = false): void {
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
