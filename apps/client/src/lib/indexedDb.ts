import {
  IndexedDbOperationError,
  normalizeIndexedDbError,
  type AcknowledgementRecord,
  type EncryptedContentTransferRecord,
  type EncryptedOutboxRecord,
  type FortnoteIndexedDb,
  type IndexedDbChange,
  type LeaseRecord,
  type OpenFortnoteIndexedDbOptions,
  type ProtectedSearchIndexRecord,
  type SectionCacheRecord
} from "./indexedDb/contracts";
import {
  ACKNOWLEDGEMENT_STORE,
  CONTENT_TRANSFER_STORE,
  deleteDatabase,
  deleteIndexEntries,
  deleteRecord,
  getRecord,
  idbError,
  LEASE_STORE,
  listByUser,
  openDatabase,
  OUTBOX_STORE,
  putRecord,
  requestResult,
  runTransaction,
  safeOperation,
  SEARCH_INDEX_STORE,
  SECTION_CACHE_STORE
} from "./indexedDb/driver";

export * from "./indexedDb/contracts";

type OutboxKey = Pick<
  EncryptedOutboxRecord,
  "userId" | "noteId" | "sectionId" | "keyEpoch" | "updateId"
>;
type CacheKey = Pick<
  SectionCacheRecord,
  "userId" | "noteId" | "sectionId" | "keyEpoch" | "manifestId"
>;
type SearchIndexKey = Pick<
  ProtectedSearchIndexRecord,
  "userId" | "noteId" | "sectionId" | "keyEpoch"
>;

export async function openFortnoteIndexedDb(
  options: OpenFortnoteIndexedDbOptions = {}
): Promise<FortnoteIndexedDb> {
  const factory = options.factory ?? globalThis.indexedDB;
  const name = options.name ?? "fortnote-protected";

  try {
    const database = await openDatabase(factory, name);
    return createDatabaseApi(database, factory, name, options.broadcastChannelFactory);
  } catch (error) {
    throw normalizeIndexedDbError(error);
  }
}

