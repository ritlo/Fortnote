import { indexedDB as fakeIndexedDb } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openFortnoteIndexedDb,
  type AcknowledgementRecord,
  type EncryptedOutboxRecord,
  type FortnoteIndexedDb
} from "@client/lib/indexedDb";
import {
  createEncryptedOutbox,
  type EncryptedOutbox,
  type EncryptedOutboxStore
} from "@client/realtime/outbox";

const databases: FortnoteIndexedDb[] = [];
const outboxes: EncryptedOutbox[] = [];

afterEach(() => {
  outboxes.splice(0).forEach((outbox) => {
    outbox.close();
  });
  databases.splice(0).forEach((database) => {
    database.close();
  });
});

describe("encrypted realtime outbox", () => {
  it("commits ciphertext before any transport exists", async () => {
    const database = await openDatabase();
    const send = vi.fn<(record: EncryptedOutboxRecord) => void>();
    const outbox = openOutbox({
      database,
      ownerId: "tab-a",
      userId: "user-a"
    });
    const record = outboxRecord();

    await outbox.enqueue(record);

    await expect(database.getOutbox(record)).resolves.toEqual(record);
    expect(send).not.toHaveBeenCalled();

    outbox.setTransport(send);
    await outbox.activate(fenceFor(record));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ updateId: record.updateId }));
  });

  it("preserves concurrent same-account tab writes and grants one sender lease", async () => {
    const name = databaseName();
    const firstDatabase = await openDatabase(name);
    const secondDatabase = await openDatabase(name);
    const firstSend = vi.fn<(record: EncryptedOutboxRecord) => void>();
    const secondSend = vi.fn<(record: EncryptedOutboxRecord) => void>();
    const first = openOutbox({
      database: firstDatabase,
      ownerId: "tab-a",
      send: firstSend,
      userId: "user-a"
    });
    const second = openOutbox({
      database: secondDatabase,
      ownerId: "tab-b",
      send: secondSend,
      userId: "user-a"
    });
    const firstRecord = outboxRecord({ updateId: "update-a" });
    const secondRecord = outboxRecord({ updateId: "update-b" });

    await Promise.all([first.enqueue(firstRecord), second.enqueue(secondRecord)]);
    await Promise.all([first.activate(fenceFor(firstRecord)), second.activate(fenceFor(secondRecord))]);

    await expect(firstDatabase.listOutbox("user-a")).resolves.toHaveLength(2);
    expect(firstSend.mock.calls.length + secondSend.mock.calls.length).toBe(2);
    expect(firstSend.mock.calls.length === 0 || secondSend.mock.calls.length === 0).toBe(true);
    expect(new Set([...firstSend.mock.calls, ...secondSend.mock.calls].map(([record]) => record.updateId)))
      .toEqual(new Set(["update-a", "update-b"]));
  });

  it("resends a stable update after a lost acknowledgement", async () => {
    const database = await openDatabase();
    const send = vi.fn<(record: EncryptedOutboxRecord) => void>();
    let now = 1_000;
    const outbox = openOutbox({
      database,
      now: () => now,
      ownerId: "tab-a",
      retryDelayMs: 500,
      send,
      userId: "user-a"
    });
    const record = outboxRecord({ createdAt: now, updatedAt: now });

    await outbox.enqueue(record);
    await outbox.activate(fenceFor(record));
    expect(send).toHaveBeenCalledTimes(1);

    now += 499;
    await outbox.flush(fenceFor(record));
    expect(send).toHaveBeenCalledTimes(1);

    now += 1;
    await outbox.flush(fenceFor(record));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].updateId).toBe(send.mock.calls[1]?.[0].updateId);
    await expect(database.getOutbox(record)).resolves.toMatchObject({ attempts: 2 });
  });

  it("does not resurrect an acknowledged update when row cleanup fails", async () => {
    const record = outboxRecord();
    let acknowledgement: AcknowledgementRecord | null = null;
    const store: EncryptedOutboxStore = {
      acknowledgeOutbox: vi.fn((identity, serverSequence) => {
        acknowledgement = {
          ...identity,
          acknowledgedAt: Date.now(),
          serverSequence
        };
        return Promise.reject(new Error("cleanup failed"));
      }),
      acquireLease: vi.fn(() => Promise.resolve(true)),
      getAcknowledgement: vi.fn(() => Promise.resolve(acknowledgement)),
      listOutbox: vi.fn(() => Promise.resolve([record])),
      preserveOutboxFence: vi.fn(() => Promise.resolve([])),
      putOutbox: vi.fn(() => Promise.resolve()),
      subscribe: vi.fn(() => vi.fn())
    };
    const send = vi.fn<(record: EncryptedOutboxRecord) => void>();
    const outbox = openOutbox({
      database: store,
      ownerId: "tab-a",
      send,
      userId: record.userId
    });

    await outbox.acknowledge(record, 42);
    await outbox.activate(fenceFor(record));

    expect(store.getAcknowledgement).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends only the active account and exact note section epoch", async () => {
    const database = await openDatabase();
    const active = outboxRecord({ updateId: "active", keyEpoch: 2 });
    const staleEpoch = outboxRecord({ updateId: "stale", keyEpoch: 1 });
    const otherSection = outboxRecord({ updateId: "other-section", sectionId: "section-b" });
    const otherAccount = outboxRecord({ updateId: "other-account", userId: "user-b" });
    await Promise.all(
      [active, staleEpoch, otherSection, otherAccount].map((record) => database.putOutbox(record))
    );
    const send = vi.fn<(record: EncryptedOutboxRecord) => void>();
    const outbox = openOutbox({
      database,
      ownerId: "tab-a",
      send,
      userId: "user-a"
    });

    await outbox.activate(fenceFor(active));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ updateId: "active" }));
  });

  it("retains a terminally rejected fence and never resends it after reopening", async () => {
    const name = databaseName();
    const database = await openDatabase(name);
    const first = outboxRecord({ updateId: "rejected-a" });
    const second = outboxRecord({ updateId: "rejected-b" });
    const other = outboxRecord({ sectionId: "section-b", updateId: "still-sendable" });
    await Promise.all([first, second, other].map((record) => database.putOutbox(record)));
    const send = vi.fn<(record: EncryptedOutboxRecord) => void>();
    const outbox = openOutbox({
      database,
      ownerId: "tab-a",
      send,
      userId: "user-a"
    });

    await outbox.activate(fenceFor(first));
    const draft = await outbox.preserveTerminalRejection(
      first.updateId,
      first.sectionId,
      "stale-epoch"
    );

    expect(draft).toMatchObject({
      noteId: first.noteId,
      sectionId: first.sectionId,
      keyEpoch: first.keyEpoch,
      reason: "stale-epoch",
      updateIds: ["rejected-a", "rejected-b"]
    });
    await expect(database.listOutbox("user-a")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ updateId: "rejected-a", state: "terminal-rejected" }),
        expect.objectContaining({ updateId: "rejected-b", state: "terminal-rejected" }),
        expect.objectContaining({ updateId: "still-sendable", state: "queued" })
      ])
    );
    const sentBeforeRetry = send.mock.calls.length;
    await outbox.activate(fenceFor(first));
    await outbox.flush(fenceFor(first));
    expect(send).toHaveBeenCalledTimes(sentBeforeRetry);

    await outbox.acknowledge(first, 12);
    await expect(database.getOutbox(first)).resolves.toMatchObject({
      state: "terminal-rejected"
    });
    outbox.close();

    const reopenedSend = vi.fn<(record: EncryptedOutboxRecord) => void>();
    const reopened = openOutbox({
      database,
      ownerId: "tab-b",
      send: reopenedSend,
      userId: "user-a"
    });
    await reopened.activate(fenceFor(first));
    await reopened.activate(fenceFor(other));

    expect(reopenedSend).toHaveBeenCalledTimes(1);
    expect(reopenedSend).toHaveBeenCalledWith(
      expect.objectContaining({ updateId: "still-sendable" })
    );
    await expect(reopened.listRecoverableDrafts()).resolves.toEqual([
      expect.objectContaining({
        reason: "stale-epoch",
        updateIds: ["rejected-a", "rejected-b"]
      })
    ]);
  });
});

