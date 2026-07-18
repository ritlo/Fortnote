import type { CollaborationEvent, PresenceState, PresenceUser } from "../api";
import {
  CRDT_BINARY_FORMAT_VERSION,
  CRDT_REALTIME_CAPABILITY,
  CRDT_REALTIME_CAPABILITY_V2,
  decodeCrdtBinaryFrame,
  encodeCrdtBinaryFrame,
  fromCanonicalBase64,
  parseCrdtControlMessage,
  toBase64,
  type CrdtAck,
  type CrdtAckV2,
  type CrdtHistoryPageV2,
  type CrdtReject,
  type CrdtRejectV2,
  type EncryptedCrdtMessage
} from "@fortnote/shared";
import {
  openFortnoteIndexedDb,
  type EncryptedOutboxRecord,
  type FortnoteIndexedDb
} from "../lib/indexedDb";
import { getClientInstanceId } from "../api";
import {
  createEncryptedOutbox,
  type EncryptedOutbox,
  type EncryptedOutboxStore,
  type OutboxFence
} from "./outbox";
import type {
  ReceivedBinaryCrdtMessage,
  ScopedEncryptedCrdtMessage
} from "./crdt";

export type ClientPresenceState = PresenceState | "left";

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
  | { type: "pong" };

const CRDT_OUTBOX_KEY_PREFIX = "fortnote:crdt-outbox:v1:";
const volatileCrdtOutboxes = new Map<string, Map<string, EncryptedCrdtMessage>>();
const CLIENT_REALTIME_FRAME_MAX_BYTES = 256 * 1024;

