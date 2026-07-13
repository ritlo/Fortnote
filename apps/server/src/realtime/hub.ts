import { WebSocket } from "ws";
import { and, count, eq, inArray } from "drizzle-orm";
import {
  CRDT_REALTIME_CAPABILITY,
  type EncryptedCrdtMessage
} from "@fortnote/shared";
import type { AppContext } from "../http/app.js";
import * as schema from "../db/schema.js";
import { deleteExpiredSessions, isSessionActive } from "../auth/session.js";
import { listVisibleEvents } from "../events/replay.js";
import { canEditNote, canReadNote, getNoteAccess } from "../notes/access.js";
import type { RealtimePublisher } from "./types.js";

export interface RealtimeClient {
  id: string;
  sessionId: string;
  userId: string;
  username: string;
  socket: WebSocket;
  capabilities: Set<string>;
  subscribedNoteIds: Set<string>;
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
// ponytail: fixed ceiling; make this configurable only if real note sizes demand it.
const MAX_CRDT_ENVELOPES_PER_EPOCH = 128;

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
    capabilities: Set<string>;
  }): RealtimeClient {
    const client = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      userId: input.userId,
      username: input.username,
      socket: input.socket,
      capabilities: input.capabilities,
      subscribedNoteIds: new Set<string>()
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
      for (const [userId, clients] of this.activeClientsByUser()) {
        const [event] = listVisibleEvents(this.context, userId, cursor - 1, 1);
        if (event?.cursor !== cursor) {
          continue;
        }
        for (const client of clients) {
          sendJson(client.socket, { type: "event", event });
        }
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

  subscribeCrdt(client: RealtimeClient, noteId: string): void {
    if (!this.context || !client.capabilities.has(CRDT_REALTIME_CAPABILITY)) {
      return;
    }
    const access = getNoteAccess(this.context, noteId, client.userId);
    if (!this.ensureClientSession(client) || !canReadNote(access)) {
      return;
    }
    client.subscribedNoteIds.add(noteId);
    const updates = this.context.db.orm
      .select({
        updateId: schema.noteUpdates.updateId,
        noteId: schema.noteUpdates.noteId,
        cryptoOwnerId: schema.noteUpdates.cryptoOwnerId,
        keyEpoch: schema.noteUpdates.keyEpoch,
        formatVersion: schema.noteUpdates.formatVersion,
        cipher: schema.noteUpdates.cipher,
        nonce: schema.noteUpdates.nonce,
        kind: schema.noteUpdates.kind,
        compactedUpdateIds: schema.noteUpdates.compactedUpdateIds
      })
      .from(schema.noteUpdates)
      .where(and(
        eq(schema.noteUpdates.noteId, noteId),
        eq(schema.noteUpdates.keyEpoch, access.keyEpoch)
      ))
      .all();
    for (const update of updates) {
      const { kind, compactedUpdateIds, ...envelope } = update;
      sendJson(
        client.socket,
        kind === "checkpoint"
          ? {
              ...envelope,
              type: "crdt-checkpoint",
              compactedUpdateIds: JSON.parse(compactedUpdateIds ?? "[]") as string[]
            }
          : { ...envelope, type: "crdt-update" }
      );
    }
    sendJson(client.socket, {
      type: "crdt-sync",
      noteId,
      hasUpdates: updates.length > 0
    });
  }

  publishCrdtUpdate(
    client: RealtimeClient,
    update: EncryptedCrdtMessage
  ): "accepted" | "forbidden" | "storage-limit" {
    if (!this.context || !client.capabilities.has(CRDT_REALTIME_CAPABILITY)) {
      return "forbidden";
    }
    const access = getNoteAccess(this.context, update.noteId, client.userId);
    if (
      !this.ensureClientSession(client) ||
      !canEditNote(access) ||
      access.cryptoOwnerId !== update.cryptoOwnerId ||
      access.keyEpoch !== update.keyEpoch
    ) {
      return "forbidden";
    }
    const outcome = this.context.db.orm.transaction((tx) => {
      const existing = tx
        .select({ updateId: schema.noteUpdates.updateId })
        .from(schema.noteUpdates)
        .where(eq(schema.noteUpdates.updateId, update.updateId))
        .get();
      if (existing) {
        return "duplicate" as const;
      }
      const storedCount = tx
        .select({ value: count() })
        .from(schema.noteUpdates)
        .where(and(
          eq(schema.noteUpdates.noteId, update.noteId),
          eq(schema.noteUpdates.keyEpoch, update.keyEpoch)
        ))
        .get()?.value ?? 0;
      const compactedCount =
        update.type === "crdt-checkpoint" && update.compactedUpdateIds.length > 0
          ? tx
              .select({ updateId: schema.noteUpdates.updateId })
              .from(schema.noteUpdates)
              .where(and(
                eq(schema.noteUpdates.noteId, update.noteId),
                eq(schema.noteUpdates.keyEpoch, update.keyEpoch),
                inArray(schema.noteUpdates.updateId, update.compactedUpdateIds)
              ))
              .all().length
          : 0;
      if (storedCount + 1 - compactedCount > MAX_CRDT_ENVELOPES_PER_EPOCH) {
        return "rejected" as const;
      }
      const result = tx
        .insert(schema.noteUpdates)
        .values({
          updateId: update.updateId,
          noteId: update.noteId,
          cryptoOwnerId: update.cryptoOwnerId,
          keyEpoch: update.keyEpoch,
          formatVersion: update.formatVersion,
          cipher: update.cipher,
          nonce: update.nonce,
          kind: update.type === "crdt-checkpoint" ? "checkpoint" : "update",
          compactedUpdateIds:
            update.type === "crdt-checkpoint"
              ? JSON.stringify(update.compactedUpdateIds)
              : null
        })
        .onConflictDoNothing()
        .run();
      if (result.changes === 0) {
        return "duplicate" as const;
      }
      if (
        update.type === "crdt-checkpoint" &&
        update.compactedUpdateIds.length > 0
      ) {
        tx.delete(schema.noteUpdates)
          .where(and(
            eq(schema.noteUpdates.noteId, update.noteId),
            eq(schema.noteUpdates.keyEpoch, update.keyEpoch),
            inArray(schema.noteUpdates.updateId, update.compactedUpdateIds)
          ))
          .run();
      }
      return "inserted" as const;
    });
    if (outcome === "rejected") {
      return "storage-limit";
    }
    if (outcome === "duplicate") {
      return "accepted";
    }
    for (const recipient of this.clients) {
      if (
        recipient === client ||
        !this.ensureClientSession(recipient) ||
        !recipient.capabilities.has(CRDT_REALTIME_CAPABILITY) ||
        !recipient.subscribedNoteIds.has(update.noteId) ||
        !canReadNote(getNoteAccess(this.context, update.noteId, recipient.userId))
      ) {
        continue;
      }
      sendJson(recipient.socket, update);
    }
    return "accepted";
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
    if (this.context) {
      deleteExpiredSessions(this.context.db);
    }
    this.activeClientsByUser();
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

    for (const [userId, clients] of this.activeClientsByUser()) {
      const access = getNoteAccess(this.context, noteId, userId);
      if (!canReadNote(access)) {
        continue;
      }
      for (const client of clients) {
        sendJson(client.socket, { type: "presence", noteId, users });
      }
    }
  }

  private activeClientsByUser(): Map<string, RealtimeClient[]> {
    const clientsByUser = new Map<string, RealtimeClient[]>();
    const activeSessions = new Map<string, boolean>();
    for (const client of this.clients) {
      const knownSessionState = activeSessions.get(client.sessionId);
      if (knownSessionState === false) {
        this.disconnectClient(client, "Session expired");
        continue;
      }
      const active = knownSessionState ?? this.ensureClientSession(client);
      activeSessions.set(client.sessionId, active);
      if (!active) {
        continue;
      }
      const clients = clientsByUser.get(client.userId) ?? [];
      clients.push(client);
      clientsByUser.set(client.userId, clients);
    }
    return clientsByUser;
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
