const DATABASE_VERSION = 1;

const OUTBOX_STORE = "encryptedOutbox";
const ACKNOWLEDGEMENT_STORE = "acknowledgements";
const SECTION_CACHE_STORE = "sectionCache";
const LEASE_STORE = "leases";

const OUTBOX_KEY = ["userId", "noteId", "sectionId", "keyEpoch", "updateId"];
const CACHE_KEY = ["userId", "noteId", "sectionId", "keyEpoch", "manifestId"];

export interface EncryptedOutboxRecord {
  userId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  kind: "update" | "checkpoint" | "chunk";
  formatVersion: number;
  inlineCipher: Uint8Array;
  nonce: Uint8Array;
  state: "queued" | "sending";
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface AcknowledgementRecord {
  userId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  serverSequence: number;
  acknowledgedAt: number;
}

export interface SectionCacheRecord {
  userId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  manifestId: string;
  encryptedBytes: Uint8Array;
  lastAccessedAt: number;
  pending: boolean;
}

export interface LeaseRecord {
  scopeKey: string;
  userId: string;
  ownerId: string;
  expiresAt: number;
}

export interface IndexedDbChange {
  store: "outbox" | "acknowledgements" | "section-cache" | "leases";
  userId: string;
}

type OutboxKey = Pick<
  EncryptedOutboxRecord,
  "userId" | "noteId" | "sectionId" | "keyEpoch" | "updateId"
>;
type CacheKey = Pick<
  SectionCacheRecord,
  "userId" | "noteId" | "sectionId" | "keyEpoch" | "manifestId"
>;

export class IndexedDbCapacityError extends Error {
  constructor() {
    super("Protected browser storage is full");
    this.name = "IndexedDbCapacityError";
  }
}

export class IndexedDbOperationError extends Error {
  constructor() {
    super("Protected browser storage operation failed");
    this.name = "IndexedDbOperationError";
  }
}

export function normalizeIndexedDbError(error: unknown): Error {
  if (error instanceof IndexedDbCapacityError || error instanceof IndexedDbOperationError) {
    return error;
  }
  if (isNamedError(error, "QuotaExceededError")) {
    return new IndexedDbCapacityError();
  }
  return new IndexedDbOperationError();
}

export interface OpenFortnoteIndexedDbOptions {
  factory?: IDBFactory;
  name?: string;
  broadcastChannelFactory?: (name: string) => BroadcastChannel;
}

export interface FortnoteIndexedDb {
  readonly name: string;
  acknowledgeOutbox(record: OutboxKey, serverSequence: number): Promise<void>;
  acquireLease(
    scopeKey: string,
    ownerId: string,
    now: number,
    durationMs: number
  ): Promise<boolean>;
  clearAccount(userId: string): Promise<void>;
  close(): void;
  deleteDatabase(): Promise<void>;
  evictSectionCache(userId: string, maxEntries: number): Promise<string[]>;
  getAcknowledgement(record: OutboxKey): Promise<AcknowledgementRecord | null>;
  getOutbox(record: OutboxKey): Promise<EncryptedOutboxRecord | null>;
  listOutbox(userId: string): Promise<EncryptedOutboxRecord[]>;
  listSectionCache(userId: string): Promise<SectionCacheRecord[]>;
  putOutbox(record: EncryptedOutboxRecord): Promise<void>;
  putSectionCache(record: SectionCacheRecord): Promise<void>;
  readLease(scopeKey: string): Promise<LeaseRecord | null>;
  subscribe(listener: (change: IndexedDbChange) => void): () => void;
}

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
      await safeOperation(async () => {
        const transaction = database.transaction(
          [OUTBOX_STORE, ACKNOWLEDGEMENT_STORE],
          "readwrite"
        );
        const done = transactionDone(transaction);
        transaction.objectStore(ACKNOWLEDGEMENT_STORE).put({
          ...outboxIdentity(record),
          serverSequence,
          acknowledgedAt: Date.now()
        } satisfies AcknowledgementRecord);
        transaction.objectStore(OUTBOX_STORE).delete(outboxKey(record));
        await done;
      });
      notify({ store: "acknowledgements", userId: record.userId });
    },
    async acquireLease(scopeKey, ownerId, now, durationMs) {
      const acquired = await safeOperation(async () => {
        const transaction = database.transaction(LEASE_STORE, "readwrite");
        const done = transactionDone(transaction);
        const store = transaction.objectStore(LEASE_STORE);
        const current = await requestResult(
          store.get(scopeKey) as IDBRequest<LeaseRecord | undefined>
        );
        if (current && current.ownerId !== ownerId && current.expiresAt > now) {
          await done;
          return false;
        }
        store.put({
          scopeKey,
          userId: accountFromScope(scopeKey),
          ownerId,
          expiresAt: now + durationMs
        } satisfies LeaseRecord);
        await done;
        return true;
      });
      if (acquired) {
        notify({ store: "leases", userId: accountFromScope(scopeKey) });
      }
      return acquired;
    },
    async clearAccount(userId) {
      await safeOperation(async () => {
        const transaction = database.transaction(
          [OUTBOX_STORE, ACKNOWLEDGEMENT_STORE, SECTION_CACHE_STORE, LEASE_STORE],
          "readwrite"
        );
        const done = transactionDone(transaction);
        for (const storeName of [
          OUTBOX_STORE,
          ACKNOWLEDGEMENT_STORE,
          SECTION_CACHE_STORE,
          LEASE_STORE
        ]) {
          deleteIndexEntries(transaction.objectStore(storeName).index("byUserId"), userId);
        }
        await done;
      });
      notify({ store: "outbox", userId });
      notify({ store: "section-cache", userId });
    },
    close,
    async deleteDatabase() {
      close();
      await safeOperation(() => deleteDatabase(factory, name));
    },
    async evictSectionCache(userId, maxEntries) {
      if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
        throw new IndexedDbOperationError();
      }
      const records = await this.listSectionCache(userId);
      const removable = records
        .filter((record) => !record.pending)
        .sort(compareCacheRecords);
      const removeCount = Math.min(Math.max(records.length - maxEntries, 0), removable.length);
      const selected = removable.slice(0, removeCount);
      if (selected.length === 0) {
        return [];
      }
      await safeOperation(async () => {
        const transaction = database.transaction(SECTION_CACHE_STORE, "readwrite");
        const done = transactionDone(transaction);
        const store = transaction.objectStore(SECTION_CACHE_STORE);
        selected.forEach((record) => {
          store.delete(cacheKey(record));
        });
        await done;
      });
      notify({ store: "section-cache", userId });
      return selected.map((record) => record.manifestId);
    },
    async getAcknowledgement(record) {
      return getRecord<AcknowledgementRecord>(
        database,
        ACKNOWLEDGEMENT_STORE,
        outboxKey(record)
      );
    },
    async getOutbox(record) {
      return getRecord<EncryptedOutboxRecord>(database, OUTBOX_STORE, outboxKey(record));
    },
    async listOutbox(userId) {
      const records = await listByUser<EncryptedOutboxRecord>(database, OUTBOX_STORE, userId);
      return records.sort((left, right) => left.createdAt - right.createdAt);
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

async function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const request = factory.open(name, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    ensureStore(database, request.transaction, OUTBOX_STORE, OUTBOX_KEY);
    ensureStore(database, request.transaction, ACKNOWLEDGEMENT_STORE, OUTBOX_KEY);
    ensureStore(database, request.transaction, SECTION_CACHE_STORE, CACHE_KEY);
    ensureStore(database, request.transaction, LEASE_STORE, "scopeKey");
  };
  return requestResult(request);
}

