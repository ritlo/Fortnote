// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectRealtime, parseRealtimeMessage } from "./client";

const sockets: MockWebSocket[] = [];

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = 0;

  constructor(readonly url: string) {
    super();
    sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
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
