import type { ContentManifestSummary, PresenceState } from "../api";
import {
  CRDT_BINARY_FORMAT_VERSION,
  CRDT_REALTIME_CAPABILITY_V2,
  encodeCrdtBinaryFrame,
  fromCanonicalBase64,
  randomUuid,
  toBase64,
  type CrdtAckV2,
  type CrdtRejectV2
} from "@fortnote/shared";
import {
  openFortnoteIndexedDb,
  type EncryptedOutboxRecord,
  type FortnoteIndexedDb
} from "../lib/indexedDb";
import { getClientInstanceId } from "../api";
import type { PreparedEncryptedContentV2 } from "../cryptoClient";
import {
  createEncryptedOutbox,
  type EncryptedOutbox,
  type EncryptedSectionDraft,
  type EncryptedOutboxStore,
  type OutboxFence
} from "./outbox";
import {
  downloadVerifiedContent,
  persistPreparedTransfer,
  resumeContentUpload,
  type VerifiedContentDownloadInput
} from "./contentTransfer";
import type { ScopedEncryptedCrdtMessage } from "./crdt";
import {
  CLIENT_REALTIME_FRAME_MAX_BYTES,
  parseRealtimeBinaryMessage,
  parseRealtimeMessage,
  type RealtimeMessage
} from "./protocol";

export { parseRealtimeMessage } from "./protocol";
export type { RealtimeMessage } from "./protocol";

export type ClientPresenceState = PresenceState | "left";

export interface RecoverableCrdtDraft extends EncryptedSectionDraft {
  source: "rejected" | "restored";
}

interface RealtimeClientOptions {
  after: number;
  userId: string;
  onMessage: (message: RealtimeMessage) => void;
  onCrdtError?: (message: string, error?: unknown) => void;
  onRecoverableCrdtDraft?: (draft: RecoverableCrdtDraft) => void;
  onOpen?: () => void;
  onClose?: (event?: CloseEvent) => void;
  onError?: () => void;
  outboxStore?: EncryptedOutboxStore;
  contentStore?: FortnoteIndexedDb;
  ownerId?: string;
}

export interface RealtimeConnection {
  close: () => void;
  suspend: () => void;
  downloadCrdtContent: (input: VerifiedContentDownloadInput) => Promise<Uint8Array>;
  sendPresence: (noteId: string, state: ClientPresenceState) => void;
  subscribeCrdt: (
    noteId: string,
    sectionId: string,
    keyEpoch: number,
    afterSequence?: number
  ) => void;
  unsubscribeCrdt: (noteId: string, sectionId: string, keyEpoch: number) => void;
  sendCrdtUpdate: (update: ScopedEncryptedCrdtMessage) => Promise<void>;
  sendCrdtUpdateDurably: (
    update: ScopedEncryptedCrdtMessage
  ) => DurableRealtimeDelivery<void>;
  sendCrdtContent: (
    prepared: PreparedEncryptedContentV2
  ) => Promise<ContentManifestSummary>;
  sendCrdtContentDurably: (
    prepared: PreparedEncryptedContentV2
  ) => DurableRealtimeDelivery<ContentManifestSummary>;
}

export interface DurableRealtimeDelivery<T> {
  durable: Promise<void>;
  delivered: Promise<T>;
}

