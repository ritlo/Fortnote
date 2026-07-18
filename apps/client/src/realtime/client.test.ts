// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { indexedDB as fakeIndexedDb } from "fake-indexeddb";
import {
  CRDT_BINARY_FORMAT_VERSION,
  cryptoReady,
  decodeCrdtBinaryFrame,
  encodeCrdtBinaryFrame,
  toBase64
} from "@fortnote/shared";
import { openFortnoteIndexedDb } from "../lib/indexedDb";
import type { ScopedEncryptedCrdtMessage } from "./crdt";
import { connectRealtime, parseRealtimeMessage } from "./client";

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
    vi.stubGlobal("WebSocket", MockWebSocket);
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
          users: [{ userId: "user_1", username: "alice", state: "unknown", updatedAt: "now" }]
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
          capabilities: ["crdt-v1"]
        })
      )
    ).toEqual({
      type: "connected",
      userId: "user_1",
      username: "alice",
      capabilities: ["crdt-v1"]
    });
    const sync = {
      type: "crdt-sync",
      noteId: "note_1",
      keyEpoch: 2,
      hasUpdates: true
    };
    expect(parseRealtimeMessage(JSON.stringify(sync))).toEqual(sync);
    expect(parseRealtimeMessage(JSON.stringify({ ...sync, keyEpoch: undefined })))
      .toBeNull();
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

    expect(parseRealtimeMessage(JSON.stringify({ type: "replay", events: [event] }))).toEqual({
      type: "replay",
      events: [event]
    });
  });

  it("parses versioned encrypted CRDT updates", () => {
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

    expect(parseRealtimeMessage(JSON.stringify(update))).toEqual(update);
    expect(
      parseRealtimeMessage(JSON.stringify({ ...update, formatVersion: 2 }))
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

    const delivered = connection.sendCrdtUpdate(update);
    let storedRecord: Awaited<ReturnType<typeof database.listOutbox>>[number] | undefined;
    await vi.waitFor(async () => {
      const records = await database.listOutbox(userId);
      expect(records).toHaveLength(1);
      storedRecord = records[0];
    });
    expect(storedRecord).toBeDefined();
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
      expectedKeyEpoch: update.keyEpoch
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
    await expect(delivered).resolves.toBeUndefined();
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
    connection.close();
    await database.deleteDatabase();
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

  it("retries encrypted CRDT updates until the server acknowledges them", async () => {
    const update = {
      type: "crdt-update" as const,
      formatVersion: 1 as const,
      updateId: "update_1",
      noteId: "note_1",
      cryptoOwnerId: "user_1",
      keyEpoch: 1,
      cipher: "cipher",
      nonce: "nonce"
    };
    const onMessage = vi.fn();
    const first = connectRealtime({ after: 0, userId: "user_1", onMessage });
    const firstDelivery = first.sendCrdtUpdate(update);
    expect(sockets[0]!.sent).toEqual([]);

    sockets[0]!.open();
    sockets[0]!.receive(connectedMessage());
    expect(
      sockets[0]!.sent.map((message) => JSON.parse(message) as unknown)
    ).toContainEqual(update);

    const rejection = {
      type: "crdt-reject",
      noteId: update.noteId,
      updateId: update.updateId,
      reason: "storage-limit"
    };
    sockets[0]!.receive(rejection);
    expect(onMessage).toHaveBeenLastCalledWith(rejection);
    expect(JSON.parse(localStorage.getItem(outboxKey("user_1")) ?? "[]"))
      .toEqual([update]);

    const second = connectRealtime({ after: 0, userId: "user_1", onMessage: vi.fn() });
    sockets[1]!.open();
    sockets[1]!.receive(connectedMessage());
    expect(
      sockets[1]!.sent.map((message) => JSON.parse(message) as unknown)
    ).toContainEqual(update);

    sockets[0]!.receive({ type: "crdt-ack", updateId: update.updateId });
    await expect(firstDelivery).resolves.toBeUndefined();
    expect(JSON.parse(localStorage.getItem(outboxKey("user_1")) ?? "[]"))
      .toEqual([]);

    const discarded = second.sendCrdtUpdate(update);
    second.discardCrdtUpdates(update.noteId, 2);
    await expect(discarded).rejects.toThrow("Superseded");
    expect(JSON.parse(localStorage.getItem(outboxKey("user_1")) ?? "[]"))
      .toEqual([]);
  });

  it("does not flush one user's outbox through another user's session", () => {
    const update = crdtUpdate();
    const alice = connectRealtime({ after: 0, userId: "alice", onMessage: vi.fn() });
    void alice.sendCrdtUpdate(update);

    connectRealtime({ after: 0, userId: "bob", onMessage: vi.fn() });
    sockets[1]!.open();
    sockets[1]!.receive(connectedMessage("bob"));

    expect(sockets[1]!.sent).toEqual([]);
  });

  it("surfaces localStorage quota failures", () => {
    localStorage.setItem = vi.fn(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const onCrdtError = vi.fn();
    const connection = connectRealtime({
      after: 0,
      userId: "quota_user",
      onMessage: vi.fn(),
      onCrdtError
    });

    void connection.sendCrdtUpdate(crdtUpdate());

    expect(onCrdtError).toHaveBeenCalledWith(expect.stringContaining("durably"));
  });

  it("drops terminally forbidden updates", async () => {
    const update = crdtUpdate();
    const connection = connectRealtime({
      after: 0,
      userId: "viewer",
      onMessage: vi.fn()
    });
    const delivery = connection.sendCrdtUpdate(update);
    sockets[0]!.open();
    sockets[0]!.receive(connectedMessage("viewer"));
    sockets[0]!.receive({
      type: "crdt-reject",
      noteId: update.noteId,
      updateId: update.updateId,
      reason: "forbidden"
    });

    await expect(delivery).rejects.toThrow("revoked");
    expect(JSON.parse(localStorage.getItem(outboxKey("viewer")) ?? "[]"))
      .toEqual([]);
  });

  it("drops terminally oversized updates", async () => {
    const update = crdtUpdate();
    const connection = connectRealtime({
      after: 0,
      userId: "oversized",
      onMessage: vi.fn()
    });
    const delivery = connection.sendCrdtUpdate(update);
    sockets[0]!.open();
    sockets[0]!.receive(connectedMessage("oversized"));
    sockets[0]!.receive({
      type: "crdt-reject",
      noteId: update.noteId,
      updateId: update.updateId,
      reason: "payload-too-large"
    });

    expect(JSON.parse(localStorage.getItem(outboxKey("oversized")) ?? "[]"))
      .toEqual([]);
    await expect(delivery).rejects.toThrow("too large");
  });

  it("retries a storage-limited update after a checkpoint acknowledgement", () => {
    const update = crdtUpdate();
    const checkpoint = {
      type: "crdt-checkpoint" as const,
      formatVersion: 1 as const,
      updateId: "checkpoint_1",
      noteId: update.noteId,
      cryptoOwnerId: update.cryptoOwnerId,
      keyEpoch: 1,
      cipher: "cipher",
      nonce: "nonce",
      compactedUpdateIds: [] as string[]
    };
    localStorage.setItem(
      outboxKey("retry_user"),
      JSON.stringify([update, checkpoint])
    );

    connectRealtime({ after: 0, userId: "retry_user", onMessage: vi.fn() });
    sockets[0]!.open();
    sockets[0]!.receive(connectedMessage("retry_user"));

    sockets[0]!.receive({
      type: "crdt-reject",
      noteId: update.noteId,
      updateId: update.updateId,
      reason: "storage-limit"
    });
    sockets[0]!.receive({ type: "crdt-ack", updateId: checkpoint.updateId });

    const sentUpdates = sockets[0]!.sent
      .map((message) => JSON.parse(message) as { type: string; updateId?: string })
      .filter((message) => message.type === "crdt-update" && message.updateId === update.updateId);
    expect(sentUpdates).toHaveLength(2);
  });

  it("does not resurrect acknowledged updates after storage cleanup fails", () => {
    const update = crdtUpdate();
    const userId = "cleanup-quota";
    localStorage.setItem(outboxKey(userId), JSON.stringify([update]));

    connectRealtime({ after: 0, userId, onMessage: vi.fn() });
    sockets[0]!.open();
    sockets[0]!.receive(connectedMessage(userId));
    localStorage.setItem = vi.fn(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    sockets[0]!.receive({ type: "crdt-ack", updateId: update.updateId });

    connectRealtime({ after: 0, userId, onMessage: vi.fn() });
    sockets[1]!.open();
    sockets[1]!.receive(connectedMessage(userId));
    expect(sockets[1]!.sent.map((message) => JSON.parse(message) as unknown))
      .not.toContainEqual(update);
  });
});

function connectedMessage(userId = "user_1") {
  return {
    type: "connected",
    userId,
    username: "alice",
    capabilities: ["crdt-v1"]
  };
}

function outboxKey(userId: string): string {
  return `fortnote:crdt-outbox:v1:${userId}`;
}

function crdtUpdate() {
  return {
    type: "crdt-update" as const,
    formatVersion: 1 as const,
    updateId: crypto.randomUUID(),
    noteId: crypto.randomUUID(),
    cryptoOwnerId: crypto.randomUUID(),
    keyEpoch: 1,
    cipher: "cipher",
    nonce: "nonce"
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