interface RealtimeClientOptions {
  after: number;
  userId: string;
  onMessage: (message: RealtimeMessage) => void;
  onCrdtError?: (message: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
  outboxStore?: EncryptedOutboxStore;
  ownerId?: string;
}

export interface RealtimeConnection {
  close: () => void;
  discardCrdtUpdates: (noteId: string, beforeKeyEpoch: number) => void;
  sendPresence: (noteId: string, state: ClientPresenceState) => void;
  subscribeCrdt: (
    noteId: string,
    sectionId?: string,
    keyEpoch?: number,
    afterSequence?: number
  ) => void;
  sendCrdtUpdate: (
    update: EncryptedCrdtMessage | ScopedEncryptedCrdtMessage
  ) => Promise<void>;
}

export function connectRealtime({
  after,
  userId,
  onMessage,
  onCrdtError,
  onOpen,
  onClose,
  onError,
  outboxStore,
  ownerId = getClientInstanceId()
}: RealtimeClientOptions): RealtimeConnection {
  const socket = new WebSocket(realtimeUrl(after));
  socket.binaryType = "arraybuffer";
  const pendingSubscriptions = new Set<string>();
  const pendingSectionSubscriptions = new Map<string, OutboxFence & { afterSequence: number }>();
  const pendingCrdtAcks = new Map<
    string,
    { reject: (error: Error) => void; resolve: () => void }
  >();
  let crdtEnabled = false;
  let crdtV2Enabled = false;
  let ownedDatabase: FortnoteIndexedDb | null = null;
  let durableOutbox: EncryptedOutbox | null = null;
  let durableOutboxPromise: Promise<EncryptedOutbox> | null = null;
  socket.addEventListener("open", () => {
    onOpen?.();
  });
  socket.addEventListener("message", (event) => {
    const message = parseRealtimeBinaryMessage(event.data) ?? parseRealtimeMessage(event.data);
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
        crdtV2Enabled = message.capabilities.includes(CRDT_REALTIME_CAPABILITY_V2);
        if (crdtEnabled) {
          for (const noteId of pendingSubscriptions) {
            socket.send(JSON.stringify({ type: "crdt-subscribe", noteId }));
          }
          flushCrdtOutbox(socket, userId);
        }
        if (crdtV2Enabled) {
          void resumeDurableOutbox();
          for (const subscription of pendingSectionSubscriptions.values()) {
            sendSectionSubscription(subscription);
          }
        }
      } else if (message.type === "crdt-ack") {
        if (isCrdtAckV2(message)) {
          void acknowledgeDurableUpdate(message);
        } else {
          acknowledgeCrdtUpdate(message.updateId);
        }
      } else if (message.type === "crdt-reject" && "code" in message) {
        handleDurableReject(message);
      } else if (message.type === "crdt-reject" && message.reason !== "storage-limit") {
        readCrdtOutbox(userId).delete(message.updateId);
        persistCrdtOutbox(userId);
        rejectPendingAck(
          message.updateId,
          message.reason === "forbidden"
            ? "Realtime write access was revoked."
            : "Realtime update is too large."
        );
      } else if (message.type === "crdt-history-page" && message.hasMore) {
        const subscription = pendingSectionSubscriptions.get(
          sectionSubscriptionKey(message.noteId, message.sectionId, message.keyEpoch)
        );
        if (subscription) {
          subscription.afterSequence = message.nextSequence;
          sendSectionSubscription(subscription);
        }
      }
      onMessage(message);
    }
  });
  socket.addEventListener("close", () => {
    closeDurableStorage();
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

  async function getDurableOutbox(): Promise<EncryptedOutbox> {
    durableOutboxPromise ??= (async () => {
      const database = outboxStore ?? await openFortnoteIndexedDb();
      if (!outboxStore) {
        ownedDatabase = database as FortnoteIndexedDb;
      }
      durableOutbox = createEncryptedOutbox({
        database,
        ownerId,
        userId
      });
      return durableOutbox;
    })();
    return durableOutboxPromise;
  }

  async function resumeDurableOutbox(): Promise<void> {
    const outbox = await getDurableOutbox();
    outbox.setTransport(sendOutboxRecord);
    await Promise.all(
      [...pendingSectionSubscriptions.values()].map((subscription) =>
        outbox.activate(subscription)
      )
    );
  }

  function sendOutboxRecord(record: EncryptedOutboxRecord): void {
    if (
      socket.readyState !== WebSocket.OPEN ||
      !crdtV2Enabled
    ) {
      throw new Error("Realtime binary transport is unavailable");
    }
    if (record.kind === "chunk") {
      throw new Error("Encrypted chunk requires resumable transfer");
    }
    const cipher = Uint8Array.from(record.inlineCipher);
    const nonce = Uint8Array.from(record.nonce);
    socket.send(
      exactArrayBuffer(encodeCrdtBinaryFrame(
        {
          type: "crdt-binary",
          kind: record.kind,
          formatVersion: CRDT_BINARY_FORMAT_VERSION,
          updateId: record.updateId,
          noteId: record.noteId,
          sectionId: record.sectionId,
          cryptoOwnerId: record.cryptoOwnerId,
          expectedKeyEpoch: record.keyEpoch,
          nonce: toBase64(nonce),
          cipherLength: cipher.length,
          ...(record.checkpointSequenceCutoff === undefined
            ? {}
            : { checkpointSequenceCutoff: record.checkpointSequenceCutoff })
        },
        cipher,
        CLIENT_REALTIME_FRAME_MAX_BYTES
      ))
    );
  }

  async function acknowledgeDurableUpdate(message: CrdtAckV2): Promise<void> {
    const outbox = await getDurableOutbox();
    const record = (await (outboxStore ?? ownedDatabase)?.listOutbox(userId))?.find(
      (candidate) =>
        candidate.updateId === message.updateId &&
        candidate.sectionId === message.sectionId &&
        candidate.keyEpoch === message.keyEpoch
    );
    if (!record) {
      return;
    }
    await outbox.acknowledge(record, message.serverSequence);
    pendingCrdtAcks.get(message.updateId)?.resolve();
    pendingCrdtAcks.delete(message.updateId);
  }

  function handleDurableReject(message: CrdtRejectV2): void {
    if (message.code === "storage-limit") {
      onCrdtError?.("Realtime storage is full; encrypted work remains queued.");
      return;
    }
    if (message.code === "frame-too-large") {
      onCrdtError?.("Realtime update requires resumable encrypted chunk transfer.");
      return;
    }
    if (message.code === "rotation-pending") {
      onCrdtError?.("Note-key rotation is pending; encrypted work remains queued.");
      return;
    }
    rejectPendingAck(
      message.updateId,
      message.code === "forbidden"
        ? "Realtime write access was revoked."
        : "Superseded by note-key rotation."
    );
  }

  function sendSectionSubscription(
    subscription: OutboxFence & { afterSequence: number }
  ): void {
    if (socket.readyState !== WebSocket.OPEN || !crdtV2Enabled) {
      return;
    }
    socket.send(JSON.stringify({
      type: "crdt-subscribe",
      requestId: crypto.randomUUID(),
      noteId: subscription.noteId,
      sectionId: subscription.sectionId,
      expectedKeyEpoch: subscription.keyEpoch,
      afterSequence: subscription.afterSequence
    }));
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
    subscribeCrdt: (noteId, sectionId, keyEpoch, afterSequence = 0) => {
      if (sectionId && keyEpoch) {
        const subscription = { noteId, sectionId, keyEpoch, afterSequence };
        pendingSectionSubscriptions.set(
          sectionSubscriptionKey(noteId, sectionId, keyEpoch),
          subscription
        );
        if (socket.readyState === WebSocket.OPEN && crdtV2Enabled) {
          sendSectionSubscription(subscription);
          void getDurableOutbox().then((outbox) => outbox.activate(subscription));
        }
      } else {
        pendingSubscriptions.add(noteId);
        if (socket.readyState === WebSocket.OPEN && crdtEnabled) {
          socket.send(JSON.stringify({ type: "crdt-subscribe", noteId }));
        }
      }
    },
    sendCrdtUpdate: (update) => {
      const delivered = new Promise<void>((resolve, reject) => {
        pendingCrdtAcks.set(update.updateId, { reject, resolve });
      });
      if (isScopedCrdtUpdate(update)) {
        void enqueueDurableUpdate(update).catch((error: unknown) => {
          rejectPendingAck(
            update.updateId,
            error instanceof Error
              ? error.message
              : "Encrypted realtime update could not be queued."
          );
          onCrdtError?.(
            "Offline edits could not be saved durably; keep this tab open until storage is available."
          );
        });
        return delivered;
      }
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
      closeDurableStorage();
      socket.close();
    }
  };

  async function enqueueDurableUpdate(update: ScopedEncryptedCrdtMessage): Promise<void> {
    const outbox = await getDurableOutbox();
    const fence = {
      noteId: update.noteId,
      sectionId: update.sectionId,
      keyEpoch: update.keyEpoch
    };
    await outbox.activate(fence);
    const now = Date.now();
    await outbox.enqueue({
      userId,
      noteId: update.noteId,
      sectionId: update.sectionId,
      cryptoOwnerId: update.cryptoOwnerId,
      keyEpoch: update.keyEpoch,
      updateId: update.updateId,
      kind: update.kind,
      formatVersion: update.formatVersion,
      inlineCipher: fromCanonicalBase64(update.cipher),
      nonce: fromCanonicalBase64(update.nonce),
      ...(update.checkpointSequenceCutoff === undefined
        ? {}
        : { checkpointSequenceCutoff: update.checkpointSequenceCutoff }),
      state: "queued",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    });
  }

  function closeDurableStorage(): void {
    durableOutbox?.setTransport(null);
    durableOutbox?.close();
    durableOutbox = null;
    ownedDatabase?.close();
    ownedDatabase = null;
  }
}

function realtimeUrl(after: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({
    after: String(after),
    capabilities: `${CRDT_REALTIME_CAPABILITY},${CRDT_REALTIME_CAPABILITY_V2}`
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
  try {
    const control = parseCrdtControlMessage(parsed);
    if (
      control.type === "crdt-ack" ||
      control.type === "crdt-reject" ||
      control.type === "crdt-history-page"
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
      return typeof value.code === "string"
        ? (
            typeof value.updateId === "string" &&
            typeof value.sectionId === "string" &&
            [
              "storage-limit",
              "frame-too-large",
              "stale-epoch",
              "rotation-pending",
              "forbidden"
            ].includes(value.code)
          )
        : (
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

function parseRealtimeBinaryMessage(data: unknown): ReceivedBinaryCrdtMessage | null {
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

function isScopedCrdtUpdate(
  update: EncryptedCrdtMessage | ScopedEncryptedCrdtMessage
): update is ScopedEncryptedCrdtMessage {
  return "sectionId" in update;
}

function sectionSubscriptionKey(
  noteId: string,
  sectionId: string,
  keyEpoch: number
): string {
  return JSON.stringify([noteId, sectionId, keyEpoch]);
}

function isCrdtAckV2(message: CrdtAck | CrdtAckV2): message is CrdtAckV2 {
  return (
    "serverSequence" in message &&
    typeof message.serverSequence === "number" &&
    "sectionId" in message &&
    typeof message.sectionId === "string" &&
    "keyEpoch" in message &&
    typeof message.keyEpoch === "number"
  );
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
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
