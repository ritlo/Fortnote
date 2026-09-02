import { WebSocket } from "ws";
import {
  encodeCrdtBinaryFrame,
  type CrdtBinaryHeader,
  type CrdtManifestReferenceV2,
  type CrdtSubscribeV2,
  type CrdtUnsubscribeV2,
  type EncryptedCrdtMessage
} from "@fortnote/shared";
import type { AppContext } from "../http/app.js";
import { canReadNote } from "../notes/access.js";
import type { RealtimePublisher } from "./types.js";
import type {
  BinaryUpdateOutcome,
  ManifestSectionHistoryEntry
} from "./history.js";

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
  private presencePublishQueue: Promise<void> = Promise.resolve();
  private sessionSweepQueue: Promise<void> = Promise.resolve();
  private context: AppContext | null = null;
  private closed = false;

  constructor(options: RealtimeHubOptions = {}) {
    this.presenceTtlMs = options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
    const sweepIntervalMs =
      options.presenceSweepIntervalMs ?? DEFAULT_PRESENCE_SWEEP_INTERVAL_MS;
    this.presenceSweepInterval =
      sweepIntervalMs > 0
        ? setInterval(() => {
            if (this.closed) {
              return;
            }
            this.sweepStalePresence();
          }, sweepIntervalMs)
        : null;
    this.presenceSweepInterval?.unref();
    const sessionSweepIntervalMs =
      options.sessionSweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS;
    this.sessionSweepInterval =
      sessionSweepIntervalMs > 0
        ? setInterval(() => {
            if (this.closed) {
              return;
            }
            this.sessionSweepQueue = this.sessionSweepQueue
              .then(() => this.sweepInvalidSessions())
              .catch((error: unknown) => {
                console.error("Unable to sweep realtime sessions", error);
              });
          }, sessionSweepIntervalMs)
        : null;
    this.sessionSweepInterval?.unref();
  }

  attachContext(context: AppContext): void {
    this.context = context;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.presenceSweepInterval) {
      clearInterval(this.presenceSweepInterval);
    }
    if (this.sessionSweepInterval) {
      clearInterval(this.sessionSweepInterval);
    }
    for (const client of this.clients) {
      client.socket.close(1001, "Server shutting down");
    }
    this.clients.clear();
    this.presenceByNote.clear();
    await Promise.all([
      this.eventPublishQueue,
      this.presencePublishQueue,
      this.sessionSweepQueue
    ]);
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
      for (const [userId, clients] of await this.activeClientsByUser()) {
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

    this.eventPublishQueue = this.eventPublishQueue
      .then(() => this.publishContentManifestAsync(reference))
      .catch((error: unknown) => {
        console.error("Unable to publish content manifest", error);
      });
  }

  private async publishContentManifestAsync(
    reference: CrdtManifestReferenceV2
  ): Promise<void> {
    if (!this.context) {
      return;
    }
    for (const client of this.clients) {
      if (
        !client.crdtV2Enabled ||
        !client.subscribedCrdtScopes.has(
          crdtScope(reference.noteId, reference.sectionId)
        )
      ) {
        continue;
      }
      if (!await this.ensureClientSessionAsync(client)) {
        continue;
      }
      const access = await this.context.db.noteAccess.find(
        reference.noteId,
        client.userId
      );
      if (!canReadNote(access) || access.keyEpoch !== reference.keyEpoch) {
        continue;
      }
      sendJson(client.socket, reference);
    }
  }

  async updatePresence(
    client: RealtimeClient,
    noteId: string,
    state: ClientPresenceState
  ): Promise<void> {
    if (!this.context) {
      return;
    }
    if (!await this.ensureClientSessionAsync(client)) {
      return;
    }

    if (state === "left") {
      this.clearNotePresence(client, noteId);
      return;
    }

    const access = await this.context.db.noteAccess.find(noteId, client.userId);
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
    await this.queuePresenceBroadcast(noteId);
  }

  async subscribeCrdt(client: RealtimeClient, noteId: string): Promise<void> {
    if (!this.context || !client.crdtEnabled) {
      return;
    }
    if (!await this.ensureClientSessionAsync(client)) {
      return;
    }
    const access = await this.context.db.noteAccess.find(noteId, client.userId);
    if (!canReadNote(access)) {
      return;
    }
    client.subscribedNoteIds.add(noteId);
    const updates = await this.context.db.legacyHistory.list(
      noteId,
      access.keyEpoch
    );
    for (const update of updates) {
      sendJson(client.socket, update);
    }
    sendJson(client.socket, {
      type: "crdt-sync",
      noteId,
      keyEpoch: access.keyEpoch,
      hasUpdates: updates.length > 0
    });
  }

  async subscribeCrdtV2(
    client: RealtimeClient,
    request: CrdtSubscribeV2
  ): Promise<void> {
    if (
      !this.context ||
      !client.crdtV2Enabled ||
      !await this.ensureClientSessionAsync(client)
    ) {
      return;
    }
    const access = await this.context.db.noteAccess.find(
      request.noteId,
      client.userId
    );
    if (!canReadNote(access)) {
      this.rejectCrdtV2(client, request.requestId, request.sectionId, "forbidden");
      return;
    }
    if (access.keyEpoch !== request.expectedKeyEpoch) {
      this.rejectCrdtV2(client, request.requestId, request.sectionId, "stale-epoch");
      return;
    }
    const page = await this.context.db.sectionHistory.list({
      noteId: request.noteId,
      sectionId: request.sectionId,
      keyEpoch: request.expectedKeyEpoch,
      afterSequence: request.afterSequence,
      maxItems: this.context.config.historyPageMaxItems,
      maxBytes: this.context.config.historyPageMaxBytes
    });
    if (!page) {
      this.rejectCrdtV2(client, request.requestId, request.sectionId, "forbidden");
      return;
    }
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

  async publishCrdtBinary(
    client: RealtimeClient,
    header: CrdtBinaryHeader,
    cipher: Uint8Array
  ): Promise<BinaryUpdateOutcome> {
    if (
      !this.context ||
      !client.crdtV2Enabled ||
      !await this.ensureClientSessionAsync(client)
    ) {
      return { status: "rejected", code: "forbidden" };
    }
    const outcome = await this.context.db.sectionHistory.persist({
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
      if (
        (recipient === client && header.originClientId === recipient.clientInstanceId) ||
        !recipient.crdtV2Enabled ||
        !recipient.subscribedCrdtScopes.has(crdtScope(header.noteId, header.sectionId))
      ) {
        continue;
      }
      if (!await this.ensureClientSessionAsync(recipient)) {
        continue;
      }
      const access = await this.context.db.noteAccess.find(
        header.noteId,
        recipient.userId
      );
      if (!canReadNote(access) || access.keyEpoch !== header.expectedKeyEpoch) {
        continue;
      }
      recipient.socket.send(frame);
    }
    return outcome;
  }

  async publishCrdtUpdate(
    client: RealtimeClient,
    update: EncryptedCrdtMessage
  ): Promise<"accepted" | "forbidden" | "storage-limit"> {
    if (!this.context || !client.crdtEnabled) {
      return "forbidden";
    }
    if (!await this.ensureClientSessionAsync(client)) {
      return "forbidden";
    }
    const outcome = await this.context.db.legacyHistory.persist({
      sessionId: client.sessionId,
      userId: client.userId,
      update,
      maxEnvelopes: MAX_CRDT_ENVELOPES_PER_EPOCH,
      maxBytes: MAX_CRDT_BYTES_PER_EPOCH
    });
    if (outcome === "storage-limit") {
      return "storage-limit";
    }
    if (outcome === "forbidden") {
      return "forbidden";
    }
    if (outcome === "duplicate") {
      return "accepted";
    }
    for (const recipient of this.clients) {
      if (
        recipient === client ||
        !recipient.crdtEnabled ||
        !recipient.subscribedNoteIds.has(update.noteId)
      ) {
        continue;
      }
      if (!await this.ensureClientSessionAsync(recipient)) {
        continue;
      }
      const access = await this.context.db.noteAccess.find(
        update.noteId,
        recipient.userId
      );
      if (!canReadNote(access)) {
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
      void this.queuePresenceBroadcast(noteId);
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
    void this.queuePresenceBroadcast(noteId);
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
      void this.queuePresenceBroadcast(noteId);
    }
  }

  private async sweepInvalidSessions(): Promise<void> {
    if (this.closed || !this.context) {
      return;
    }
    await this.context.db.sessions.deleteExpired(new Date().toISOString());
    await this.activeClientsByUser();
  }

  private queuePresenceBroadcast(noteId: string): Promise<void> {
    const publish = this.presencePublishQueue.then(() =>
      this.broadcastPresence(noteId)
    );
    this.presencePublishQueue = publish.catch((error: unknown) => {
      console.error("Unable to publish note presence", error);
    });
    return this.presencePublishQueue;
  }

  private async broadcastPresence(noteId: string): Promise<void> {
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

    for (const [userId, clients] of await this.activeClientsByUser()) {
      const access = await this.context.db.noteAccess.find(noteId, userId);
      if (!canReadNote(access)) {
        continue;
      }
      for (const client of clients) {
        sendJson(client.socket, { type: "presence", noteId, users });
      }
    }
  }

  private async activeClientsByUser(): Promise<Map<string, RealtimeClient[]>> {
    const clientsByUser = new Map<string, RealtimeClient[]>();
    const activeSessions = new Map<string, boolean>();
    for (const client of this.clients) {
      const knownSessionState = activeSessions.get(client.sessionId);
      if (knownSessionState === false) {
        this.disconnectClient(client, "Session expired");
        continue;
      }
      const active = knownSessionState ?? await this.ensureClientSessionAsync(client);
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

  private async ensureClientSessionAsync(
    client: RealtimeClient
  ): Promise<boolean> {
    if (this.context && await this.context.db.sessions.isActive(client.sessionId)) {
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
