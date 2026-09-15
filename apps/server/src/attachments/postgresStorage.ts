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

    // Chunks are inserted as separate statements so no pooled connection is held
    // while waiting on the client. The object stays unreferenced until write()
    // resolves, and crashed uploads are removed by the orphan sweep.
    await this.database.insert(schema.attachmentObjects).values({
      storageKey: input.storageId,
      byteLength: input.expectedBytes
    });

    try {
      let byteLength = 0;
      let chunkIndex = 0;
      let bufferedBytes = 0;
      let bufferedParts: Buffer[] = [];
      const flushChunk = async () => {
        if (bufferedBytes === 0) {
          return;
        }
        await this.database.insert(schema.attachmentObjectChunks).values({
          storageKey: input.storageId,
          chunkIndex,
          ciphertext: Buffer.concat(bufferedParts, bufferedBytes)
        });
        bufferedBytes = 0;
        bufferedParts = [];
        chunkIndex += 1;
      };
      for await (const value of input.source) {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        byteLength += buffer.length;
        if (byteLength > input.maxBytes) {
          throw new AttachmentCiphertextSizeError("too-large");
        }
        let offset = 0;
        while (offset < buffer.length) {
          const available = DATABASE_CHUNK_BYTES - bufferedBytes;
          const length = Math.min(available, buffer.length - offset);
          bufferedParts.push(buffer.subarray(offset, offset + length));
          bufferedBytes += length;
          offset += length;
          if (bufferedBytes === DATABASE_CHUNK_BYTES) {
            await flushChunk();
          }
        }
      }

      if (byteLength !== input.expectedBytes) {
        throw new AttachmentCiphertextSizeError();
      }
      await flushChunk();
    } catch (error) {
      await this.delete(input.storageId).catch(() => undefined);
      throw error;
    }
  }

  async read(storageId: string): Promise<Readable> {
    validateStorageId(storageId);
    const objects = await this.database
      .select({
        byteLength: schema.attachmentObjects.byteLength,
        chunkCount: sql<number>`count(${schema.attachmentObjectChunks.chunkIndex})::integer`,
        lastChunkIndex: sql<number>`coalesce(max(${schema.attachmentObjectChunks.chunkIndex}), -1)::integer`,
        storedBytes: sql<string>`coalesce(sum(octet_length(${schema.attachmentObjectChunks.ciphertext})), 0)::bigint`
      })
      .from(schema.attachmentObjects)
      .leftJoin(
        schema.attachmentObjectChunks,
        eq(schema.attachmentObjectChunks.storageKey, schema.attachmentObjects.storageKey)
      )
      .where(eq(schema.attachmentObjects.storageKey, storageId))
      .groupBy(schema.attachmentObjects.storageKey, schema.attachmentObjects.byteLength);
    const object = objects[0];
    if (!object) {
      throw new Error("Attachment ciphertext not found");
    }
    if (
      Number(object.storedBytes) !== object.byteLength ||
      object.lastChunkIndex !== object.chunkCount - 1
    ) {
      throw new Error("Attachment ciphertext is incomplete");
    }
    return Readable.from(readChunks(this.database, storageId, object.chunkCount));
  }

  async delete(storageId: string): Promise<void> {
    validateStorageId(storageId);
    await this.database
      .delete(schema.attachmentObjects)
      .where(eq(schema.attachmentObjects.storageKey, storageId));
  }

  async removeOrphans(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS).toISOString();
    await this.database.delete(schema.attachmentObjects).where(
      and(
        lt(schema.attachmentObjects.createdAt, cutoff),
        notExists(
          this.database
            .select({ one: sql`1` })
            .from(schema.attachments)
            .where(eq(schema.attachments.storageKey, schema.attachmentObjects.storageKey))
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

async function* readChunks(
  database: PostgresDatabase,
  storageId: string,
  chunkCount: number
): AsyncGenerator<Buffer> {
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const rows = await database
      .select({ ciphertext: schema.attachmentObjectChunks.ciphertext })
      .from(schema.attachmentObjectChunks)
      .where(
        and(
          eq(schema.attachmentObjectChunks.storageKey, storageId),
          eq(schema.attachmentObjectChunks.chunkIndex, chunkIndex)
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new Error("Attachment ciphertext is incomplete");
    }
    yield row.ciphertext;
  }
}
