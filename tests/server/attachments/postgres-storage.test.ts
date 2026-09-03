import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PostgresAttachmentStorage } from "@server/attachments/postgresStorage.js";
import * as schema from "@server/db/postgres/schema.js";

describe("PostgreSQL attachment storage", () => {
  it("writes large streams as ordered bounded chunks in one transaction", async () => {
    const insertedObjects: unknown[] = [];
    const insertedChunks: { chunkIndex: number; ciphertext: Buffer }[] = [];
    const transaction = {
      insert(table: unknown) {
        return {
          values(value: { chunkIndex?: number; ciphertext?: Buffer }) {
            if (table === schema.attachmentObjects) {
              insertedObjects.push(value);
            } else if (
              table === schema.attachmentObjectChunks &&
              value.chunkIndex !== undefined &&
              value.ciphertext
            ) {
              insertedChunks.push({
                chunkIndex: value.chunkIndex,
                ciphertext: value.ciphertext
              });
            }
            return Promise.resolve();
          }
        };
      }
    };
    const database = {
      async transaction<T>(callback: (tx: typeof transaction) => Promise<T>) {
        return callback(transaction);
      }
    };
    const storage = new PostgresAttachmentStorage(database as never);
    const storageId = crypto.randomUUID();
    const bytes = Buffer.alloc(600 * 1024, 0x5a);

    await storage.write({
      storageId,
      source: Readable.from([bytes.subarray(0, 300_000), bytes.subarray(300_000)]),
      expectedBytes: bytes.length,
      maxBytes: bytes.length
    });

    expect(insertedObjects).toEqual([
      { storageKey: storageId, byteLength: bytes.length }
    ]);
    expect(insertedChunks.map(({ chunkIndex }) => chunkIndex)).toEqual([0, 1, 2]);
    expect(insertedChunks.map(({ ciphertext }) => ciphertext.length)).toEqual([
      256 * 1024,
      256 * 1024,
      88 * 1024
    ]);
    expect(Buffer.concat(insertedChunks.map(({ ciphertext }) => ciphertext))).toEqual(bytes);
    expect(Math.max(...insertedChunks.map(({ ciphertext }) => ciphertext.length))).toBe(
      256 * 1024
    );
  });
});
