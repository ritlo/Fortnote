import { IndexedDbOperationError, normalizeIndexedDbError } from "./contracts";

const DATABASE_VERSION = 3;

export const OUTBOX_STORE = "encryptedOutbox";
export const ACKNOWLEDGEMENT_STORE = "acknowledgements";
export const SECTION_CACHE_STORE = "sectionCache";
export const LEASE_STORE = "leases";
export const CONTENT_TRANSFER_STORE = "contentTransfers";
export const SEARCH_INDEX_STORE = "searchIndex";

const OUTBOX_KEY = ["userId", "noteId", "sectionId", "keyEpoch", "updateId"];
const CACHE_KEY = ["userId", "noteId", "sectionId", "keyEpoch", "manifestId"];
const CONTENT_TRANSFER_KEY = ["userId", "uploadId"];
const SEARCH_INDEX_KEY = ["userId", "noteId", "sectionId", "keyEpoch"];

export async function openDatabase(
  factory: IDBFactory,
  name: string
): Promise<IDBDatabase> {
  const request = factory.open(name, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    ensureStore(database, request.transaction, OUTBOX_STORE, OUTBOX_KEY);
    ensureStore(database, request.transaction, ACKNOWLEDGEMENT_STORE, OUTBOX_KEY);
    ensureStore(database, request.transaction, SECTION_CACHE_STORE, CACHE_KEY);
    ensureStore(database, request.transaction, LEASE_STORE, "scopeKey");
    ensureStore(
      database,
      request.transaction,
      CONTENT_TRANSFER_STORE,
      CONTENT_TRANSFER_KEY
    );
    ensureStore(database, request.transaction, SEARCH_INDEX_STORE, SEARCH_INDEX_KEY);
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

/**
 * Runs one IndexedDB transaction and settles only after it commits or aborts.
 * Any failure aborts the transaction, so requests queued before the failure are
 * never partially committed, and the abort is awaited so it cannot surface later
 * as an unhandled rejection.
 */
export async function runTransaction<T>(
  database: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => T | Promise<T>
): Promise<T> {
  return safeOperation(async () => {
    const transaction = database.transaction(storeNames, mode);
    const done = transactionDone(transaction);
    try {
      const result = await operation(transaction);
      await done;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have entered its terminal state.
      }
      await done.catch(() => undefined);
      throw error;
    }
  });
}

export function getRecord<T>(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey
): Promise<T | null> {
  return runTransaction(database, storeName, "readonly", async (transaction) => {
    const result = await requestResult(
      transaction.objectStore(storeName).get(key) as IDBRequest<T | undefined>
    );
    return result ?? null;
  });
}

export function listByUser<T>(
  database: IDBDatabase,
  storeName: string,
  userId: string
): Promise<T[]> {
  return runTransaction(database, storeName, "readonly", (transaction) =>
    requestResult(
      transaction.objectStore(storeName).index("byUserId").getAll(userId) as IDBRequest<
        T[]
      >
    )
  );
}

export async function putRecord(
  database: IDBDatabase,
  storeName: string,
  record: object
): Promise<void> {
  await runTransaction(database, storeName, "readwrite", (transaction) => {
    transaction.objectStore(storeName).put(record);
  });
}

export async function deleteRecord(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey
): Promise<void> {
  await runTransaction(database, storeName, "readwrite", (transaction) => {
    transaction.objectStore(storeName).delete(key);
  });
}

export function deleteIndexEntries(index: IDBIndex, key: IDBValidKey): void {
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

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(idbError(request.error));
    };
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
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

export function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
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

export function idbError(error: DOMException | null): Error {
  return error ?? new IndexedDbOperationError();
}

export async function safeOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeIndexedDbError(error);
  }
}
