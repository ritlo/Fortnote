// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, indexedDB as fakeIndexedDb } from "fake-indexeddb";
import {
  CRDT_BINARY_FORMAT_VERSION,
  cryptoReady,
  decodeCrdtBinaryFrame,
  encodeCrdtBinaryFrame,
  toBase64
} from "@fortnote/shared";
import { IndexedDbCapacityError, openFortnoteIndexedDb } from "@client/lib/indexedDb";
import type { ScopedEncryptedCrdtMessage } from "@client/realtime/crdt";
import type { PreparedEncryptedContentV2 } from "@client/cryptoClient";
import { connectRealtime, parseRealtimeMessage } from "@client/realtime/client";

const transferMocks = vi.hoisted(() => ({
  downloadVerifiedContent: vi.fn(),
  persistPreparedTransfer: vi.fn(),
  resumeContentUpload: vi.fn()
}));

vi.mock("@client/realtime/contentTransfer", () => transferMocks);

const sockets: MockWebSocket[] = [];

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readonly binarySent: ArrayBuffer[] = [];
  readyState = 0;
  binaryType = "blob";

  constructor(readonly url: string) {
    super();
    sockets.push(this);
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data === "string") {
      this.sent.push(data);
    } else {
      this.binarySent.push(data);
    }
  }

  close(): void {
    this.readyState = 3;
  }

  closeWithReason(code: number, reason: string): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  receiveBinary(value: Uint8Array): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: Uint8Array.from(value).buffer })
    );
  }
}