function createDatabaseApi(
  database: IDBDatabase,
  factory: IDBFactory,
  name: string,
  broadcastChannelFactory?: (name: string) => BroadcastChannel
): FortnoteIndexedDb {
  const listeners = new Set<(change: IndexedDbChange) => void>();
  const channel = createBroadcastChannel(name, broadcastChannelFactory);
  let closed = false;

  const receiveChange = (event: MessageEvent<IndexedDbChange>) => {
    if (isIndexedDbChange(event.data)) {
      listeners.forEach((listener) => {
        listener(event.data);
      });
    }
  };
  channel?.addEventListener("message", receiveChange);

  function notify(change: IndexedDbChange): void {
    listeners.forEach((listener) => {
      listener(change);
    });
    channel?.postMessage(change);
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    channel?.removeEventListener("message", receiveChange);
    channel?.close();
    database.close();
  }

  return {
    name,
    async acknowledgeOutbox(record, serverSequence) {
      await putRecord(database, ACKNOWLEDGEMENT_STORE, {
        ...outboxIdentity(record),
        serverSequence,
        acknowledgedAt: Date.now()
      } satisfies AcknowledgementRecord);
      await runTransaction(database, OUTBOX_STORE, "readwrite", async (transaction) => {
        const store = transaction.objectStore(OUTBOX_STORE);
        const current = await requestResult(
          store.get(outboxKey(record)) as IDBRequest<EncryptedOutboxRecord | undefined>
        );
        if (current?.state !== "terminal-rejected") {
          store.delete(outboxKey(record));
        }
      });
      notify({ store: "acknowledgements", userId: record.userId });
    },
    async acquireLease(scopeKey, ownerId, now, durationMs) {
      const acquired = await runTransaction(
        database,
        LEASE_STORE,
        "readwrite",
        async (transaction) => {
          const store = transaction.objectStore(LEASE_STORE);
          const current = await requestResult(
            store.get(scopeKey) as IDBRequest<LeaseRecord | undefined>
          );
          if (current && current.ownerId !== ownerId && current.expiresAt > now) {
            return false;
          }
          store.put({
            scopeKey,
            userId: accountFromScope(scopeKey),
            ownerId,
            expiresAt: now + durationMs
          } satisfies LeaseRecord);
          return true;
        }
      );
      if (acquired) {
        notify({ store: "leases", userId: accountFromScope(scopeKey) });
      }
      return acquired;
    },
    async clearAccount(userId) {
      const storeNames = [
        OUTBOX_STORE,
        ACKNOWLEDGEMENT_STORE,
        SECTION_CACHE_STORE,
        LEASE_STORE,
        CONTENT_TRANSFER_STORE,
        SEARCH_INDEX_STORE
      ];
      await runTransaction(database, storeNames, "readwrite", (transaction) => {
        for (const storeName of storeNames) {
          deleteIndexEntries(
            transaction.objectStore(storeName).index("byUserId"),
            userId
          );
        }
      });
      notify({ store: "outbox", userId });
      notify({ store: "section-cache", userId });
      notify({ store: "content-transfers", userId });
      notify({ store: "search-index", userId });
    },
    close,
    async deleteContentTransfer(userId, uploadId) {
      await deleteRecord(database, CONTENT_TRANSFER_STORE, [userId, uploadId]);
      notify({ store: "content-transfers", userId });
    },
    async deleteOutboxFence(fence) {
      await runTransaction(database, OUTBOX_STORE, "readwrite", async (transaction) => {
        const store = transaction.objectStore(OUTBOX_STORE);
        const records = await requestResult(
          store.getAll() as IDBRequest<EncryptedOutboxRecord[]>
        );
        records
          .filter((record) => matchesOutboxFence(record, fence))
          .forEach((record) => {
            store.delete(outboxKey(record));
          });
      });
      notify({ store: "outbox", userId: fence.userId });
    },
    async deleteSectionCache(record) {
      await deleteRecord(database, SECTION_CACHE_STORE, cacheKey(record));
      notify({ store: "section-cache", userId: record.userId });
    },
    async deleteDatabase() {
      close();
      await safeOperation(() => deleteDatabase(factory, name));
    },
    async evictSectionCache(userId, maxEntries, maxBytes = Number.MAX_SAFE_INTEGER) {
      if (
        !Number.isSafeInteger(maxEntries) ||
        maxEntries < 0 ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0
      ) {
        throw new IndexedDbOperationError();
      }
      const selected = await runTransaction(
        database,
        SECTION_CACHE_STORE,
        "readwrite",
        (transaction) => {
          const store = transaction.objectStore(SECTION_CACHE_STORE);
          return new Promise<SectionCacheRecord[]>((resolve, reject) => {
            const request = store.index("byUserId").getAll(userId) as IDBRequest<
              SectionCacheRecord[]
            >;
            request.onsuccess = () => {
              try {
                const records = request.result;
                const removable = records
                  .filter((record) => !record.pending)
                  .sort(compareCacheRecords);
                let remainingEntries = records.length;
                let remainingBytes = records.reduce(
                  (total, record) => total + record.encryptedBytes.byteLength,
                  0
                );
                const selected: SectionCacheRecord[] = [];
                for (const record of removable) {
                  if (remainingEntries <= maxEntries && remainingBytes <= maxBytes) {
                    break;
                  }
                  selected.push(record);
                  remainingEntries -= 1;
                  remainingBytes -= record.encryptedBytes.byteLength;
                }
                selected.forEach((record) => {
                  store.delete(cacheKey(record));
                });
                resolve(selected);
              } catch (error) {
                reject(error instanceof Error ? error : new IndexedDbOperationError());
              }
            };
            request.onerror = () => {
              reject(idbError(request.error));
            };
          });
        }
      );
      if (selected.length > 0) {
        notify({ store: "section-cache", userId });
      }
      return selected.map((record) => record.manifestId);
    },
    async getAcknowledgement(record) {
      return getRecord<AcknowledgementRecord>(
        database,
        ACKNOWLEDGEMENT_STORE,
        outboxKey(record)
      );
    },
    async getContentTransfer(userId, uploadId) {
      return getRecord<EncryptedContentTransferRecord>(database, CONTENT_TRANSFER_STORE, [
        userId,
        uploadId
      ]);
    },
    async getOutbox(record) {
      return getRecord<EncryptedOutboxRecord>(database, OUTBOX_STORE, outboxKey(record));
    },
    async getSearchIndexSection(record) {
      return getRecord<ProtectedSearchIndexRecord>(
        database,
        SEARCH_INDEX_STORE,
        searchIndexKey(record)
      );
    },
    async getSectionCache(record) {
      return getRecord<SectionCacheRecord>(
        database,
        SECTION_CACHE_STORE,
        cacheKey(record)
      );
    },
    async listOutbox(userId) {
      const records = await listByUser<EncryptedOutboxRecord>(
        database,
        OUTBOX_STORE,
        userId
      );
      return records.sort((left, right) => left.createdAt - right.createdAt);
    },
    async listContentTransfers(userId) {
      const records = await listByUser<EncryptedContentTransferRecord>(
        database,
        CONTENT_TRANSFER_STORE,
        userId
      );
      return records.sort((left, right) => left.createdAt - right.createdAt);
    },
    async listSearchIndex(userId) {
      const records = await listByUser<ProtectedSearchIndexRecord>(
        database,
        SEARCH_INDEX_STORE,
        userId
      );
      return records.sort(
        (left, right) =>
          left.noteId.localeCompare(right.noteId) ||
          left.sectionId.localeCompare(right.sectionId) ||
          left.keyEpoch - right.keyEpoch
      );
    },
    async preserveOutboxFence(fence, reason, rejectedAt) {
      const retained = await runTransaction(
        database,
        OUTBOX_STORE,
        "readwrite",
        async (transaction) => {
          const store = transaction.objectStore(OUTBOX_STORE);
          const records = await requestResult(
            store.getAll() as IDBRequest<EncryptedOutboxRecord[]>
          );
          const matching = records
            .filter((record) => matchesOutboxFence(record, fence))
            .map((record) => ({
              ...record,
              state: "terminal-rejected" as const,
              terminalReason: reason,
              terminalRejectedAt: record.terminalRejectedAt ?? rejectedAt,
              updatedAt: rejectedAt
            }));
          matching.forEach((record) => store.put(record));
          return matching;
        }
      );
      if (retained.length > 0) {
        notify({ store: "outbox", userId: fence.userId });
      }
      return retained;
    },
    async listSectionCache(userId) {
      const records = await listByUser<SectionCacheRecord>(
        database,
        SECTION_CACHE_STORE,
        userId
      );
      return records.sort(compareCacheRecords);
    },
    async putOutbox(record) {
      await putRecord(database, OUTBOX_STORE, record);
      notify({ store: "outbox", userId: record.userId });
    },
    async putContentTransfer(record) {
      await putRecord(database, CONTENT_TRANSFER_STORE, record);
      notify({ store: "content-transfers", userId: record.userId });
    },
    async putSearchIndexSection(record) {
      const stored = await runTransaction(
        database,
        SEARCH_INDEX_STORE,
        "readwrite",
        async (transaction) => {
          const store = transaction.objectStore(SEARCH_INDEX_STORE);
          const current = await requestResult(
            store.get(searchIndexKey(record)) as IDBRequest<
              ProtectedSearchIndexRecord | undefined
            >
          );
          if (current && current.indexedSequence > record.indexedSequence) {
            return false;
          }
          store.put(record);
          return true;
        }
      );
      if (stored) {
        notify({ store: "search-index", userId: record.userId });
      }
      return stored;
    },
    async putSectionCache(record) {
      await putRecord(database, SECTION_CACHE_STORE, record);
      notify({ store: "section-cache", userId: record.userId });
    },
    async readLease(scopeKey) {
      return getRecord<LeaseRecord>(database, LEASE_STORE, scopeKey);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function outboxIdentity(record: OutboxKey): OutboxKey {
  return {
    userId: record.userId,
    noteId: record.noteId,
    sectionId: record.sectionId,
    keyEpoch: record.keyEpoch,
    updateId: record.updateId
  };
}

function outboxKey(record: OutboxKey): IDBValidKey {
  return [
    record.userId,
    record.noteId,
    record.sectionId,
    record.keyEpoch,
    record.updateId
  ];
}

function matchesOutboxFence(
  record: Pick<EncryptedOutboxRecord, "userId" | "noteId" | "sectionId" | "keyEpoch">,
  fence: Pick<EncryptedOutboxRecord, "userId" | "noteId" | "sectionId" | "keyEpoch">
): boolean {
  return (
    record.userId === fence.userId &&
    record.noteId === fence.noteId &&
    record.sectionId === fence.sectionId &&
    record.keyEpoch === fence.keyEpoch
  );
}

function cacheKey(record: CacheKey): IDBValidKey {
  return [
    record.userId,
    record.noteId,
    record.sectionId,
    record.keyEpoch,
    record.manifestId
  ];
}

function searchIndexKey(record: SearchIndexKey): IDBValidKey {
  return [record.userId, record.noteId, record.sectionId, record.keyEpoch];
}

function compareCacheRecords(
  left: SectionCacheRecord,
  right: SectionCacheRecord
): number {
  return (
    left.lastAccessedAt - right.lastAccessedAt ||
    left.manifestId.localeCompare(right.manifestId)
  );
}

function accountFromScope(scopeKey: string): string {
  return scopeKey.split(":", 1)[0] ?? scopeKey;
}

function createBroadcastChannel(
  databaseName: string,
  factory?: (name: string) => BroadcastChannel
): BroadcastChannel | null {
  try {
    if (factory) {
      return factory(`${databaseName}:changes`);
    }
    return typeof globalThis.BroadcastChannel === "function"
      ? new globalThis.BroadcastChannel(`${databaseName}:changes`)
      : null;
  } catch {
    return null;
  }
}

function isIndexedDbChange(value: unknown): value is IndexedDbChange {
  return (
    typeof value === "object" &&
    value !== null &&
    "store" in value &&
    "userId" in value &&
    typeof value.userId === "string"
  );
}