export function connectRealtime({
  after,
  userId,
  onMessage,
  onCrdtError,
  onRecoverableCrdtDraft,
  onOpen,
  onClose,
  onError,
  outboxStore,
  contentStore,
  ownerId = getClientInstanceId()
}: RealtimeClientOptions): RealtimeConnection {
  const transportClientId = randomUuid();
  const socket = new WebSocket(realtimeUrl(after, transportClientId));
  socket.binaryType = "arraybuffer";
  const pendingSectionSubscriptions = new Map<
    string,
    OutboxFence & { afterSequence: number }
  >();
  const pendingCrdtAcks = new Map<
    string,
    { reject: (error: Error) => void; resolve: () => void }
  >();
  let crdtV2Enabled = false;
  let ownedDatabase: FortnoteIndexedDb | null = null;
  let ownedDatabasePromise: Promise<FortnoteIndexedDb> | null = null;
  const activeContentTransfers = new Set<Promise<unknown>>();
  let durableStorageClosing = false;
  let durableOutbox: EncryptedOutbox | null = null;
  let durableOutboxPromise: Promise<EncryptedOutbox> | null = null;
  socket.addEventListener("open", () => {
    onOpen?.();
  });
  socket.addEventListener("message", (event) => {
    const message =
      parseRealtimeBinaryMessage(event.data) ?? parseRealtimeMessage(event.data);
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
        crdtV2Enabled = message.capabilities.includes(CRDT_REALTIME_CAPABILITY_V2);
        if (crdtV2Enabled) {
          void resumeDurableOutbox().catch(() => {
            onCrdtError?.("Encrypted offline work could not resume; it remains queued.");
          });
          for (const subscription of pendingSectionSubscriptions.values()) {
            sendSectionSubscription(subscription);
          }
        }
      } else if (message.type === "crdt-ack") {
        void acknowledgeDurableUpdate(message);
      } else if (message.type === "crdt-reject") {
        handleDurableReject(message);
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
  socket.addEventListener("close", (event) => {
    // A transport close is recoverable. Keep the account-scoped outbox and
    // database alive while the reconnecting client continues to accept edits.
    durableOutbox?.setTransport(null);
    onClose?.(event);
  });
  socket.addEventListener("error", () => {
    onError?.();
  });

  async function getDurableOutbox(): Promise<EncryptedOutbox> {
    if (durableStorageClosing) {
      // A socket close is a transport interruption, not a vault teardown.
      // Reopen the account-scoped store so edits made while offline remain
      // durably queued for the next connection.
      durableStorageClosing = false;
      durableOutboxPromise = null;
    }
    durableOutboxPromise ??= (async () => {
      const database = outboxStore ?? (await getOwnedDatabase());
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
    for (const draft of await outbox.listRecoverableDrafts()) {
      onRecoverableCrdtDraft?.({ ...draft, source: "restored" });
    }
    await Promise.all(
      [...pendingSectionSubscriptions.values()].map((subscription) =>
        outbox.activate(subscription)
      )
    );
    await resumePersistedContent();
  }

  async function getOwnedDatabase(): Promise<FortnoteIndexedDb> {
    if (durableStorageClosing) {
      durableStorageClosing = false;
    }
    ownedDatabasePromise ??= openFortnoteIndexedDb()
      .then((database) => {
        if (durableStorageClosing && activeContentTransfers.size === 0) {
          database.close();
          throw new Error("Realtime connection closed.");
        }
        ownedDatabase = database;
        return database;
      })
      .catch((error: unknown) => {
        ownedDatabasePromise = null;
        throw error;
      });
    return ownedDatabasePromise;
  }

  function getContentDatabase(): Promise<FortnoteIndexedDb> {
    return contentStore ? Promise.resolve(contentStore) : getOwnedDatabase();
  }

  async function resumePersistedContent(): Promise<void> {
    if (!contentStore && outboxStore) {
      return;
    }
    const database = await getContentDatabase();
    for (const record of await database.listContentTransfers(userId)) {
      const outcome = await trackContentTransfer(
        resumeContentUpload({ database, record })
      );
      if (outcome.kind === "local-capacity") {
        onCrdtError?.(
          "Protected browser storage is full; encrypted work remains queued.",
          outcome.error
        );
      } else if (outcome.kind === "server-capacity") {
        onCrdtError?.(
          "Server storage is full; encrypted work remains queued.",
          outcome.error
        );
      }
    }
  }

  function trackContentTransfer<T>(transfer: Promise<T>): Promise<T> {
    activeContentTransfers.add(transfer);
    const finish = () => {
      activeContentTransfers.delete(transfer);
      if (durableStorageClosing && activeContentTransfers.size === 0) {
        closeOwnedDatabase();
      }
    };
    void transfer.then(finish, finish);
    return transfer;
  }

  function sendOutboxRecord(record: EncryptedOutboxRecord): void {
    if (socket.readyState !== WebSocket.OPEN || !crdtV2Enabled) {
      throw new Error("Realtime binary transport is unavailable");
    }
    if (record.kind === "chunk") {
      throw new Error("Encrypted chunk requires resumable transfer");
    }
    const cipher = Uint8Array.from(record.inlineCipher);
    const nonce = Uint8Array.from(record.nonce);
    socket.send(
      exactArrayBuffer(
        encodeCrdtBinaryFrame(
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
            ...(record.originClientId === undefined
              ? {}
              : { originClientId: record.originClientId }),
            ...(record.checkpointSequenceCutoff === undefined
              ? {}
              : { checkpointSequenceCutoff: record.checkpointSequenceCutoff })
          },
          cipher,
          CLIENT_REALTIME_FRAME_MAX_BYTES
        )
      )
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
      onCrdtError?.("Realtime storage is full; encrypted work remains queued.", message);
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
    void preserveRejectedDraft(message);
  }

  async function preserveRejectedDraft(message: CrdtRejectV2): Promise<void> {
    const reason = message.code === "forbidden" ? "forbidden" : "stale-epoch";
    const rejectionMessage =
      message.code === "forbidden"
        ? "Realtime write access was revoked."
        : "Superseded by note-key rotation.";
    try {
      const outbox = await getDurableOutbox();
      const draft = await outbox.preserveTerminalRejection(
        message.updateId,
        message.sectionId,
        reason
      );
      if (!draft) {
        rejectPendingAck(message.updateId, rejectionMessage);
        onCrdtError?.(
          "Realtime rejected an edit, but its recoverable encrypted draft could not be located."
        );
        return;
      }
      for (const updateId of draft.updateIds) {
        rejectPendingAck(updateId, rejectionMessage);
      }
      onRecoverableCrdtDraft?.({ ...draft, source: "rejected" });
    } catch {
      rejectPendingAck(message.updateId, rejectionMessage);
      onCrdtError?.(
        "Realtime rejected an edit; keep this tab open while encrypted draft recovery is unavailable."
      );
    }
  }

  function sendSectionSubscription(
    subscription: OutboxFence & { afterSequence: number }
  ): void {
    if (socket.readyState !== WebSocket.OPEN || !crdtV2Enabled) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: "crdt-subscribe",
        requestId: randomUuid(),
        noteId: subscription.noteId,
        sectionId: subscription.sectionId,
        expectedKeyEpoch: subscription.keyEpoch,
        afterSequence: subscription.afterSequence
      })
    );
  }

  function rejectPendingAck(updateId: string, message: string): void {
    pendingCrdtAcks.get(updateId)?.reject(new Error(message));
    pendingCrdtAcks.delete(updateId);
  }

  return {
    downloadCrdtContent: (input) =>
      trackContentTransfer(
        (async () => {
          const database = await getContentDatabase();
          return downloadVerifiedContent({
            ...input,
            cache: { database, userId }
          });
        })()
      ),
    sendPresence: (noteId, state) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({ type: "presence", noteId, state }));
    },
    subscribeCrdt: (noteId, sectionId, keyEpoch, afterSequence = 0) => {
      const subscription = { noteId, sectionId, keyEpoch, afterSequence };
      pendingSectionSubscriptions.set(
        sectionSubscriptionKey(noteId, sectionId, keyEpoch),
        subscription
      );
      if (socket.readyState === WebSocket.OPEN && crdtV2Enabled) {
        sendSectionSubscription(subscription);
        void getDurableOutbox().then((outbox) => outbox.activate(subscription));
      }
    },
    unsubscribeCrdt: (noteId, sectionId, keyEpoch) => {
      pendingSectionSubscriptions.delete(
        sectionSubscriptionKey(noteId, sectionId, keyEpoch)
      );
      if (socket.readyState === WebSocket.OPEN && crdtV2Enabled) {
        socket.send(
          JSON.stringify({
            type: "crdt-unsubscribe",
            noteId,
            sectionId,
            expectedKeyEpoch: keyEpoch
          })
        );
      }
    },
    sendCrdtUpdate: (update) => {
      const delivery = startScopedCrdtDelivery(update);
      void delivery.durable.catch(() => undefined);
      return delivery.delivered;
    },
    sendCrdtUpdateDurably: startScopedCrdtDelivery,
    sendCrdtContent: (prepared) => {
      const delivery = startContentDelivery(prepared);
      void delivery.durable.catch(() => undefined);
      return delivery.delivered;
    },
    sendCrdtContentDurably: startContentDelivery,
    suspend: () => {
      durableOutbox?.setTransport(null);
      socket.close();
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

  function startScopedCrdtDelivery(
    update: ScopedEncryptedCrdtMessage
  ): DurableRealtimeDelivery<void> {
    const delivered = new Promise<void>((resolve, reject) => {
      pendingCrdtAcks.set(update.updateId, { reject, resolve });
    });
    const durable = enqueueDurableUpdate(update).catch((error: unknown) => {
      rejectPendingAck(
        update.updateId,
        error instanceof Error
          ? error.message
          : "Encrypted realtime update could not be queued."
      );
      onCrdtError?.(
        "Offline edits could not be saved durably; keep this tab open until storage is available.",
        error
      );
      throw error;
    });
    return { durable, delivered };
  }

  function startContentDelivery(
    prepared: PreparedEncryptedContentV2
  ): DurableRealtimeDelivery<ContentManifestSummary> {
    let resolveDurable!: () => void;
    let rejectDurable!: (error: unknown) => void;
    const durable = new Promise<void>((resolve, reject) => {
      resolveDurable = resolve;
      rejectDurable = reject;
    });
    const outcome = trackContentTransfer(
      (async () => {
        try {
          const database = await getContentDatabase();
          const record = await persistPreparedTransfer(database, userId, prepared);
          resolveDurable();
          return await resumeContentUpload({ database, record });
        } catch (error) {
          rejectDurable(error);
          throw error;
        }
      })()
    );
    const delivered = outcome.then(
      (result) => {
        if (result.kind === "local-capacity") {
          onCrdtError?.(
            "Protected browser storage is full; encrypted work remains queued.",
            result.error
          );
          throw new Error("Protected browser storage is full");
        }
        if (result.kind === "server-capacity") {
          onCrdtError?.(
            "Server storage is full; encrypted work remains queued.",
            result.error
          );
          throw new Error("Server storage is full");
        }
        return result.manifest;
      },
      (error: unknown) => {
        onCrdtError?.("Encrypted content transfer failed.", error);
        throw error;
      }
    );
    return { durable, delivered };
  }

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
      originClientId: transportClientId,
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
    durableStorageClosing = true;
    durableOutbox?.setTransport(null);
    durableOutbox?.close();
    durableOutbox = null;
    durableOutboxPromise = null;
    if (activeContentTransfers.size === 0) {
      closeOwnedDatabase();
    }
  }

  function closeOwnedDatabase(): void {
    const wasOpen = ownedDatabase !== null;
    ownedDatabase?.close();
    ownedDatabase = null;
    if (wasOpen) {
      ownedDatabasePromise = null;
    }
  }
}

function realtimeUrl(after: number, clientId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({
    after: String(after),
    clientId,
    capabilities: CRDT_REALTIME_CAPABILITY_V2
  });
  return `${protocol}//${window.location.host}/api/realtime?${query.toString()}`;
}

function sectionSubscriptionKey(
  noteId: string,
  sectionId: string,
  keyEpoch: number
): string {
  return JSON.stringify([noteId, sectionId, keyEpoch]);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
