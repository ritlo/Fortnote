import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PostgresAttachmentStorage } from "@server/attachments/postgresStorage.js";
import * as schema from "@server/db/schema.js";

function recordingDatabase() {
  const insertedObjects: unknown[] = [];
  const insertedChunks: { chunkIndex: number; ciphertext: Buffer }[] = [];
  let deletes = 0;
  const database = {
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
    },
    delete() {
      return {
        where() {
          deletes += 1;
          return Promise.resolve();
        }
      };
    },
    transaction() {
      throw new Error("Attachment writes must not hold a transaction open");
    }
  };
  return {
    storage: new PostgresAttachmentStorage(database as never),
    insertedObjects,
    insertedChunks,
    deletes: () => deletes
  };
}

describe("PostgreSQL attachment storage", () => {
  it("writes large streams as ordered bounded chunks without a long transaction", async () => {
    const { storage, insertedObjects, insertedChunks, deletes } = recordingDatabase();
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
    expect(Buffer.concat(insertedChunks.map(({ ciphertext }) => ciphertext))).toEqual(
      bytes
    );
    expect(deletes()).toBe(0);
  });

  it("deletes the partial object when the stream fails validation", async () => {
    const { storage, deletes } = recordingDatabase();

    await expect(
      storage.write({
        storageId: crypto.randomUUID(),
        source: Readable.from([Buffer.alloc(16)]),
        expectedBytes: 8,
        maxBytes: 8
      })
    ).rejects.toThrow("Encrypted attachment exceeds maximum bytes");
    expect(deletes()).toBe(1);
  });
});
