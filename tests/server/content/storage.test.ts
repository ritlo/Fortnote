import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, type ServerConfig } from "@server/config.js";
import type { AppDb } from "@server/db/client.js";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../support/http.js";
import {
  ContentStorageScanner,
  expireContentUploadsPage,
  reconcileStorageAccountsPage,
  startContentMaintenance
} from "@server/content/maintenance.js";
import { contentManifestHash } from "@server/content/manifests.js";
import type { AttachmentStorage } from "@server/attachments/storage.js";
import {
  AttachmentBackedContentStorage,
  ContentChunkConflictError,
  contentChunkPath,
  deleteUncommittedContentUpload,
  readEncryptedContentChunk,
  writeEncryptedContentChunk
} from "@server/content/storage.js";

const cleanupDirectories: string[] = [];
const cleanupDbs: AppDb[] = [];
// These tests exercise local filesystem storage and SQLite internals directly.
const LOCAL_SQLITE = { provider: "sqlite", path: ":memory:" } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const db of cleanupDbs.splice(0)) {
    db.sqlite.close();
  }
  for (const directory of cleanupDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("encrypted content chunk storage", () => {
  it("stores content through a database- or object-backed attachment store", async () => {
    const objects = new Map<string, Buffer>();
    const objectStorage: AttachmentStorage = {
      async write(input) {
        const bytes = await streamBytes(input.source);
        if (bytes.length !== input.expectedBytes) {
          throw new Error("size mismatch");
        }
        objects.set(input.storageId, bytes);
      },
      read(storageId) {
        const bytes = objects.get(storageId);
        if (!bytes) {
          throw new Error("missing object");
        }
        return Promise.resolve(Readable.from(bytes));
      },
      delete(storageId) {
        objects.delete(storageId);
        return Promise.resolve();
      }
    };
    const storage = new AttachmentBackedContentStorage(objectStorage);
    const bytes = Buffer.from("database-backed encrypted content");
    const stored = await storage.write({
      uploadId: crypto.randomUUID(),
      chunkIndex: 0,
      expectedLength: bytes.length,
      expectedHash: digest(bytes),
      maxBytes: 1024,
      source: Readable.from(bytes)
    });

    expect(stored.fileCipherPath).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await streamBytes(await storage.read(stored.fileCipherPath))).toEqual(bytes);
    await storage.deleteUpload(crypto.randomUUID(), [stored.fileCipherPath]);
    expect(objects.size).toBe(0);

    await expect(
      storage.write({
        uploadId: crypto.randomUUID(),
        chunkIndex: 1,
        expectedLength: bytes.length,
        expectedHash: "0".repeat(64),
        maxBytes: 1024,
        source: Readable.from(bytes)
      })
    ).rejects.toThrow("hash mismatch");
    expect(objects.size).toBe(0);
  });

  it("streams, verifies, and atomically publishes a chunk", async () => {
    const config = testConfig();
    const uploadId = crypto.randomUUID();
    const bytes = Buffer.from("bounded encrypted content".repeat(1024));
    const stored = await writeEncryptedContentChunk(config, {
      uploadId,
      chunkIndex: 0,
      expectedLength: bytes.length,
      expectedHash: digest(bytes),
      maxBytes: config.contentChunkMaxBytes,
      source: Readable.from(chunk(bytes, 97))
    });

    expect(stored).toEqual({
      fileCipherPath: `content/${uploadId}/0.bin`,
      cipherLength: bytes.length,
      cipherHash: digest(bytes)
    });
    const read = await streamBytes(readEncryptedContentChunk(config, uploadId, 0));
    expect(read).toEqual(bytes);
    expect(await fsPromises.readdir(path.dirname(contentChunkPath(config, uploadId, 0)))).toEqual([
      "0.bin"
    ]);
  });

  it("removes temporary data when length, hash, or maximum checks fail", async () => {
    const config = testConfig();
    const bytes = Buffer.from("ciphertext");
    for (const input of [
      { expectedLength: bytes.length + 1, expectedHash: digest(bytes), maxBytes: 100 },
      { expectedLength: bytes.length, expectedHash: "0".repeat(64), maxBytes: 100 },
      { expectedLength: bytes.length, expectedHash: digest(bytes), maxBytes: bytes.length - 1 }
    ]) {
      const uploadId = crypto.randomUUID();
      await expect(
        writeEncryptedContentChunk(config, {
          uploadId,
          chunkIndex: 0,
          ...input,
          source: Readable.from(bytes)
        })
      ).rejects.toThrow();
      await expect(fsPromises.stat(contentChunkPath(config, uploadId, 0))).rejects.toThrow();
    }
  });

  it("removes partial data when the incoming stream is interrupted", async () => {
    const config = testConfig();
    const uploadId = crypto.randomUUID();
    const bytes = Buffer.from("first partial ciphertext");
    const interrupted = Readable.from(
      (async function* () {
        await Promise.resolve();
        yield bytes;
        throw new Error("connection interrupted");
      })()
    );

    await expect(
      writeEncryptedContentChunk(config, {
        uploadId,
        chunkIndex: 0,
        expectedLength: bytes.length * 2,
        expectedHash: digest(Buffer.concat([bytes, bytes])),
        maxBytes: 1024,
        source: interrupted
      })
    ).rejects.toThrow("connection interrupted");
    await expect(fsPromises.stat(contentChunkPath(config, uploadId, 0))).rejects.toThrow();
    const uploadDirectory = path.dirname(contentChunkPath(config, uploadId, 0));
    expect(await fsPromises.readdir(uploadDirectory)).toEqual([]);
  });

  it("deduplicates identical retries and rejects conflicting duplicates", async () => {
    const config = testConfig();
    const uploadId = crypto.randomUUID();
    const original = Buffer.from("original encrypted chunk");
    const write = (bytes: Buffer) =>
      writeEncryptedContentChunk(config, {
        uploadId,
        chunkIndex: 3,
        expectedLength: bytes.length,
        expectedHash: digest(bytes),
        maxBytes: 1024,
        source: Readable.from(bytes)
      });

    const first = await write(original);
    expect(await write(original)).toEqual(first);
    await expect(write(Buffer.from("conflicting encrypted chunk"))).rejects.toBeInstanceOf(
      ContentChunkConflictError
    );
    expect(await streamBytes(readEncryptedContentChunk(config, uploadId, 3))).toEqual(original);
  });

  it("rejects traversal-like identifiers and unsafe indexes", () => {
    const config = testConfig();
    for (const uploadId of ["../escape", "upload", crypto.randomUUID().toUpperCase()]) {
      expect(() => contentChunkPath(config, uploadId, 0)).toThrow("storage identity");
    }
    for (const index of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => contentChunkPath(config, crypto.randomUUID(), index)).toThrow("chunk index");
    }
  });

  it("cleans only the validated uncommitted upload scope", async () => {
    const config = testConfig();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const bytes = Buffer.from("cipher");
    for (const uploadId of [firstId, secondId]) {
      await writeEncryptedContentChunk(config, {
        uploadId,
        chunkIndex: 0,
        expectedLength: bytes.length,
        expectedHash: digest(bytes),
        maxBytes: 1024,
        source: Readable.from(bytes)
      });
    }

    await deleteUncommittedContentUpload(config, firstId);

    await expect(fsPromises.stat(contentChunkPath(config, firstId, 0))).rejects.toThrow();
    expect(await streamBytes(readEncryptedContentChunk(config, secondId, 0))).toEqual(bytes);
  });

  it("expires uploads and cleans orphans in bounded pages without touching committed files", async () => {
    const app = await createTestApp({ maintenanceBatchSize: 2, database: LOCAL_SQLITE });
    const config = app.locals.config as ServerConfig;
    const db = app.locals.db as AppDb;
    const context = { config, db };
    cleanupDirectories.push(config.dataDir);
    cleanupDbs.push(db);
    const agent = await registerAgent(app, "maintenance-owner");
    const note = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(note.body.id);
    const active = [];
    for (const value of ["expiring one", "expiring two", "expiring three"]) {
      active.push(await uploadRouteChunk(agent, noteId, value));
    }
    const committed = await uploadRouteChunk(agent, noteId, "durable committed", true);
    db.sqlite
      .prepare(`
        UPDATE content_uploads SET expires_at = '2000-01-01T00:00:00.000Z'
      `)
      .run();

    const firstPage = await expireContentUploadsPage(context);
    expect(firstPage).toEqual({ processed: 2, hasMore: true });
    const statusesAfterFirst = active.map(({ uploadId }) => uploadStatus(db, uploadId));
    expect(statusesAfterFirst.filter((status) => status === "expired")).toHaveLength(2);
    const secondPage = await expireContentUploadsPage(context);
    expect(secondPage).toEqual({ processed: 1, hasMore: false });
    expect(active.map(({ uploadId }) => uploadStatus(db, uploadId))).toEqual([
      "expired",
      "expired",
      "expired"
    ]);
    for (const { uploadId } of active) {
      expect(fs.existsSync(path.join(config.dataDir, "content", uploadId))).toBe(false);
    }
    expect(fs.existsSync(contentChunkPath(config, committed.uploadId, 0))).toBe(true);

    const orphanIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const uploadId of orphanIds) {
      await writeEncryptedContentChunk(config, {
        uploadId,
        chunkIndex: 0,
        expectedLength: 6,
        expectedHash: digest(Buffer.from("orphan")),
        maxBytes: 1024,
        source: Readable.from(Buffer.from("orphan"))
      });
    }
    const scanner = new ContentStorageScanner(context);
    const pages = [];
    for (;;) {
      const page = await scanner.nextPage();
      pages.push(page);
      expect(page.scanned).toBeLessThanOrEqual(config.maintenanceBatchSize);
      if (page.done) {
        break;
      }
    }
    expect(pages.length).toBeGreaterThan(1);
    for (const uploadId of orphanIds) {
      expect(fs.existsSync(path.join(config.dataDir, "content", uploadId))).toBe(false);
    }
    expect(fs.existsSync(contentChunkPath(config, committed.uploadId, 0))).toBe(true);
    expect(
      db.sqlite
        .prepare("SELECT reserved_bytes AS bytes FROM storage_accounts")
        .get()
    ).toEqual({ bytes: 0 });
  });

  it("reconciles committed and reserved counters in bounded user pages", async () => {
    const app = await createTestApp({ maintenanceBatchSize: 2, database: LOCAL_SQLITE });
    const config = app.locals.config as ServerConfig;
    const db = app.locals.db as AppDb;
    cleanupDirectories.push(config.dataDir);
    cleanupDbs.push(db);
    for (const username of ["quota-one", "quota-two", "quota-three"]) {
      const agent = await registerAgent(app, username);
      await agent
        .post("/api/notes")
        .set(csrfHeaders())
        .send(notePayload())
        .expect(201);
    }
    db.sqlite
      .prepare(`
        INSERT INTO storage_accounts (user_id, used_bytes, reserved_bytes)
        SELECT id, 999, 999 FROM users
      `)
      .run();

    const context = { config, db };
    const first = await reconcileStorageAccountsPage(context);
    expect(first.processed).toBe(2);
    expect(first.hasMore).toBe(true);
    const second = await reconcileStorageAccountsPage(context, first.nextUserId);
    expect(second).toMatchObject({ processed: 1, hasMore: false });
    expect(
      db.sqlite
        .prepare(`
          SELECT used_bytes AS usedBytes, reserved_bytes AS reservedBytes
          FROM storage_accounts ORDER BY user_id
        `)
        .all()
    ).toEqual([
      { usedBytes: 0, reservedBytes: 0 },
      { usedBytes: 0, reservedBytes: 0 },
      { usedBytes: 0, reservedBytes: 0 }
    ]);
  });

  it("waits for active background maintenance before stopping", async () => {
    vi.useFakeTimers();
    const app = await createTestApp({ contentUploadExpiryMs: 1_000, database: LOCAL_SQLITE });
    const config = app.locals.config as ServerConfig;
    const db = app.locals.db as AppDb;
    const context = { config, db };
    cleanupDirectories.push(config.dataDir);
    cleanupDbs.push(db);
    const started = deferredSignal();
    const release = deferredSignal();
    vi.spyOn(db.contentMaintenance, "expireUploads").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return { uploads: [], hasMore: false };
    });
    const maintenance = startContentMaintenance(context);

    await vi.advanceTimersByTimeAsync(1_000);
    await started.promise;
    const stopping = maintenance.stop();
    const stopState = Promise.race([
      stopping.then(() => "stopped" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => {
          resolve("pending");
        }, 100);
      })
    ]);
    await vi.advanceTimersByTimeAsync(100);
    const stateBeforeRelease = await stopState;

    release.resolve();
    await stopping;
    expect(stateBeforeRelease).toBe("pending");
  });
});