describe("realtime client", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      }
    });
    sockets.length = 0;
    vi.clearAllMocks();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  it("reports server quota pressure while retaining a content transfer", async () => {
    const serverCapacityError = { code: "storage_limit" };
    transferMocks.persistPreparedTransfer.mockResolvedValue({});
    transferMocks.resumeContentUpload.mockResolvedValue({
      kind: "server-capacity",
      error: serverCapacityError
    });
    const onCrdtError = vi.fn();
    const connection = connectRealtime({
      after: 0,
      userId: crypto.randomUUID(),
      contentStore: {} as Awaited<ReturnType<typeof openFortnoteIndexedDb>>,
      onMessage: vi.fn(),
      onCrdtError
    });

    const delivery = connection.sendCrdtContentDurably(preparedContent());
    await expect(delivery.durable).resolves.toBeUndefined();
    await expect(delivery.delivered).rejects.toThrow("Server storage is full");
    expect(onCrdtError).toHaveBeenCalledWith(
      "Server storage is full; encrypted work remains queued.",
      serverCapacityError
    );
    connection.close();
  });

  it("passes websocket close reasons to realtime consumers", () => {
    const onClose = vi.fn();
    connectRealtime({
      after: 0,
      userId: "user_1",
      onMessage: vi.fn(),
      onClose
    });

    sockets[0]!.closeWithReason(1008, "Note access revoked:note_1");

    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1008, reason: "Note access revoked:note_1" })
    );
  });

  it("ignores malformed websocket messages", () => {
    expect(parseRealtimeMessage("{not json")).toBeNull();
    expect(parseRealtimeMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parseRealtimeMessage(JSON.stringify({ type: "replay" }))).toBeNull();
    expect(
      parseRealtimeMessage(
        JSON.stringify({
          type: "presence",
          noteId: "note_1",
          users: [
            { userId: "user_1", username: "alice", state: "unknown", updatedAt: "now" }
          ]
        })
      )
    ).toBeNull();
    expect(parseRealtimeMessage(null)).toBeNull();
  });

  it("parses known websocket messages", () => {
    expect(
      parseRealtimeMessage(
        JSON.stringify({
          type: "connected",
          userId: "user_1",
          username: "alice",
          capabilities: ["crdt-binary-v2"]
        })
      )
    ).toEqual({
      type: "connected",
      userId: "user_1",
      username: "alice",
      capabilities: ["crdt-binary-v2"]
    });
    expect(
      parseRealtimeMessage(
        JSON.stringify({
          type: "crdt-sync",
          noteId: "note_1",
          keyEpoch: 2,
          hasUpdates: true
        })
      )
    ).toBeNull();
  });

  it("parses replay events with expected shape", () => {
    const event = {
      actorUserId: "user_1",
      createdAt: "2026-07-02T10:00:00.000Z",
      cursor: 1,
      eventId: "event_1",
      metadata: { attachmentId: "attachment_1" },
      noteId: "note_1",
      resourceId: "attachment_1",
      resourceType: "attachment",
      type: "attachment.created",
      version: 2
    };

    expect(
      parseRealtimeMessage(JSON.stringify({ type: "replay", events: [event] }))
    ).toEqual({
      type: "replay",
      events: [event]
    });
  });

  it("rejects unscoped JSON CRDT envelopes", () => {
    const update = {
      type: "crdt-update",
      formatVersion: 1,
      updateId: "update_1",
      noteId: "note_1",
      cryptoOwnerId: "user_1",
      keyEpoch: 1,
      cipher: "cipher",
      nonce: "nonce"
    };

    expect(parseRealtimeMessage(JSON.stringify(update))).toBeNull();
    expect(
      parseRealtimeMessage(JSON.stringify({ type: "crdt-ack", updateId: "update_1" }))
    ).toBeNull();
  });

  it("persists scoped ciphertext before sending a binary frame and clearing on ack", async () => {
    await cryptoReady();
    const database = await openFortnoteIndexedDb({
      factory: fakeIndexedDb,
      name: `fortnote-client-binary-${crypto.randomUUID()}`
    });
    const onMessage = vi.fn();
    const userId = crypto.randomUUID();
    const update = scopedUpdate();
    const connection = connectRealtime({
      after: 0,
      userId,
      ownerId: "tab-a",
      outboxStore: database,
      onMessage
    });
    connection.subscribeCrdt(update.noteId, update.sectionId, update.keyEpoch);

    const delivery = connection.sendCrdtUpdateDurably(update);
    let storedRecord: Awaited<ReturnType<typeof database.listOutbox>>[number] | undefined;
    await vi.waitFor(async () => {
      const records = await database.listOutbox(userId);
      expect(records).toHaveLength(1);
      storedRecord = records[0];
    });
    expect(storedRecord).toBeDefined();
    await expect(delivery.durable).resolves.toBeUndefined();
    expect(sockets[0]!.binarySent).toEqual([]);

    sockets[0]!.open();
    sockets[0]!.receive({
      ...connectedMessage(userId),
      capabilities: ["crdt-binary-v2"]
    });
    await vi.waitFor(async () => {
      expect((await database.listOutbox(userId))[0]?.attempts).toBe(1);
    });
    await vi.waitFor(() => {
      expect(sockets[0]!.binarySent).toHaveLength(1);
    });
    const decoded = decodeCrdtBinaryFrame(
      new Uint8Array(sockets[0]!.binarySent[0]!),
      256 * 1024
    );
    expect(decoded.header).toMatchObject({
      updateId: update.updateId,
      noteId: update.noteId,
      sectionId: update.sectionId,
      expectedKeyEpoch: update.keyEpoch,
      originClientId: expect.any(String)
    });
    expect(decoded.cipher).toEqual(Uint8Array.from([1, 2, 3]));
    expect(
      sockets[0]!.sent.map((message) => JSON.parse(message) as { type: string })
    ).toContainEqual(expect.objectContaining({ type: "crdt-subscribe" }));

    sockets[0]!.receive({
      type: "crdt-ack",
      updateId: update.updateId,
      sectionId: update.sectionId,
      result: "inserted",
      keyEpoch: update.keyEpoch,
      serverSequence: 1
    });
    await expect(delivery.delivered).resolves.toBeUndefined();
    await expect(database.getOutbox(storedRecord!)).resolves.toBeNull();
    await expect(database.getAcknowledgement(storedRecord!)).resolves.toMatchObject({
      serverSequence: 1
    });

    const incomingHeader = { ...decoded.header, serverSequence: 2 };
    sockets[0]!.receiveBinary(
      encodeCrdtBinaryFrame(incomingHeader, decoded.cipher, 256 * 1024)
    );
    expect(onMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "crdt-binary",
        updateId: update.updateId,
        serverSequence: 2
      })
    );
    await vi.waitFor(async () => {
      await expect(database.listOutbox(userId)).resolves.toEqual([]);
    });
    connection.close();
    await database.deleteDatabase();
  });

  it("preserves local-capacity errors when durable enqueue fails", async () => {
    await cryptoReady();
    const database = await openFortnoteIndexedDb({
      factory: new IDBFactory(),
      name: `fortnote-client-quota-${crypto.randomUUID()}`
    });
    const capacityError = new IndexedDbCapacityError();
    vi.spyOn(database, "putOutbox").mockRejectedValue(capacityError);
    const onCrdtError = vi.fn();
    const connection = connectRealtime({
      after: 0,
      userId: crypto.randomUUID(),
      outboxStore: database,
      onMessage: vi.fn(),
      onCrdtError
    });

    const delivery = connection.sendCrdtUpdateDurably(scopedUpdate());

    await Promise.all([
      expect(delivery.durable).rejects.toBe(capacityError),
      expect(delivery.delivered).rejects.toThrow("Protected browser storage is full")
    ]);
    expect(onCrdtError).toHaveBeenCalledWith(
      expect.stringContaining("saved durably"),
      capacityError
    );
    connection.close();
    await database.deleteDatabase();
  });

  it("removes pending section subscriptions and unsubscribes active scopes", async () => {
    const database = await openFortnoteIndexedDb({
      factory: fakeIndexedDb,
      name: `fortnote-client-unsubscribe-${crypto.randomUUID()}`
    });
    const userId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    const connection = connectRealtime({
      after: 0,
      userId,
      ownerId: "tab-unsubscribe",
      outboxStore: database,
      onMessage: vi.fn()
    });

    connection.subscribeCrdt(noteId, sectionId, 1);
    connection.unsubscribeCrdt(noteId, sectionId, 1);
    sockets[0]!.open();
    sockets[0]!.receive({
      ...connectedMessage(userId),
      capabilities: ["crdt-binary-v2"]
    });
    expect(
      sockets[0]!.sent.map((message) => JSON.parse(message) as { type: string })
    ).not.toContainEqual(expect.objectContaining({ type: "crdt-subscribe" }));

    connection.subscribeCrdt(noteId, sectionId, 1);
    connection.unsubscribeCrdt(noteId, sectionId, 1);
    expect(
      sockets[0]!.sent.map((message) => JSON.parse(message) as { type: string })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "crdt-subscribe", noteId, sectionId }),
        expect.objectContaining({ type: "crdt-unsubscribe", noteId, sectionId })
      ])
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    connection.close();
  });

  it("resumes an offline scoped update from IndexedDB after reconnect", async () => {
    await cryptoReady();
    const database = await openFortnoteIndexedDb({
      factory: fakeIndexedDb,
      name: `fortnote-client-reconnect-${crypto.randomUUID()}`
    });
    const userId = crypto.randomUUID();
    const update = scopedUpdate();
    const first = connectRealtime({
      after: 0,
      userId,
      ownerId: "tab-a",
      outboxStore: database,
      onMessage: vi.fn()
    });
    first.subscribeCrdt(update.noteId, update.sectionId, update.keyEpoch);
    const interruptedDelivery = first.sendCrdtUpdate(update);
    await vi.waitFor(async () => {
      expect(await database.listOutbox(userId)).toHaveLength(1);
    });
    first.close();
    await expect(interruptedDelivery).rejects.toThrow("closed");

    const second = connectRealtime({
      after: 0,
      userId,
      ownerId: "tab-a",
      outboxStore: database,
      onMessage: vi.fn()
    });
    second.subscribeCrdt(update.noteId, update.sectionId, update.keyEpoch);
    sockets[1]!.open();
    sockets[1]!.receive({
      ...connectedMessage(userId),
      capabilities: ["crdt-binary-v2"]
    });
    await vi.waitFor(() => {
      expect(sockets[1]!.binarySent).toHaveLength(1);
    });
    const replayed = decodeCrdtBinaryFrame(
      new Uint8Array(sockets[1]!.binarySent[0]!),
      256 * 1024
    );
    expect(replayed.header).toMatchObject({
      updateId: update.updateId,
      sectionId: update.sectionId,
      expectedKeyEpoch: update.keyEpoch
    });
    sockets[1]!.receive({
      type: "crdt-ack",
      updateId: update.updateId,
      sectionId: update.sectionId,
      result: "already-present",
      keyEpoch: update.keyEpoch,
      serverSequence: 9
    });
    await vi.waitFor(async () => {
      expect(await database.listOutbox(userId)).toEqual([]);
    });
    second.close();
    await database.deleteDatabase();
  });

  it("queues scoped updates after a transport closes", async () => {
    await cryptoReady();
    const database = await openFortnoteIndexedDb({
      factory: fakeIndexedDb,
      name: `fortnote-client-offline-${crypto.randomUUID()}`
    });
    const userId = crypto.randomUUID();
    const first = connectRealtime({
      after: 0,
      userId,
      ownerId: "tab-a",
      outboxStore: database,
      onMessage: vi.fn()
    });
    first.close();

    const update = scopedUpdate();
    const delivery = first.sendCrdtUpdateDurably(update);
    await expect(delivery.durable).resolves.toBeUndefined();
    expect(await database.listOutbox(userId)).toEqual([
      expect.objectContaining({ updateId: update.updateId })
    ]);

    first.subscribeCrdt(update.noteId, update.sectionId, update.keyEpoch);
    sockets[0]!.open();
    sockets[0]!.receive({
      ...connectedMessage(userId),
      capabilities: ["crdt-binary-v2"]
    });
    await vi.waitFor(() => {
      expect(sockets[0]!.binarySent).toHaveLength(1);
    });
    sockets[0]!.receive({
      type: "crdt-ack",
      updateId: update.updateId,
      sectionId: update.sectionId,
      result: "already-present",
      keyEpoch: update.keyEpoch,
      serverSequence: 1
    });
    await expect(delivery.delivered).resolves.toBeUndefined();
    await vi.waitFor(async () => {
      expect(await database.listOutbox(userId)).toEqual([]);
    });
    first.close();
    await database.deleteDatabase();
  });

  it("closes an owned database that finishes opening after the connection closes", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const blocker = await openRawDatabase(factory, "fortnote-protected", 1);
    const onCrdtError = vi.fn();
    const userId = crypto.randomUUID();
    const connection = connectRealtime({
      after: 0,
      userId,
      ownerId: "tab-a",
      onMessage: vi.fn(),
      onCrdtError
    });
    const update = scopedUpdate();
    connection.subscribeCrdt(update.noteId, update.sectionId, update.keyEpoch);
    sockets[0]!.open();
    sockets[0]!.receive({
      ...connectedMessage(userId),
      capabilities: ["crdt-binary-v2"]
    });

    connection.close();
    blocker.close();
    await vi.waitFor(() => {
      expect(onCrdtError).toHaveBeenCalledWith(
        "Encrypted offline work could not resume; it remains queued."
      );
    });

    await expect(upgradeDatabase(factory, "fortnote-protected", 3)).resolves.toBe(
      "opened"
    );
  });

  it("keeps valid oversized scoped work queued for resumable transfer", async () => {
    const database = await openFortnoteIndexedDb({
      factory: fakeIndexedDb,
      name: `fortnote-client-chunk-route-${crypto.randomUUID()}`
    });
    const userId = crypto.randomUUID();
    const update = scopedUpdate();
    const onCrdtError = vi.fn();
    const connection = connectRealtime({
      after: 0,
      userId,
      ownerId: "tab-a",
      outboxStore: database,
      onMessage: vi.fn(),
      onCrdtError
    });
    connection.subscribeCrdt(update.noteId, update.sectionId, update.keyEpoch);
    const delivery = connection.sendCrdtUpdate(update);
    sockets[0]!.open();
    sockets[0]!.receive({
      ...connectedMessage(userId),
      capabilities: ["crdt-binary-v2"]
    });
    await vi.waitFor(() => {
      expect(sockets[0]!.binarySent).toHaveLength(1);
    });

    sockets[0]!.receive({
      type: "crdt-reject",
      updateId: update.updateId,
      sectionId: update.sectionId,
      code: "frame-too-large"
    });
    expect(onCrdtError).toHaveBeenCalledWith(
      "Realtime update requires resumable encrypted chunk transfer."
    );
    await expect(database.listOutbox(userId)).resolves.toHaveLength(1);
    connection.close();
    await expect(delivery).rejects.toThrow("closed");
    await database.deleteDatabase();
  });

  it("reports structured v2 storage-limit rejections once", () => {
    const onCrdtError = vi.fn();
    connectRealtime({
      after: 0,
      userId: "user_1",
      onMessage: vi.fn(),
      onCrdtError
    });
    const rejection = {
      type: "crdt-reject",
      updateId: crypto.randomUUID(),
      sectionId: crypto.randomUUID(),
      code: "storage-limit"
    };

    sockets[0]!.receive(rejection);

    expect(onCrdtError).toHaveBeenCalledOnce();
    expect(onCrdtError).toHaveBeenCalledWith(
      "Realtime storage is full; encrypted work remains queued.",
      rejection
    );
  });

  it("retains a stale-epoch section draft before disabling retries", async () => {
    const database = await openFortnoteIndexedDb({
      factory: fakeIndexedDb,
      name: `fortnote-client-terminal-${crypto.randomUUID()}`
    });
    const userId = crypto.randomUUID();
    const firstUpdate = scopedUpdate();
    const secondUpdate = { ...firstUpdate, updateId: crypto.randomUUID() };
    let recordsAtCallback: Promise<
      Awaited<ReturnType<typeof database.listOutbox>>
    > | null = null;
    const onRecoverableCrdtDraft = vi.fn(() => {
      recordsAtCallback = database.listOutbox(userId);
    });
    const first = connectRealtime({
      after: 0,
      userId,
      ownerId: "tab-a",
      outboxStore: database,
      onMessage: vi.fn(),
      onRecoverableCrdtDraft
    });
    first.subscribeCrdt(firstUpdate.noteId, firstUpdate.sectionId, firstUpdate.keyEpoch);
    const firstDelivery = first.sendCrdtUpdate(firstUpdate);
    const secondDelivery = first.sendCrdtUpdate(secondUpdate);
    const firstRejected = expect(firstDelivery).rejects.toThrow("rotation");
    const secondRejected = expect(secondDelivery).rejects.toThrow("rotation");
    sockets[0]!.open();
    sockets[0]!.receive({
      ...connectedMessage(userId),
      capabilities: ["crdt-binary-v2"]
    });
    await vi.waitFor(() => {
      expect(sockets[0]!.binarySent).toHaveLength(2);
    });

    sockets[0]!.receive({
      type: "crdt-reject",
      updateId: firstUpdate.updateId,
      sectionId: firstUpdate.sectionId,
      code: "stale-epoch"
    });
    await Promise.all([firstRejected, secondRejected]);
    await vi.waitFor(() => {
      expect(onRecoverableCrdtDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "rejected",
          reason: "stale-epoch",
          updateIds: expect.arrayContaining([firstUpdate.updateId, secondUpdate.updateId])
        })
      );
    });
    await expect(recordsAtCallback).resolves.toEqual([
      expect.objectContaining({ state: "terminal-rejected" }),
      expect.objectContaining({ state: "terminal-rejected" })
    ]);
    first.close();

    const restored = vi.fn();
    const second = connectRealtime({
      after: 0,
      userId,
      ownerId: "tab-b",
      outboxStore: database,
      onMessage: vi.fn(),
      onRecoverableCrdtDraft: restored
    });
    second.subscribeCrdt(firstUpdate.noteId, firstUpdate.sectionId, firstUpdate.keyEpoch);
    sockets[1]!.open();
    sockets[1]!.receive({
      ...connectedMessage(userId),
      capabilities: ["crdt-binary-v2"]
    });
    await vi.waitFor(() => {
      expect(restored).toHaveBeenCalledWith(
        expect.objectContaining({ source: "restored", reason: "stale-epoch" })
      );
    });
    expect(sockets[1]!.binarySent).toEqual([]);

    second.close();
    await database.deleteDatabase();
  });
});

