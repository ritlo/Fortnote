import { and, eq, gt, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import {
  ROOT_CRDT_SECTION_ID,
  storageSectionId
} from "../notes/sections.js";
import type { ContentKind } from "./manifests.js";
import type { StorageQuotaStatus } from "./quota.js";
import type {
  AbortContentUploadOutcome,
  BeginContentUploadInput,
  BeginContentUploadOutcome,
  ContentChunkRecord,
  ContentManifestChunkRecord,
  ContentUploadRecord,
  ContentUploadRepository,
  ContentUploadStatus,
  ContentUploadView,
  RegisterContentChunkInput,
  RegisterContentChunkOutcome
} from "./uploadRepository/contracts.js";
import {
  beginUploadGate as beginGate,
  canEditUpload as canEdit,
  contentQuotaStatus as quotaStatus,
  isSameContentChunk as sameChunk,
  isSameContentUpload as sameUpload,
  uploadReservesStorage as reservesStorage,
  type UploadAccess
} from "./uploadRepository/policy.js";

export * from "./uploadRepository/contracts.js";

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

export class SqliteContentUploadRepository implements ContentUploadRepository {
  constructor(private readonly orm: SqliteDatabase) {}

  begin(input: BeginContentUploadInput): Promise<BeginContentUploadOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      if (!activeSession(transaction, input.sessionId)) {
        return { kind: "unauthorized" } as const;
      }
      const access = uploadAccess(transaction, input.noteId, input.userId);
      const gate = beginGate(access, input);
      if (gate) {
        return gate;
      }
      const sectionId = ensureSection(
        transaction,
        input.noteId,
        input.sectionId,
        input.expectedKeyEpoch
      );
      if (!sectionId) {
        return { kind: "not-found" } as const;
      }
      const existingId = transaction
        .select({ id: schema.contentUploads.id })
        .from(schema.contentUploads)
        .where(
          or(
            eq(schema.contentUploads.id, input.uploadId),
            eq(schema.contentUploads.updateId, input.updateId)
          )
        )
        .get()?.id;
      if (existingId) {
        const existing = findUpload(transaction, existingId);
        if (!existing || !sameUpload(existing, input, sectionId)) {
          return { kind: "conflict" } as const;
        }
        const cleanupStorageKeys: string[] = [];
        if (existing.status === "expired" || existing.status === "aborted") {
          if (!reserveStorage(transaction, access!.ownerUserId, input.totalCipherBytes, input.quotaBytes)) {
            return { kind: "storage-limit" } as const;
          }
          cleanupStorageKeys.push(...deleteChunkMetadata(transaction, existing.id));
          transaction
            .update(schema.contentUploads)
            .set({
              status: "receiving",
              expiresAt: input.expiresAt,
              updatedAt: sql`CURRENT_TIMESTAMP`
            })
            .where(eq(schema.contentUploads.id, existing.id))
            .run();
        }
        return beginUploadView(transaction, existing.id, "existing", cleanupStorageKeys);
      }
      if (!reserveStorage(transaction, access!.ownerUserId, input.totalCipherBytes, input.quotaBytes)) {
        return { kind: "storage-limit" } as const;
      }
      transaction
        .insert(schema.contentUploads)
        .values({
          id: input.uploadId,
          updateId: input.updateId,
          noteId: input.noteId,
          sectionId,
          cryptoOwnerId: access!.cryptoOwnerId,
          keyEpoch: input.expectedKeyEpoch,
          kind: input.kind,
          formatVersion: input.formatVersion,
          totalCipherBytes: input.totalCipherBytes,
          chunkCount: input.chunkCount,
          manifestHash: input.manifestHash,
          checkpointSequenceCutoff: input.checkpointSequenceCutoff ?? null,
          status: "receiving",
          expiresAt: input.expiresAt
        })
        .run();
      return beginUploadView(transaction, input.uploadId, "created", []);
    });
    return Promise.resolve(outcome);
  }

  status(uploadId: string, userId: string, now: string): Promise<ContentUploadView | null> {
    const view = this.orm.transaction((transaction) => {
      const upload = findUpload(transaction, uploadId);
      if (!upload || !canEdit(uploadAccess(transaction, upload.noteId, userId))) {
        return null;
      }
      const cleanupStorageKeys: string[] = [];
      if (
        reservesStorage(upload.status) &&
        Date.parse(upload.expiresAt) <= Date.parse(now)
      ) {
        releaseStorage(transaction, upload.ownerUserId, upload.totalCipherBytes);
        cleanupStorageKeys.push(...deleteChunkMetadata(transaction, upload.id));
        transaction
          .update(schema.contentUploads)
          .set({ status: "expired", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(schema.contentUploads.id, upload.id))
          .run();
      }
      return readUploadView(transaction, upload.id, cleanupStorageKeys);
    });
    return Promise.resolve(view);
  }

  findEditable(uploadId: string, userId: string): Promise<ContentUploadRecord | null> {
    const upload = findUpload(this.orm, uploadId);
    const access = upload
      ? uploadAccess(this.orm, upload.noteId, userId)
      : null;
    return Promise.resolve(upload && canEdit(access) ? upload : null);
  }

  findChunk(uploadId: string, chunkIndex: number): Promise<ContentChunkRecord | null> {
    return Promise.resolve(findChunk(this.orm, uploadId, chunkIndex));
  }

  registerChunk(input: RegisterContentChunkInput): Promise<RegisterContentChunkOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      if (!activeSession(transaction, input.sessionId)) {
        return "unauthorized" as const;
      }
      const upload = findUpload(transaction, input.uploadId);
      const access = upload
        ? uploadAccess(transaction, upload.noteId, input.userId)
        : null;
      if (!upload || !canEdit(access)) {
        return "not-found" as const;
      }
      if (access.isDeleted) {
        return "conflict" as const;
      }
      if (access.rotationFenced) {
        return "rotation-pending" as const;
      }
      if (access.keyEpoch !== upload.keyEpoch) {
        return "stale-epoch" as const;
      }
      if (upload.status !== "receiving" && upload.status !== "complete") {
        return "conflict" as const;
      }
      const existing = findChunk(transaction, upload.id, input.chunkIndex);
      if (existing) {
        return sameChunk(existing, input) ? "raced" as const : "chunk-conflict" as const;
      }
      transaction
        .insert(schema.contentChunks)
        .values({
          uploadId: upload.id,
          chunkIndex: input.chunkIndex,
          cipherLength: input.cipherLength,
          cipherHash: input.cipherHash,
          fileCipherPath: input.storageKey,
          nonce: input.nonce
        })
        .run();
      const aggregate = contentAggregate(transaction, upload.id);
      if (aggregate.bytes > upload.totalCipherBytes) {
        transaction
          .update(schema.contentUploads)
          .set({ status: "invalid", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(schema.contentUploads.id, upload.id))
          .run();
        return "manifest-mismatch" as const;
      }
      if (aggregate.count === upload.chunkCount && aggregate.bytes === upload.totalCipherBytes) {
        transaction
          .update(schema.contentUploads)
          .set({ status: "complete", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(schema.contentUploads.id, upload.id))
          .run();
      }
      return "stored" as const;
    });
    return Promise.resolve(outcome);
  }

  abort(
    uploadId: string,
    sessionId: string,
    userId: string
  ): Promise<AbortContentUploadOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      if (!activeSession(transaction, sessionId)) {
        return { kind: "unauthorized" } as const;
      }
      const upload = findUpload(transaction, uploadId);
      const access = upload
        ? uploadAccess(transaction, upload.noteId, userId)
        : null;
      if (!upload || !canEdit(access)) {
        return { kind: "not-found" } as const;
      }
      if (upload.status === "committed") {
        return { kind: "conflict" } as const;
      }
      const storageKeys: string[] = [];
      if (reservesStorage(upload.status)) {
        releaseStorage(transaction, upload.ownerUserId, upload.totalCipherBytes);
        storageKeys.push(...deleteChunkMetadata(transaction, upload.id));
        transaction
          .update(schema.contentUploads)
          .set({ status: "aborted", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(schema.contentUploads.id, upload.id))
          .run();
      }
      return { kind: "aborted", storageKeys } as const;
    });
    return Promise.resolve(outcome);
  }

  findManifestChunk(
    manifestId: string,
    chunkIndex: number
  ): Promise<ContentManifestChunkRecord | null> {
    const row = this.orm
      .select({
        noteId: schema.contentManifests.noteId,
        chunkIndex: schema.contentChunks.chunkIndex,
        cipherLength: schema.contentChunks.cipherLength,
        cipherHash: schema.contentChunks.cipherHash,
        nonce: schema.contentChunks.nonce,
        storageKey: schema.contentChunks.fileCipherPath
      })
      .from(schema.contentManifests)
      .innerJoin(
        schema.contentChunks,
        eq(schema.contentChunks.uploadId, schema.contentManifests.uploadId)
      )
      .where(
        and(
          eq(schema.contentManifests.id, manifestId),
          eq(schema.contentChunks.chunkIndex, chunkIndex)
        )
      )
      .get();
    return Promise.resolve(row ?? null);
  }

  quota(userId: string, quotaBytes: number): Promise<StorageQuotaStatus> {
    const row = this.orm
      .select({
        usedBytes: schema.storageAccounts.usedBytes,
        reservedBytes: schema.storageAccounts.reservedBytes
      })
      .from(schema.storageAccounts)
      .where(eq(schema.storageAccounts.userId, userId))
      .get();
    return Promise.resolve(quotaStatus(row, quotaBytes));
  }
}

