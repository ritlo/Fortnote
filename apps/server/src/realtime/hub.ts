import { WebSocket } from "ws";
import { and, eq, inArray, lt } from "drizzle-orm";
import {
  encodeCrdtBinaryFrame,
  type CrdtBinaryHeader,
  type CrdtManifestReferenceV2,
  type CrdtSubscribeV2,
  type CrdtUnsubscribeV2,
  type EncryptedCrdtMessage
} from "@fortnote/shared";
import type { AppContext } from "../http/app.js";
import * as schema from "../db/schema.js";
import { deleteExpiredSessions, isSessionActive } from "../auth/session.js";
import { canEditNote, canReadNote, getNoteAccess } from "../notes/access.js";
import type { RealtimePublisher } from "./types.js";
import {
  listSectionHistory,
  persistBinaryUpdate,
  type BinaryUpdateOutcome,
  type ManifestSectionHistoryEntry
} from "./history.js";
import { ensureNoteSection } from "../notes/sections.js";

export interface RealtimeClient {
  id: string;
  clientInstanceId?: string;
  sessionId: string;
  userId: string;
  username: string;
  socket: WebSocket;
  crdtEnabled: boolean;
  crdtV2Enabled: boolean;
  subscribedNoteIds: Set<string>;
  subscribedCrdtScopes: Set<string>;
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
const MAX_CRDT_BYTES_PER_EPOCH = 4 * 1024 * 1024;

export class RealtimeHub implements RealtimePublisher {
  private readonly clients = new Set<RealtimeClient>();
  private readonly presenceByNote = new Map<string, Map<string, PresenceEntry>>();
  private readonly presenceTtlMs: number;
  private readonly presenceSweepInterval: ReturnType<typeof setInterval> | null;
  private readonly sessionSweepInterval: ReturnType<typeof setInterval> | null;
  private eventPublishQueue: Promise<void> = Promise.resolve();
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
    crdtEnabled: boolean;
    crdtV2Enabled?: boolean;
    clientInstanceId?: string;
  }): RealtimeClient {
    const client: RealtimeClient = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      userId: input.userId,
      username: input.username,
      socket: input.socket,
      crdtEnabled: input.crdtEnabled,
      crdtV2Enabled: input.crdtV2Enabled ?? false,
      subscribedNoteIds: new Set<string>(),
      subscribedCrdtScopes: new Set<string>()
    };
    if (input.clientInstanceId !== undefined) {
      client.clientInstanceId = input.clientInstanceId;
    }
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

  closeNoteAccess(noteId: string, userId: string): void {
    for (const client of this.clients) {
      if (client.userId !== userId) {
        continue;
      }
      client.subscribedNoteIds.delete(noteId);
      for (const scope of client.subscribedCrdtScopes) {
        if (scope.startsWith(`${noteId}:`)) {
          client.subscribedCrdtScopes.delete(scope);
        }
      }
        this.disconnectClient(client, `Note access revoked:${noteId}`);
    }
  }

  publishEvents(cursors: number[]): void {
    if (!this.context || cursors.length === 0) {
      return;
    }

    this.eventPublishQueue = this.eventPublishQueue
      .then(() => this.publishEventsAsync(cursors))
      .catch((error: unknown) => {
        console.error("Unable to publish collaboration events", error);
      });
  }

  private async publishEventsAsync(cursors: number[]): Promise<void> {
    if (!this.context) {
      return;
    }
    for (const cursor of cursors) {
      for (const [userId, clients] of this.activeClientsByUser()) {
        const [event] = await this.context.db.events.listVisible(
          userId,
          cursor - 1,
          1
        );
        if (event?.cursor !== cursor) {
          continue;
        }
        for (const client of clients) {
          sendJson(client.socket, { type: "event", event });
        }
      }
    }
  }

  publishContentManifest(reference: CrdtManifestReferenceV2): void {
    if (!this.context) {
      return;
    }
    for (const client of this.clients) {
      const access = getNoteAccess(this.context, reference.noteId, client.userId);
      if (
        !client.crdtV2Enabled ||
        !this.ensureClientSession(client) ||
        !client.subscribedCrdtScopes.has(
          crdtScope(reference.noteId, reference.sectionId)
        ) ||
        !canReadNote(access) ||
        access.keyEpoch !== reference.keyEpoch
      ) {
        continue;
      }
      sendJson(client.socket, reference);
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
    if (!this.context || !client.crdtEnabled) {
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
      keyEpoch: access.keyEpoch,
      hasUpdates: updates.length > 0
    });
  }

  subscribeCrdtV2(client: RealtimeClient, request: CrdtSubscribeV2): void {
    if (!this.context || !client.crdtV2Enabled || !this.ensureClientSession(client)) {
      return;
    }
    const access = getNoteAccess(this.context, request.noteId, client.userId);
    if (!canReadNote(access)) {
      this.rejectCrdtV2(client, request.requestId, request.sectionId, "forbidden");
      return;
    }
    if (access.keyEpoch !== request.expectedKeyEpoch) {
      this.rejectCrdtV2(client, request.requestId, request.sectionId, "stale-epoch");
      return;
    }
    if (
      !ensureNoteSection(
        this.context,
        request.noteId,
        request.sectionId,
        request.expectedKeyEpoch
      )
    ) {
      this.rejectCrdtV2(client, request.requestId, request.sectionId, "forbidden");
      return;
    }
    const page = listSectionHistory(this.context, {
      noteId: request.noteId,
      sectionId: request.sectionId,
      keyEpoch: request.expectedKeyEpoch,
      afterSequence: request.afterSequence
    });
    client.subscribedCrdtScopes.add(crdtScope(request.noteId, request.sectionId));
    for (const entry of page.entries) {
      if (entry.storage === "manifest") {
        sendJson(client.socket, manifestReference(request, entry));
        continue;
      }
      const header: CrdtBinaryHeader = {
        type: "crdt-binary",
        kind: entry.kind,
        formatVersion: 2,
        updateId: entry.updateId,
        noteId: request.noteId,
        sectionId: request.sectionId,
        cryptoOwnerId: entry.cryptoOwnerId,
        expectedKeyEpoch: entry.keyEpoch,
        nonce: entry.nonce.toString("base64"),
        cipherLength: entry.inlineCipher.length,
        ...(entry.checkpointSequenceCutoff === null
          ? {}
          : { checkpointSequenceCutoff: entry.checkpointSequenceCutoff }),
        serverSequence: entry.serverSequence
      };
      client.socket.send(
        encodeCrdtBinaryFrame(
          header,
          entry.inlineCipher,
          this.context.config.realtimeFrameMaxBytes
        )
      );
    }
    sendJson(client.socket, {
      type: "crdt-history-page",
      noteId: request.noteId,
      sectionId: request.sectionId,
      keyEpoch: request.expectedKeyEpoch,
      afterSequence: request.afterSequence,
      nextSequence: page.nextSequence,
      hasMore: page.hasMore,
      entries: page.entries.map((entry) => ({
        kind: entry.storage,
        updateId: entry.updateId,
        serverSequence: entry.serverSequence,
        ...(entry.storage === "manifest" ? { manifestId: entry.manifestId } : {})
      }))
    });
  }

  unsubscribeCrdtV2(client: RealtimeClient, request: CrdtUnsubscribeV2): void {
    if (!client.crdtV2Enabled) {
      return;
    }
    client.subscribedCrdtScopes.delete(crdtScope(request.noteId, request.sectionId));
    sendJson(client.socket, {
      type: "crdt-unsubscribed",
      noteId: request.noteId,
      sectionId: request.sectionId,
      keyEpoch: request.expectedKeyEpoch
    });
  }

  publishCrdtBinary(
    client: RealtimeClient,
    header: CrdtBinaryHeader,
    cipher: Uint8Array
  ): BinaryUpdateOutcome {
    if (!this.context || !client.crdtV2Enabled || !this.ensureClientSession(client)) {
      return { status: "rejected", code: "forbidden" };
    }
    const outcome = persistBinaryUpdate(this.context, {
      sessionId: client.sessionId,
      userId: client.userId,
      header,
      cipher
    });
    if (outcome.status !== "inserted") {
      return outcome;
    }
    const frame = encodeCrdtBinaryFrame(
      { ...header, serverSequence: outcome.serverSequence },
      cipher,
      this.context.config.realtimeFrameMaxBytes
    );
    for (const recipient of this.clients) {
      const access = getNoteAccess(this.context, header.noteId, recipient.userId);
      if (
        (recipient === client && header.originClientId === recipient.clientInstanceId) ||
        !recipient.crdtV2Enabled ||
        !this.ensureClientSession(recipient) ||
        !recipient.subscribedCrdtScopes.has(crdtScope(header.noteId, header.sectionId)) ||
        !canReadNote(access) ||
        access.keyEpoch !== header.expectedKeyEpoch
      ) {
        continue;
      }
      recipient.socket.send(frame);
    }
    return outcome;
  }

  publishCrdtUpdate(
    client: RealtimeClient,
    update: EncryptedCrdtMessage
  ): "accepted" | "forbidden" | "storage-limit" {
    if (!this.context || !client.crdtEnabled) {
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
      const storedUpdates = tx
        .select({ updateId: schema.noteUpdates.updateId, cipher: schema.noteUpdates.cipher })
        .from(schema.noteUpdates)
        .where(and(
          eq(schema.noteUpdates.noteId, update.noteId),
          eq(schema.noteUpdates.keyEpoch, update.keyEpoch)
        ))
        .all();
      const compactedIds = new Set(
        update.type === "crdt-checkpoint" ? update.compactedUpdateIds : []
      );
      const compactedUpdates = storedUpdates.filter(({ updateId }) => compactedIds.has(updateId));
      const storedBytes = storedUpdates.reduce(
        (total, stored) => total + Buffer.byteLength(stored.cipher, "utf8"),
        0
      );
      const compactedBytes = compactedUpdates.reduce(
        (total, stored) => total + Buffer.byteLength(stored.cipher, "utf8"),
        0
      );
      if (
        storedUpdates.length + 1 - compactedUpdates.length > MAX_CRDT_ENVELOPES_PER_EPOCH ||
        storedBytes + Buffer.byteLength(update.cipher, "utf8") - compactedBytes >
          MAX_CRDT_BYTES_PER_EPOCH
      ) {
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
      if (update.type === "crdt-checkpoint") {
        if (update.compactedUpdateIds.length > 0) {
          tx.delete(schema.noteUpdates)
            .where(and(
              eq(schema.noteUpdates.noteId, update.noteId),
              eq(schema.noteUpdates.keyEpoch, update.keyEpoch),
              inArray(schema.noteUpdates.updateId, update.compactedUpdateIds)
            ))
            .run();
        }
        tx.delete(schema.noteUpdates)
          .where(and(
            eq(schema.noteUpdates.noteId, update.noteId),
            lt(schema.noteUpdates.keyEpoch, update.keyEpoch)
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
        !recipient.crdtEnabled ||
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

  private rejectCrdtV2(
    client: RealtimeClient,
    updateId: string,
    sectionId: string,
    code: "forbidden" | "stale-epoch"
  ): void {
    sendJson(client.socket, { type: "crdt-reject", updateId, sectionId, code });
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

function crdtScope(noteId: string, sectionId: string): string {
  return `${noteId}:${sectionId}`;
}

function manifestReference(
  request: CrdtSubscribeV2,
  entry: ManifestSectionHistoryEntry
): CrdtManifestReferenceV2 {
  return {
    type: "crdt-manifest",
    formatVersion: 2,
    noteId: request.noteId,
    sectionId: request.sectionId,
    keyEpoch: entry.keyEpoch,
    updateId: entry.updateId,
    manifestId: entry.manifestId,
    uploadId: entry.uploadId,
    cryptoOwnerId: entry.cryptoOwnerId,
    kind: entry.kind,
    totalCipherBytes: entry.totalCipherBytes,
    chunkCount: entry.chunkCount,
    manifestHash: entry.manifestHash,
    ...(entry.checkpointSequenceCutoff === null
      ? {}
      : { checkpointSequenceCutoff: entry.checkpointSequenceCutoff }),
    serverSequence: entry.serverSequence
  };
}
