import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig, type ServerConfig } from "../config.js";
import {
  ContentChunkConflictError,
  contentChunkPath,
  deleteUncommittedContentUpload,
  readEncryptedContentChunk,
  writeEncryptedContentChunk
} from "./storage.js";

const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("encrypted content chunk storage", () => {
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
});

function testConfig(): ServerConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fortnote-content-test-"));
  cleanupDirectories.push(dataDir);
  return { ...getConfig({}), dataDir, databasePath: ":memory:" };
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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
