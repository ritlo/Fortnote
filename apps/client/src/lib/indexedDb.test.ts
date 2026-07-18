import { indexedDB as fakeIndexedDb } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import {
  IndexedDbCapacityError,
  normalizeIndexedDbError,
  openFortnoteIndexedDb,
  type EncryptedContentTransferRecord,
  type EncryptedOutboxRecord,
  type ProtectedSearchIndexRecord,
  type SectionCacheRecord
} from "./indexedDb";

const databases: Awaited<ReturnType<typeof openFortnoteIndexedDb>>[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (database) => database.deleteDatabase()));
});

describe("protected IndexedDB storage", () => {
  it("atomically replaces an outbox item with its acknowledged marker", async () => {
    const database = await openDatabase();
    const record = outboxRecord();
    await database.putOutbox(record);

    await database.acknowledgeOutbox(record, 17);

    await expect(database.getOutbox(record)).resolves.toBeNull();
    await expect(database.getAcknowledgement(record)).resolves.toMatchObject({
      serverSequence: 17,
      updateId: record.updateId
    });
  });

  it("isolates compound ownership even when update IDs collide", async () => {
    const database = await openDatabase();
    const updateId = crypto.randomUUID();
    const first = outboxRecord({ userId: "user-a", updateId });
    const second = outboxRecord({ userId: "user-b", updateId });
    await database.putOutbox(first);
    await database.putOutbox(second);

    await expect(database.listOutbox("user-a")).resolves.toEqual([first]);
    await expect(database.listOutbox("user-b")).resolves.toEqual([second]);
  });

  it("serializes multi-tab lease compare-and-set decisions", async () => {
    const name = databaseName();
    const first = await openFortnoteIndexedDb({ factory: fakeIndexedDb, name });
    const second = await openFortnoteIndexedDb({ factory: fakeIndexedDb, name });
    databases.push(first, second);

    const outcomes = await Promise.all([
      first.acquireLease("user-a:note-a:section-a", "tab-a", 1_000, 5_000),
      second.acquireLease("user-a:note-a:section-a", "tab-b", 1_000, 5_000)
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await first.readLease("user-a:note-a:section-a")).toMatchObject({
      ownerId: outcomes[0] ? "tab-a" : "tab-b",
      expiresAt: 6_000
    });
  });

  it("classifies capacity failures without exposing stored data", () => {
    const normalized = normalizeIndexedDbError(
      new DOMException("secret browser detail", "QuotaExceededError")
    );
    expect(normalized).toBeInstanceOf(IndexedDbCapacityError);
    expect(normalized.message).toBe("Protected browser storage is full");
    expect(normalized.message).not.toContain("secret");
  });

  it("evicts least-recently-used cache entries but never pending work", async () => {
    const database = await openDatabase();
    const pending = cacheRecord({ manifestId: "pending", lastAccessedAt: 1, pending: true });
    const oldest = cacheRecord({ manifestId: "oldest", lastAccessedAt: 2 });
    const newest = cacheRecord({ manifestId: "newest", lastAccessedAt: 3 });
    await database.putSectionCache(pending);
    await database.putSectionCache(oldest);
    await database.putSectionCache(newest);

    await expect(database.evictSectionCache("user-a", 2)).resolves.toEqual(["oldest"]);
    await expect(database.listSectionCache("user-a")).resolves.toEqual([pending, newest]);
  });

  it("clears one account without deleting another account's protected records", async () => {
    const database = await openDatabase();
    const first = outboxRecord({ userId: "user-a" });
    const second = outboxRecord({ userId: "user-b" });
    await database.putOutbox(first);
    await database.putOutbox(second);
    await database.putSectionCache(cacheRecord({ userId: "user-a" }));
    await database.putContentTransfer(contentTransferRecord({ userId: "user-a" }));
    const otherSearch = searchIndexRecord({ userId: "user-b" });
    await database.putSearchIndexSection(searchIndexRecord({ userId: "user-a" }));
    await database.putSearchIndexSection(otherSearch);

    await database.clearAccount("user-a");

    await expect(database.listOutbox("user-a")).resolves.toEqual([]);
    await expect(database.listSectionCache("user-a")).resolves.toEqual([]);
    await expect(database.listContentTransfers("user-a")).resolves.toEqual([]);
    await expect(database.listSearchIndex("user-a")).resolves.toEqual([]);
    await expect(database.listOutbox("user-b")).resolves.toEqual([second]);
    await expect(database.listSearchIndex("user-b")).resolves.toEqual([otherSearch]);
  });

  it("persists encrypted transfer progress by account and stable upload identity", async () => {
    const database = await openDatabase();
    const uploadId = crypto.randomUUID();
    const first = contentTransferRecord({ userId: "user-a", uploadId });
    const second = contentTransferRecord({ userId: "user-b", uploadId });
    await database.putContentTransfer(first);
    await database.putContentTransfer(second);
    await database.putContentTransfer({
      ...first,
      uploadedChunkIndexes: [0],
      updatedAt: 2
    });

    await expect(database.getContentTransfer("user-a", uploadId)).resolves.toMatchObject({
      updateId: first.updateId,
      uploadedChunkIndexes: [0],
      updatedAt: 2
    });
    await expect(database.listContentTransfers("user-b")).resolves.toEqual([second]);
    await database.deleteContentTransfer("user-a", uploadId);
    await expect(database.getContentTransfer("user-a", uploadId)).resolves.toBeNull();
    await expect(database.getContentTransfer("user-b", uploadId)).resolves.toEqual(second);
  });
});

async function openDatabase() {
  const database = await openFortnoteIndexedDb({
    factory: fakeIndexedDb,
    name: databaseName()
  });
  databases.push(database);
  return database;
}

function databaseName(): string {
  return `fortnote-indexeddb-test-${crypto.randomUUID()}`;
}

function outboxRecord(
  overrides: Partial<EncryptedOutboxRecord> = {}
): EncryptedOutboxRecord {
  return {
    userId: "user-a",
    noteId: "note-a",
    sectionId: "section-a",
    cryptoOwnerId: "owner-a",
    keyEpoch: 1,
    updateId: crypto.randomUUID(),
    kind: "update",
    formatVersion: 2,
    inlineCipher: Uint8Array.from([1, 2, 3]),
    nonce: Uint8Array.from({ length: 24 }, (_, index) => index),
    state: "queued",
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function cacheRecord(overrides: Partial<SectionCacheRecord> = {}): SectionCacheRecord {
  return {
    userId: "user-a",
    noteId: "note-a",
    sectionId: "section-a",
    keyEpoch: 1,
    manifestId: crypto.randomUUID(),
    encryptedBytes: Uint8Array.from([4, 5, 6]),
    lastAccessedAt: 1,
    pending: false,
    ...overrides
  };
}

function contentTransferRecord(
  overrides: Partial<EncryptedContentTransferRecord> = {}
): EncryptedContentTransferRecord {
  const bytes = Uint8Array.from([7, 8, 9]);
  return {
    userId: "user-a",
    cryptoOwnerId: "owner-a",
    noteId: "note-a",
    sectionId: "section-a",
    keyEpoch: 1,
    updateId: crypto.randomUUID(),
    uploadId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    kind: "update",
    formatVersion: 2,
    totalCipherBytes: bytes.byteLength,
    chunkCount: 1,
    manifestHash: "a".repeat(64),
    chunks: [
      {
        chunkIndex: 0,
        cipherBytes: bytes,
        cipherHash: "b".repeat(64),
        nonce: "c".repeat(32)
      }
    ],
    uploadedChunkIndexes: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function searchIndexRecord(
  overrides: Partial<ProtectedSearchIndexRecord> = {}
): ProtectedSearchIndexRecord {
  return {
    userId: "user-a",
    noteId: "note-a",
    sectionId: "section-a",
    keyEpoch: 1,
    indexedSequence: 1,
    cipher: "cipher",
    nonce: "nonce",
    formatVersion: 2,
    updatedAt: 1,
    ...overrides
  };
}
