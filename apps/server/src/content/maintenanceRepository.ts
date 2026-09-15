import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

const RESERVED_UPLOAD_STATUSES = ["receiving", "complete", "invalid"];
const REMOVABLE_UPLOAD_STATUSES = new Set(["aborted", "expired", "invalid"]);

export interface ExpiredContentUpload {
  uploadId: string;
  storageKeys: string[];
}

export interface ExpiredContentUploadPage {
  uploads: ExpiredContentUpload[];
  hasMore: boolean;
}

export interface StorageObjectCleanupPage {
  scanned: number;
  removed: number;
  done: boolean;
}

export interface StorageAccountReconciliationPage {
  processed: number;
  hasMore: boolean;
  nextUserId: string | null;
}

export interface ContentMaintenanceRepository {
  expireUploads(cutoff: string, limit: number): Promise<ExpiredContentUploadPage>;
  canRemoveUpload(uploadId: string): Promise<boolean>;
  removeOrphanObjects(cutoff: string, limit: number): Promise<StorageObjectCleanupPage>;
  reconcileStorageAccounts(
    afterUserId: string | null,
    limit: number
  ): Promise<StorageAccountReconciliationPage>;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

export class SqliteContentMaintenanceRepository implements ContentMaintenanceRepository {
  constructor(private readonly orm: SqliteDatabase) {}

  expireUploads(cutoff: string, limit: number): Promise<ExpiredContentUploadPage> {
    const page = this.orm.transaction((transaction) => {
      const candidates = transaction
        .select({
          uploadId: schema.contentUploads.id,
          ownerUserId: schema.notes.userId,
          totalCipherBytes: schema.contentUploads.totalCipherBytes
        })
        .from(schema.contentUploads)
        .innerJoin(schema.notes, eq(schema.notes.id, schema.contentUploads.noteId))
        .where(
          and(
            inArray(schema.contentUploads.status, RESERVED_UPLOAD_STATUSES),
            lte(schema.contentUploads.expiresAt, cutoff)
          )
        )
        .orderBy(schema.contentUploads.expiresAt, schema.contentUploads.id)
        .limit(limit)
        .all();
      const uploads: ExpiredContentUpload[] = [];

      for (const candidate of candidates) {
        const claimed = transaction
          .update(schema.contentUploads)
          .set({ status: "expired", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(schema.contentUploads.id, candidate.uploadId),
              inArray(schema.contentUploads.status, RESERVED_UPLOAD_STATUSES),
              lte(schema.contentUploads.expiresAt, cutoff)
            )
          )
          .run();
        if (claimed.changes !== 1) {
          continue;
        }
        const storageKeys = transaction
          .select({ storageKey: schema.contentChunks.fileCipherPath })
          .from(schema.contentChunks)
          .where(eq(schema.contentChunks.uploadId, candidate.uploadId))
          .all()
          .map(({ storageKey }) => storageKey);
        transaction
          .delete(schema.contentChunks)
          .where(eq(schema.contentChunks.uploadId, candidate.uploadId))
          .run();
        transaction
          .update(schema.storageAccounts)
          .set({
            reservedBytes: sql`MAX(${schema.storageAccounts.reservedBytes} - ${candidate.totalCipherBytes}, 0)`,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(eq(schema.storageAccounts.userId, candidate.ownerUserId))
          .run();
        uploads.push({ uploadId: candidate.uploadId, storageKeys });
      }

      const remaining = transaction
        .select({ id: schema.contentUploads.id })
        .from(schema.contentUploads)
        .where(
          and(
            inArray(schema.contentUploads.status, RESERVED_UPLOAD_STATUSES),
            lte(schema.contentUploads.expiresAt, cutoff)
          )
        )
        .limit(1)
        .get();
      return { uploads, hasMore: Boolean(remaining) };
    });
    return Promise.resolve(page);
  }

  canRemoveUpload(uploadId: string): Promise<boolean> {
    const upload = this.orm
      .select({ status: schema.contentUploads.status })
      .from(schema.contentUploads)
      .where(eq(schema.contentUploads.id, uploadId))
      .get();
    if (!upload) {
      return Promise.resolve(true);
    }
    if (upload.status === "committed") {
      return Promise.resolve(false);
    }
    const manifest = this.orm
      .select({ id: schema.contentManifests.id })
      .from(schema.contentManifests)
      .where(eq(schema.contentManifests.uploadId, uploadId))
      .limit(1)
      .get();
    return Promise.resolve(!manifest && REMOVABLE_UPLOAD_STATUSES.has(upload.status));
  }

  removeOrphanObjects(cutoff: string, limit: number): Promise<StorageObjectCleanupPage> {
    void cutoff;
    void limit;
    return Promise.resolve({ scanned: 0, removed: 0, done: true });
  }

  reconcileStorageAccounts(
    afterUserId: string | null,
    limit: number
  ): Promise<StorageAccountReconciliationPage> {
    const userIds = listUserIds(this.orm, afterUserId, limit);
    for (const userId of userIds.slice(0, limit)) {
      this.orm.transaction((transaction) => {
        reconcileStorageAccount(transaction, userId);
      });
    }
    const processed = Math.min(userIds.length, limit);
    return Promise.resolve({
      processed,
      hasMore: userIds.length > limit,
      nextUserId: processed > 0 ? userIds[processed - 1]! : null
    });
  }
}

function listUserIds(
  database: SqliteDatabase,
  afterUserId: string | null,
  limit: number
): string[] {
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
  const storageRows = afterUserId
    ? storageQuery.where(gt(schema.storageAccounts.userId, afterUserId)).all()
    : storageQuery.all();
  const noteRows = afterUserId
    ? noteQuery.where(gt(schema.notes.userId, afterUserId)).all()
    : noteQuery.all();
  return [...new Set([...storageRows, ...noteRows].map(({ userId }) => userId))]
    .sort()
    .slice(0, limit + 1);
}

function reconcileStorageAccount(database: SqliteDatabase, userId: string): void {
  const contentBytes = database
    .select({
      bytes: sql<number>`COALESCE(SUM(${schema.contentManifests.totalCipherBytes}), 0)`
    })
    .from(schema.contentManifests)
    .innerJoin(schema.notes, eq(schema.notes.id, schema.contentManifests.noteId))
    .where(eq(schema.notes.userId, userId))
    .get()!.bytes;
  const attachmentBytes = database
    .select({ bytes: sql<number>`COALESCE(SUM(${schema.attachments.size}), 0)` })
    .from(schema.attachments)
    .innerJoin(schema.notes, eq(schema.notes.id, schema.attachments.noteId))
    .where(eq(schema.notes.userId, userId))
    .get()!.bytes;
  const reservedBytes = database
    .select({
      bytes: sql<number>`COALESCE(SUM(${schema.contentUploads.totalCipherBytes}), 0)`
    })
    .from(schema.contentUploads)
    .innerJoin(schema.notes, eq(schema.notes.id, schema.contentUploads.noteId))
    .where(
      and(
        eq(schema.notes.userId, userId),
        inArray(schema.contentUploads.status, RESERVED_UPLOAD_STATUSES)
      )
    )
    .get()!.bytes;
  const usedBytes = contentBytes + attachmentBytes;

  database
    .insert(schema.storageAccounts)
    .values({ userId, usedBytes, reservedBytes })
    .onConflictDoUpdate({
      target: schema.storageAccounts.userId,
      set: { usedBytes, reservedBytes, updatedAt: sql`CURRENT_TIMESTAMP` }
    })
    .run();
}