function activeSession(
  database: Pick<SqliteDatabase, "select">,
  sessionId: string
): boolean {
  const now = new Date().toISOString();
  return Boolean(
    database
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.id, sessionId),
          gt(schema.sessions.idleExpiresAt, now),
          gt(schema.sessions.absoluteExpiresAt, now)
        )
      )
      .get()
  );
}

function uploadAccess(
  database: Pick<SqliteDatabase, "select">,
  noteId: string,
  userId: string
): UploadAccess | null {
  return database
    .select({
      ownerUserId: schema.notes.userId,
      cryptoOwnerId: schema.notes.cryptoOwnerId,
      keyEpoch: schema.notes.keyEpoch,
      rotationFenced: schema.notes.rotationFenced,
      isDeleted: schema.notes.isDeleted,
      role: schema.noteMemberships.role,
      status: schema.noteMemberships.status
    })
    .from(schema.notes)
    .innerJoin(
      schema.noteMemberships,
      eq(schema.noteMemberships.noteId, schema.notes.id)
    )
    .where(
      and(
        eq(schema.notes.id, noteId),
        eq(schema.noteMemberships.userId, userId)
      )
    )
    .get() ?? null;
}

function ensureSection(
  database: Pick<SqliteDatabase, "select" | "insert">,
  noteId: string,
  sectionId: string,
  keyEpoch: number
): string | null {
  const storedId = storageSectionId(noteId, sectionId);
  if (sectionId === ROOT_CRDT_SECTION_ID) {
    database
      .insert(schema.noteSections)
      .values({ id: noteId, noteId, createdEpoch: keyEpoch })
      .onConflictDoNothing()
      .run();
  }
  const section = database
    .select({
      id: schema.noteSections.id,
      createdEpoch: schema.noteSections.createdEpoch,
      isDeleted: schema.noteSections.isDeleted
    })
    .from(schema.noteSections)
    .where(
      and(
        eq(schema.noteSections.id, storedId),
        eq(schema.noteSections.noteId, noteId)
      )
    )
    .get();
  return section && !section.isDeleted && section.createdEpoch <= keyEpoch
    ? section.id
    : null;
}