function ensureStore(
  database: IDBDatabase,
  transaction: IDBTransaction | null,
  name: string,
  keyPath: string | string[]
): void {
  const store = database.objectStoreNames.contains(name)
    ? transaction?.objectStore(name)
    : database.createObjectStore(name, { keyPath });
  if (store && !store.indexNames.contains("byUserId")) {
    store.createIndex("byUserId", "userId", { unique: false });
  }
}

async function getRecord<T>(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey
): Promise<T | null> {
  return safeOperation(async () => {
    const transaction = database.transaction(storeName, "readonly");
    const result = await requestResult(
      transaction.objectStore(storeName).get(key) as IDBRequest<T | undefined>
    );
    await transactionDone(transaction);
    return result ?? null;
  });
}

async function listByUser<T>(
  database: IDBDatabase,
  storeName: string,
  userId: string
): Promise<T[]> {
  return safeOperation(async () => {
    const transaction = database.transaction(storeName, "readonly");
    const result = await requestResult(
      transaction.objectStore(storeName).index("byUserId").getAll(userId) as IDBRequest<T[]>
    );
    await transactionDone(transaction);
    return result;
  });
}

async function putRecord(
  database: IDBDatabase,
  storeName: string,
  record: object
): Promise<void> {
  await safeOperation(async () => {
    const transaction = database.transaction(storeName, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(storeName).put(record);
    await done;
  });
}

function deleteIndexEntries(index: IDBIndex, key: IDBValidKey): void {
  const request = index.openCursor(key);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      return;
    }
    cursor.delete();
    cursor.continue();
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(idbError(request.error));
    };
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(idbError(transaction.error));
    };
    transaction.onerror = () => {
      reject(idbError(transaction.error));
    };
  });
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(idbError(request.error));
    };
    request.onblocked = () => {
      resolve();
    };
  });
}

function idbError(error: DOMException | null): Error {
  return error ?? new IndexedDbOperationError();
}

async function safeOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeIndexedDbError(error);
  }
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
  return [record.userId, record.noteId, record.sectionId, record.keyEpoch, record.updateId];
}

function cacheKey(record: CacheKey): IDBValidKey {
  return [record.userId, record.noteId, record.sectionId, record.keyEpoch, record.manifestId];
}

function compareCacheRecords(left: SectionCacheRecord, right: SectionCacheRecord): number {
  return left.lastAccessedAt - right.lastAccessedAt ||
    left.manifestId.localeCompare(right.manifestId);
}

function accountFromScope(scopeKey: string): string {
  return scopeKey.split(":", 1)[0] ?? scopeKey;
}

function isNamedError(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
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
