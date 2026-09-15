import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentStorage } from "@server/attachments/storage.js";
import type { ServerConfig } from "@server/config.js";
import { startContentMaintenance } from "@server/content/maintenance.js";
import { AttachmentBackedContentStorage } from "@server/content/storage.js";
import type { ApplicationDatabase } from "@server/db/types.js";
import { createTestApp } from "../support/http.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("encrypted content chunk storage", () => {
  it("stores content chunks as attachment objects and rejects hash mismatches", async () => {
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

  it("waits for active background maintenance before stopping", async () => {
    const app = await createTestApp({ contentUploadExpiryMs: 1_000 });
    const config = app.locals.config as ServerConfig;
    const db = app.locals.db as ApplicationDatabase;
    const started = deferredSignal();
    const release = deferredSignal();
    vi.spyOn(db.contentMaintenance, "expireUploads").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return { uploads: [], hasMore: false };
    });
    vi.useFakeTimers();
    const maintenance = startContentMaintenance({ config, db });

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
    // Real timers let the test database pool close cleanly afterwards.
    vi.useRealTimers();
    expect(stateBeforeRelease).toBe("pending");
  });
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const value of stream) {
    chunks.push(Buffer.from(value as Uint8Array));
  }
  return Buffer.concat(chunks);
}
