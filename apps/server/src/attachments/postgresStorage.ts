import { and, eq, lt, notExists, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Readable } from "node:stream";
import type { AttachmentStorage, AttachmentWrite } from "./storage.js";
import {
  AttachmentCiphertextSizeError,
  validateAttachmentSize,
  validateStorageId
} from "./storage.js";
import * as schema from "../db/postgres/schema.js";

const DATABASE_CHUNK_BYTES = 256 * 1024;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

type PostgresDatabase = NodePgDatabase<typeof schema>;

export class PostgresAttachmentStorage implements AttachmentStorage {
  constructor(private readonly database: PostgresDatabase) {}

  async write(input: AttachmentWrite): Promise<void> {
    validateStorageId(input.storageId);
    validateAttachmentSize(input.expectedBytes, input.maxBytes);

    await this.database.transaction(async (transaction) => {
      await transaction.insert(schema.attachmentObjects).values({
        storageKey: input.storageId,
        byteLength: input.expectedBytes
      });

      let byteLength = 0;
      let chunkIndex = 0;
      for await (const value of input.source) {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        for (let offset = 0; offset < buffer.length; offset += DATABASE_CHUNK_BYTES) {
          const ciphertext = buffer.subarray(offset, offset + DATABASE_CHUNK_BYTES);
          byteLength += ciphertext.length;
          if (byteLength > input.maxBytes) {
            throw new AttachmentCiphertextSizeError("too-large");
          }
          await transaction.insert(schema.attachmentObjectChunks).values({
            storageKey: input.storageId,
            chunkIndex,
            ciphertext
          });
          chunkIndex += 1;
        }
      }

      if (byteLength !== input.expectedBytes) {
        throw new AttachmentCiphertextSizeError();
      }
    });
  }

  async read(storageId: string): Promise<Readable> {
    validateStorageId(storageId);
    const objects = await this.database
      .select({ byteLength: schema.attachmentObjects.byteLength })
      .from(schema.attachmentObjects)
      .where(eq(schema.attachmentObjects.storageKey, storageId))
      .limit(1);
    const object = objects[0];
    if (!object) {
      throw new Error("Attachment ciphertext not found");
    }

    const rows = await this.database
      .select({ ciphertext: schema.attachmentObjectChunks.ciphertext })
      .from(schema.attachmentObjectChunks)
      .where(eq(schema.attachmentObjectChunks.storageKey, storageId))
      .orderBy(schema.attachmentObjectChunks.chunkIndex);
    const actualBytes = rows.reduce(
      (total, row) => total + row.ciphertext.byteLength,
      0
    );
    if (actualBytes !== object.byteLength) {
      throw new Error("Attachment ciphertext is incomplete");
    }
    return Readable.from(rows.map((row) => row.ciphertext));
  }

  async delete(storageId: string): Promise<void> {
    validateStorageId(storageId);
    await this.database
      .delete(schema.attachmentObjects)
      .where(eq(schema.attachmentObjects.storageKey, storageId));
  }

  async removeOrphans(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS).toISOString();
    await this.database
      .delete(schema.attachmentObjects)
      .where(
        and(
          lt(schema.attachmentObjects.createdAt, cutoff),
          notExists(
            this.database
              .select({ one: sql`1` })
              .from(schema.attachments)
              .where(
                eq(
                  schema.attachments.storageKey,
                  schema.attachmentObjects.storageKey
                )
              )
          ),
          notExists(
            this.database
              .select({ one: sql`1` })
              .from(schema.contentChunks)
              .where(
                sql`${schema.contentChunks.storageKey} = ${schema.attachmentObjects.storageKey}::text`
              )
          )
        )
      );
  }
}
