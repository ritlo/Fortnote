import { WebSocket } from "ws";
import type { AppContext } from "../http/app.js";
import { isSessionActive } from "../auth/session.js";
import { listVisibleEvents } from "../events/replay.js";
import { canReadNote, getNoteAccess } from "../notes/access.js";
import type { RealtimePublisher } from "./types.js";

export interface RealtimeClient {
  id: string;
  sessionId: string;
  userId: string;
  username: string;
  socket: WebSocket;
}

export type PresenceState = "idle" | "editing";
export type ClientPresenceState = PresenceState | "left";

interface RealtimeHubOptions {
  presenceTtlMs?: number;
  presenceSweepIntervalMs?: number;
  sessionSweepIntervalMs?: number;
}

interface PresenceEntry {
  clientId: string;
  userId: string;
  username: string;
  state: PresenceState;
  updatedAt: string;
}

const DEFAULT_PRESENCE_TTL_MS = 45_000;
const DEFAULT_PRESENCE_SWEEP_INTERVAL_MS = 15_000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 15_000;
const SESSION_CLOSED_CODE = 1008;

export class RealtimeHub implements RealtimePublisher {
  private readonly clients = new Set<RealtimeClient>();
  private readonly presenceByNote = new Map<string, Map<string, PresenceEntry>>();
  private readonly presenceTtlMs: number;
  private readonly presenceSweepInterval: ReturnType<typeof setInterval> | null;
  private readonly sessionSweepInterval: ReturnType<typeof setInterval> | null;
  private context: AppContext | null = null;

  constructor(options: RealtimeHubOptions = {}) {
    this.presenceTtlMs = options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
    const sweepIntervalMs =
      options.presenceSweepIntervalMs ?? DEFAULT_PRESENCE_SWEEP_INTERVAL_MS;
    this.presenceSweepInterval =
      sweepIntervalMs > 0
        ? setInterval(() => {
            this.sweepStalePresence();
          }, sweepIntervalMs)
        : null;
    this.presenceSweepInterval?.unref();
    const sessionSweepIntervalMs =
      options.sessionSweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS;
    this.sessionSweepInterval =
      sessionSweepIntervalMs > 0
        ? setInterval(() => {
            this.sweepInvalidSessions();
          }, sessionSweepIntervalMs)
        : null;
    this.sessionSweepInterval?.unref();
  }

  attachContext(context: AppContext): void {
    this.context = context;
  }

  close(): void {
    if (this.presenceSweepInterval) {
      clearInterval(this.presenceSweepInterval);
    }
    if (this.sessionSweepInterval) {
      clearInterval(this.sessionSweepInterval);
    }
  }

  addClient(input: {
    sessionId: string;
    userId: string;
    username: string;
    socket: WebSocket;
  }): RealtimeClient {
    const client = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      userId: input.userId,
      username: input.username,
      socket: input.socket
    };
    this.clients.add(client);
    input.socket.on("close", () => {
      this.clients.delete(client);
      this.clearPresence(client);
    });
    return client;
  }

  closeSession(sessionId: string): void {
    for (const client of this.clients) {
      if (client.sessionId === sessionId) {
        this.disconnectClient(client, "Session ended");
      }
    }
  }

  publishEvents(cursors: number[]): void {
    if (!this.context || cursors.length === 0) {
      return;
    }

    for (const cursor of cursors) {
      for (const client of this.clients) {
        if (!this.ensureClientSession(client)) {
          continue;
        }
        const [event] = listVisibleEvents(this.context, client.userId, cursor - 1, 1);
        if (event?.cursor !== cursor) {
          continue;
        }
        sendJson(client.socket, { type: "event", event });
      }
    }
  }

  updatePresence(client: RealtimeClient, noteId: string, state: ClientPresenceState): void {
    if (!this.context) {
      return;
    }
    if (!this.ensureClientSession(client)) {
      return;
    }

    if (state === "left") {
      this.clearNotePresence(client, noteId);
      return;
    }

    const access = getNoteAccess(this.context, noteId, client.userId);
    if (!canReadNote(access)) {
      return;
    }

    const notePresence = this.presenceByNote.get(noteId) ?? new Map<string, PresenceEntry>();
    notePresence.set(client.id, {
      clientId: client.id,
      userId: client.userId,
      username: client.username,
      state,
      updatedAt: new Date().toISOString()
    });
    this.presenceByNote.set(noteId, notePresence);
    this.broadcastPresence(noteId);
  }

  private clearPresence(client: RealtimeClient): void {
    for (const [noteId, notePresence] of this.presenceByNote.entries()) {
      if (!notePresence.delete(client.id)) {
        continue;
      }
      if (notePresence.size === 0) {
        this.presenceByNote.delete(noteId);
      }
      this.broadcastPresence(noteId);
    }
  }

  private clearNotePresence(client: RealtimeClient, noteId: string): void {
    const notePresence = this.presenceByNote.get(noteId);
    if (!notePresence?.delete(client.id)) {
      return;
    }
    if (notePresence.size === 0) {
      this.presenceByNote.delete(noteId);
    }
    this.broadcastPresence(noteId);
  }

  private sweepStalePresence(now = Date.now()): void {
    for (const [noteId, notePresence] of this.presenceByNote.entries()) {
      let changed = false;
      for (const [clientId, entry] of notePresence.entries()) {
        if (Date.parse(entry.updatedAt) + this.presenceTtlMs > now) {
          continue;
        }
        notePresence.delete(clientId);
        changed = true;
      }

      if (!changed) {
        continue;
      }
      if (notePresence.size === 0) {
        this.presenceByNote.delete(noteId);
      }
      this.broadcastPresence(noteId);
    }
  }

  private sweepInvalidSessions(): void {
    for (const client of this.clients) {
      this.ensureClientSession(client);
    }
  }

  private broadcastPresence(noteId: string): void {
    if (!this.context) {
      return;
    }

    const usersById = new Map<string, Omit<PresenceEntry, "clientId">>();
    for (const entry of this.presenceByNote.get(noteId)?.values() ?? []) {
      usersById.set(entry.userId, {
        userId: entry.userId,
        username: entry.username,
        state: entry.state,
        updatedAt: entry.updatedAt
      });
    }
    const users = [...usersById.values()].sort((left, right) =>
      left.username.localeCompare(right.username)
    );

    for (const client of this.clients) {
      if (!this.ensureClientSession(client)) {
        continue;
      }
      const access = getNoteAccess(this.context, noteId, client.userId);
      if (!canReadNote(access)) {
        continue;
      }
      sendJson(client.socket, { type: "presence", noteId, users });
    }
  }

  private ensureClientSession(client: RealtimeClient): boolean {
    if (this.context && isSessionActive(this.context.db, client.sessionId)) {
      return true;
    }
    this.disconnectClient(client, "Session expired");
    return false;
  }

  private disconnectClient(client: RealtimeClient, reason: string): void {
    if (!this.clients.delete(client)) {
      return;
    }
    this.clearPresence(client);
    client.socket.close(SESSION_CLOSED_CODE, reason);
  }
}

export function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(value));
}