function testConfig(): ServerConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fortnote-content-test-"));
  cleanupDirectories.push(dataDir);
  return {
    ...getConfig({}),
    dataDir,
    database: { provider: "sqlite", path: ":memory:" }
  };
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deferredSignal() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function chunk(bytes: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
  }
  return chunks;
}

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const value of stream) {
    chunks.push(Buffer.from(value as Uint8Array));
  }
  return Buffer.concat(chunks);
}

async function uploadRouteChunk(
  agent: Awaited<ReturnType<typeof registerAgent>>,
  noteId: string,
  value: string,
  commit = false
): Promise<{ uploadId: string }> {
  const bytes = Buffer.from(value);
  const nonce = Buffer.alloc(24, value.length % 251);
  const uploadId = crypto.randomUUID();
  const updateId = crypto.randomUUID();
  const cipherHash = digest(bytes);
  const manifestHash = contentManifestHash([
    { chunkIndex: 0, cipherLength: bytes.length, cipherHash, nonce }
  ]);
  await agent
    .post("/api/content/uploads")
    .set(csrfHeaders())
    .send({
      uploadId,
      updateId,
      noteId,
      sectionId: "root",
      expectedKeyEpoch: 1,
      kind: "update",
      formatVersion: 2,
      totalCipherBytes: bytes.length,
      chunkCount: 1,
      manifestHash
    })
    .expect(201);
  await agent
    .put(`/api/content/uploads/${uploadId}/chunks/0`)
    .set(csrfHeaders())
    .set("content-type", "application/octet-stream")
    .set("content-length", String(bytes.length))
    .set("x-fortnote-cipher-hash", cipherHash)
    .set("x-fortnote-nonce", nonce.toString("base64"))
    .send(bytes)
    .expect(204);
  if (commit) {
    await agent
      .post(`/api/content/uploads/${uploadId}/commit`)
      .set(csrfHeaders())
      .send({ requestId: crypto.randomUUID(), updateId, expectedKeyEpoch: 1 })
      .expect(201);
  }
  return { uploadId };
}

function uploadStatus(db: AppDb, uploadId: string): string {
  return (
    db.sqlite
      .prepare("SELECT status FROM content_uploads WHERE id = ?")
      .get(uploadId) as { status: string }
  ).status;
}