function findUpload(
  database: Pick<SqliteDatabase, "select">,
  uploadId: string
): ContentUploadRecord | null {
  const row = database
    .select({
      id: schema.contentUploads.id,
      updateId: schema.contentUploads.updateId,
      noteId: schema.contentUploads.noteId,
      sectionId: schema.contentUploads.sectionId,
      cryptoOwnerId: schema.contentUploads.cryptoOwnerId,
      keyEpoch: schema.contentUploads.keyEpoch,
      kind: schema.contentUploads.kind,
      formatVersion: schema.contentUploads.formatVersion,
      totalCipherBytes: schema.contentUploads.totalCipherBytes,
      chunkCount: schema.contentUploads.chunkCount,
      manifestHash: schema.contentUploads.manifestHash,
      checkpointSequenceCutoff: schema.contentUploads.checkpointSequenceCutoff,
      status: schema.contentUploads.status,
      expiresAt: schema.contentUploads.expiresAt,
      ownerUserId: schema.notes.userId,
      noteKeyEpoch: schema.notes.keyEpoch,
      noteIsDeleted: schema.notes.isDeleted,
      rotationFenced: schema.notes.rotationFenced
    })
    .from(schema.contentUploads)
    .innerJoin(schema.notes, eq(schema.notes.id, schema.contentUploads.noteId))
    .where(eq(schema.contentUploads.id, uploadId))
    .get();
  return row
    ? {
        ...row,
        kind: row.kind as ContentKind,
        status: row.status as ContentUploadStatus
      }
    : null;
}

