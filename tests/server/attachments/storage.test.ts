import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttachmentCiphertextSizeError,
  LocalAttachmentStorage
} from "@server/attachments/storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
});

describe("local attachment storage", () => {
  it("streams, reads, and idempotently deletes encrypted bytes", async () => {
    const directory = await temporaryDirectory();
    const storage = new LocalAttachmentStorage(directory);
    const storageId = crypto.randomUUID();
    const bytes = Buffer.from("encrypted attachment bytes".repeat(128));

    await storage.write({
      storageId,
      source: Readable.from([bytes.subarray(0, 37), bytes.subarray(37)]),
      expectedBytes: bytes.length,
      maxBytes: bytes.length
    });

    expect(await streamBytes(await storage.read(storageId))).toEqual(bytes);
    await storage.delete(storageId);
    await storage.delete(storageId);
    expect(fs.existsSync(path.join(directory, storageId))).toBe(false);
  });

  it("removes partial files when size validation fails", async () => {
    const directory = await temporaryDirectory();
    const storage = new LocalAttachmentStorage(directory);
    const storageId = crypto.randomUUID();
    const bytes = Buffer.from("ciphertext");

    await expect(
      storage.write({
        storageId,
        source: Readable.from(bytes),
        expectedBytes: bytes.length + 1,
        maxBytes: 1024
      })
    ).rejects.toBeInstanceOf(AttachmentCiphertextSizeError);
    expect(await fsPromises.readdir(directory)).toEqual([]);
  });

  it("preserves referenced and recent files while removing stale orphans", async () => {
    const directory = await temporaryDirectory();
    const storage = new LocalAttachmentStorage(directory);
    const recentId = crypto.randomUUID();
    const referencedId = crypto.randomUUID();
    const orphanId = crypto.randomUUID();
    for (const storageId of [recentId, referencedId, orphanId]) {
      await fsPromises.writeFile(path.join(directory, storageId), Buffer.from("encrypted bytes"));
    }
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fsPromises.utimes(path.join(directory, referencedId), stale, stale);
    await fsPromises.utimes(path.join(directory, orphanId), stale, stale);

    storage.removeOrphans(new Set([referencedId]));

    expect(fs.existsSync(path.join(directory, recentId))).toBe(true);
    expect(fs.existsSync(path.join(directory, referencedId))).toBe(true);
    expect(fs.existsSync(path.join(directory, orphanId))).toBe(false);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "fortnote-attachments-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const value of stream) {
    chunks.push(Buffer.from(value as Uint8Array));
  }
  return Buffer.concat(chunks);
}