function openRawDatabase(
  factory: IDBFactory,
  name: string,
  version: number
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.addEventListener("success", () => {
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("IndexedDB open failed"));
    });
  });
}

function upgradeDatabase(
  factory: IDBFactory,
  name: string,
  version: number
): Promise<"blocked" | "opened"> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.addEventListener("blocked", () => {
      resolve("blocked");
    });
    request.addEventListener("success", () => {
      request.result.close();
      resolve("opened");
    });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("IndexedDB upgrade failed"));
    });
  });
}

function connectedMessage(userId = "user_1") {
  return {
    type: "connected",
    userId,
    username: "alice",
    capabilities: ["crdt-binary-v2"]
  };
}

function scopedUpdate(): ScopedEncryptedCrdtMessage {
  return {
    type: "crdt-update",
    formatVersion: CRDT_BINARY_FORMAT_VERSION,
    updateId: crypto.randomUUID(),
    noteId: crypto.randomUUID(),
    sectionId: crypto.randomUUID(),
    cryptoOwnerId: crypto.randomUUID(),
    keyEpoch: 1,
    kind: "update",
    cipher: toBase64(Uint8Array.from([1, 2, 3])),
    nonce: toBase64(new Uint8Array(24))
  };
}

function preparedContent(): PreparedEncryptedContentV2 {
  return {
    cryptoOwnerId: crypto.randomUUID(),
    noteId: crypto.randomUUID(),
    sectionId: crypto.randomUUID(),
    keyEpoch: 1,
    updateId: crypto.randomUUID(),
    uploadId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    kind: "update",
    formatVersion: 2,
    totalCipherBytes: 1,
    chunkCount: 1,
    manifestHash: "a".repeat(64),
    chunks: [
      {
        chunkIndex: 0,
        cipherBytes: Uint8Array.of(1),
        cipherHash: "b".repeat(64),
        nonce: toBase64(new Uint8Array(24))
      }
    ]
  };
}