function findChunk(
  database: Pick<SqliteDatabase, "select">,
  uploadId: string,
  chunkIndex: number
): ContentChunkRecord | null {
  const row = database
    .select({
      chunkIndex: schema.contentChunks.chunkIndex,
      cipherLength: schema.contentChunks.cipherLength,
      cipherHash: schema.contentChunks.cipherHash,
      nonce: schema.contentChunks.nonce,
      storageKey: schema.contentChunks.fileCipherPath
    })
    .from(schema.contentChunks)
    .where(
      and(
        eq(schema.contentChunks.uploadId, uploadId),
        eq(schema.contentChunks.chunkIndex, chunkIndex)
      )
    )
    .get();
  return row ?? null;
}

function readUploadView(
  database: Pick<SqliteDatabase, "select">,
  uploadId: string,
  cleanupStorageKeys: string[]
): ContentUploadView | null {
  const upload = findUpload(database, uploadId);
  if (!upload) {
    return null;
  }
  const receivedChunkIndexes = database
    .select({ chunkIndex: schema.contentChunks.chunkIndex })
    .from(schema.contentChunks)
    .where(eq(schema.contentChunks.uploadId, uploadId))
    .orderBy(schema.contentChunks.chunkIndex)
    .all()
    .map(({ chunkIndex }) => chunkIndex);
  return { upload, receivedChunkIndexes, cleanupStorageKeys };
}

function beginUploadView(
  database: Pick<SqliteDatabase, "select">,
  uploadId: string,
  kind: "created" | "existing",
  cleanupStorageKeys: string[]
): BeginContentUploadOutcome {
  const view = readUploadView(database, uploadId, cleanupStorageKeys);
  return view ? { kind, ...view } : { kind: "conflict" };
}

function reserveStorage(
  database: Pick<SqliteDatabase, "insert" | "update">,
  userId: string,
  bytes: number,
  quotaBytes: number
): boolean {
  database
    .insert(schema.storageAccounts)
    .values({ userId })
    .onConflictDoNothing()
    .run();
  return database
    .update(schema.storageAccounts)
    .set({
      reservedBytes: sql`${schema.storageAccounts.reservedBytes} + ${bytes}`,
      updatedAt: sql`CURRENT_TIMESTAMP`
    })
    .where(
      and(
        eq(schema.storageAccounts.userId, userId),
        sql`${schema.storageAccounts.usedBytes} + ${schema.storageAccounts.reservedBytes} + ${bytes} <= ${quotaBytes}`
      )
    )
    .run().changes === 1;
}

function releaseStorage(
  database: Pick<SqliteDatabase, "update">,
  userId: string,
  bytes: number
): void {
  database
    .update(schema.storageAccounts)
    .set({
      reservedBytes: sql`MAX(${schema.storageAccounts.reservedBytes} - ${bytes}, 0)`,
      updatedAt: sql`CURRENT_TIMESTAMP`
    })
    .where(eq(schema.storageAccounts.userId, userId))
    .run();
}

function deleteChunkMetadata(
  database: Pick<SqliteDatabase, "select" | "delete">,
  uploadId: string
): string[] {
  const storageKeys = database
    .select({ storageKey: schema.contentChunks.fileCipherPath })
    .from(schema.contentChunks)
    .where(eq(schema.contentChunks.uploadId, uploadId))
    .all()
    .map(({ storageKey }) => storageKey);
  database
    .delete(schema.contentChunks)
    .where(eq(schema.contentChunks.uploadId, uploadId))
    .run();
  return storageKeys;
}

function contentAggregate(
  database: Pick<SqliteDatabase, "select">,
  uploadId: string
): { count: number; bytes: number } {
  return database
    .select({
      count: sql<number>`COUNT(*)`,
      bytes: sql<number>`COALESCE(SUM(${schema.contentChunks.cipherLength}), 0)`
    })
    .from(schema.contentChunks)
    .where(eq(schema.contentChunks.uploadId, uploadId))
    .get()!;
}