async function openDatabase(name = databaseName()): Promise<FortnoteIndexedDb> {
  const database = await openFortnoteIndexedDb({ factory: fakeIndexedDb, name });
  databases.push(database);
  return database;
}

function openOutbox(
  options: Parameters<typeof createEncryptedOutbox>[0]
): EncryptedOutbox {
  const outbox = createEncryptedOutbox(options);
  outboxes.push(outbox);
  return outbox;
}

function databaseName(): string {
  return `fortnote-outbox-test-${crypto.randomUUID()}`;
}

function fenceFor(record: EncryptedOutboxRecord) {
  return {
    keyEpoch: record.keyEpoch,
    noteId: record.noteId,
    sectionId: record.sectionId
  };
}

function outboxRecord(
  overrides: Partial<EncryptedOutboxRecord> = {}
): EncryptedOutboxRecord {
  return {
    attempts: 0,
    createdAt: 1,
    formatVersion: 2,
    inlineCipher: Uint8Array.from([1, 2, 3]),
    cryptoOwnerId: "owner-a",
    keyEpoch: 1,
    kind: "update",
    nonce: Uint8Array.from({ length: 24 }, (_, index) => index),
    noteId: "note-a",
    sectionId: "section-a",
    state: "queued",
    updateId: crypto.randomUUID(),
    updatedAt: 1,
    userId: "user-a",
    ...overrides
  };
}
