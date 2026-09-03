import { and, eq, gt, inArray, lt, lte, notExists, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import type {
  ContentMaintenanceRepository,
  ExpiredContentUpload,
  ExpiredContentUploadPage,
  StorageAccountReconciliationPage,
  StorageObjectCleanupPage
} from "./maintenanceRepository.js";

const RESERVED_UPLOAD_STATUSES = ["receiving", "complete", "invalid"];
const REMOVABLE_UPLOAD_STATUSES = new Set(["aborted", "expired", "invalid"]);

type PostgresDatabase = NodePgDatabase<typeof schema>;

export class PostgresContentMaintenanceRepository
  implements ContentMaintenanceRepository
{
  constructor(private readonly orm: PostgresDatabase) {}

  expireUploads(cutoff: string, limit: number): Promise<ExpiredContentUploadPage> {
    return this.orm.transaction(async (transaction) => {
      const candidates = await transaction
        .select({
          uploadId: schema.contentUploads.id,
          ownerUserId: schema.notes.userId,
          totalCipherBytes: schema.contentUploads.totalCipherBytes
        })
        .from(schema.contentUploads)
        .innerJoin(schema.notes, eq(schema.notes.id, schema.contentUploads.noteId))
        .where(and(
          inArray(schema.contentUploads.status, RESERVED_UPLOAD_STATUSES),
          lte(schema.contentUploads.expiresAt, cutoff)
        ))
        .orderBy(schema.contentUploads.expiresAt, schema.contentUploads.id)
        .limit(limit)
        .for("update", { of: schema.contentUploads, skipLocked: true });
      const uploads: ExpiredContentUpload[] = [];

      for (const candidate of candidates) {
        const claimed = await transaction
          .update(schema.contentUploads)
          .set({ status: "expired", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(and(
            eq(schema.contentUploads.id, candidate.uploadId),
            inArray(schema.contentUploads.status, RESERVED_UPLOAD_STATUSES),
            lte(schema.contentUploads.expiresAt, cutoff)
          ))
          .returning({ id: schema.contentUploads.id });
        if (claimed.length !== 1) {
          continue;
        }
        const chunks = await transaction
          .select({ storageKey: schema.contentChunks.storageKey })
          .from(schema.contentChunks)
          .where(eq(schema.contentChunks.uploadId, candidate.uploadId));
        await transaction
          .delete(schema.contentChunks)
          .where(eq(schema.contentChunks.uploadId, candidate.uploadId));
        await transaction
          .update(schema.storageAccounts)
          .set({
            reservedBytes: sql`GREATEST(${schema.storageAccounts.reservedBytes} - ${candidate.totalCipherBytes}, 0)`,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(eq(schema.storageAccounts.userId, candidate.ownerUserId));
        uploads.push({
          uploadId: candidate.uploadId,
          storageKeys: chunks.map(({ storageKey }) => storageKey)
        });
      }

      const remaining = await transaction
        .select({ id: schema.contentUploads.id })
        .from(schema.contentUploads)
        .where(and(
          inArray(schema.contentUploads.status, RESERVED_UPLOAD_STATUSES),
          lte(schema.contentUploads.expiresAt, cutoff)
        ))
        .limit(1);
      return { uploads, hasMore: remaining.length > 0 };
    });
  }

  async canRemoveUpload(uploadId: string): Promise<boolean> {
    const uploads = await this.orm
      .select({ status: schema.contentUploads.status })
      .from(schema.contentUploads)
      .where(eq(schema.contentUploads.id, uploadId))
      .limit(1);
    const upload = uploads[0];
    if (!upload) {
      return true;
    }
    if (upload.status === "committed") {
      return false;
    }
    const manifests = await this.orm
      .select({ id: schema.contentManifests.id })
      .from(schema.contentManifests)
      .where(eq(schema.contentManifests.uploadId, uploadId))
      .limit(1);
    return manifests.length === 0 && REMOVABLE_UPLOAD_STATUSES.has(upload.status);
  }

  removeOrphanObjects(
    cutoff: string,
    limit: number
  ): Promise<StorageObjectCleanupPage> {
    return this.orm.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ storageKey: schema.attachmentObjects.storageKey })
        .from(schema.attachmentObjects)
        .where(and(
          lt(schema.attachmentObjects.createdAt, cutoff),
          notExists(
            transaction
              .select({ one: sql`1` })
              .from(schema.attachments)
              .where(eq(schema.attachments.storageKey, schema.attachmentObjects.storageKey))
          ),
          notExists(
            transaction
              .select({ one: sql`1` })
              .from(schema.contentChunks)
              .where(
                sql`${schema.contentChunks.storageKey} = ${schema.attachmentObjects.storageKey}::text`
              )
          )
        ))
        .orderBy(schema.attachmentObjects.createdAt, schema.attachmentObjects.storageKey)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (candidates.length === 0) {
        return { scanned: 0, removed: 0, done: true };
      }
      const removed = await transaction
        .delete(schema.attachmentObjects)
        .where(inArray(
          schema.attachmentObjects.storageKey,
          candidates.map(({ storageKey }) => storageKey)
        ))
        .returning({ storageKey: schema.attachmentObjects.storageKey });
      return {
        scanned: candidates.length,
        removed: removed.length,
        done: candidates.length < limit
      };
    });
  }

  async reconcileStorageAccounts(
    afterUserId: string | null,
    limit: number
  ): Promise<StorageAccountReconciliationPage> {
    const userIds = await listUserIds(this.orm, afterUserId, limit);
    for (const userId of userIds.slice(0, limit)) {
      await this.orm.transaction(async (transaction) => {
        await transaction
          .insert(schema.storageAccounts)
          .values({ userId })
          .onConflictDoNothing();
        await transaction
          .select({ userId: schema.storageAccounts.userId })
          .from(schema.storageAccounts)
          .where(eq(schema.storageAccounts.userId, userId))
          .limit(1)
          .for("update");
        await reconcileStorageAccount(transaction, userId);
      });
    }
    const processed = Math.min(userIds.length, limit);
    return {
      processed,
      hasMore: userIds.length > limit,
      nextUserId: processed > 0 ? userIds[processed - 1]! : null
    };
  }
}

async function listUserIds(
  database: PostgresDatabase,
  afterUserId: string | null,
  limit: number
): Promise<string[]> {
  const storageQuery = database
    .select({ userId: schema.storageAccounts.userId })
    .from(schema.storageAccounts)
    .orderBy(schema.storageAccounts.userId)
    .limit(limit + 1);
  const noteQuery = database
    .select({ userId: schema.notes.userId })
    .from(schema.notes)
    .groupBy(schema.notes.userId)
    .orderBy(schema.notes.userId)
    .limit(limit + 1);
  const [storageRows, noteRows] = await Promise.all([
    afterUserId
      ? storageQuery.where(gt(schema.storageAccounts.userId, afterUserId))
      : storageQuery,
    afterUserId ? noteQuery.where(gt(schema.notes.userId, afterUserId)) : noteQuery
  ]);
  return [...new Set([...storageRows, ...noteRows].map(({ userId }) => userId))]
    .sort()
    .slice(0, limit + 1);
}

async function reconcileStorageAccount(
  database: PostgresDatabase,
  userId: string
): Promise<void> {
  const contentRows = await database
    .select({ bytes: sql<number>`COALESCE(SUM(${schema.contentManifests.totalCipherBytes}), 0)` })
    .from(schema.contentManifests)
    .innerJoin(schema.notes, eq(schema.notes.id, schema.contentManifests.noteId))
    .where(eq(schema.notes.userId, userId));
  const attachmentRows = await database
    .select({ bytes: sql<number>`COALESCE(SUM(${schema.attachments.size}), 0)` })
    .from(schema.attachments)
    .innerJoin(schema.notes, eq(schema.notes.id, schema.attachments.noteId))
    .where(eq(schema.notes.userId, userId));
  const reservedRows = await database
    .select({ bytes: sql<number>`COALESCE(SUM(${schema.contentUploads.totalCipherBytes}), 0)` })
    .from(schema.contentUploads)
    .innerJoin(schema.notes, eq(schema.notes.id, schema.contentUploads.noteId))
    .where(and(
      eq(schema.notes.userId, userId),
      inArray(schema.contentUploads.status, RESERVED_UPLOAD_STATUSES)
    ));
  const usedBytes = storageBytes(
    storageBytes(contentRows[0]!.bytes) + storageBytes(attachmentRows[0]!.bytes)
  );
  const reservedBytes = storageBytes(reservedRows[0]!.bytes);
  await database
    .update(schema.storageAccounts)
    .set({ usedBytes, reservedBytes, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(schema.storageAccounts.userId, userId));
}

function storageBytes(value: number | string): number {
  const bytes = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("PostgreSQL storage aggregate is outside the safe integer range");
  }
  return bytes;
}
