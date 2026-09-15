import { and, eq, gt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import { ROOT_CRDT_SECTION_ID, storageSectionId } from "../notes/sections.js";
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

type PostgresDatabase = NodePgDatabase<typeof schema>;

export class PostgresContentUploadRepository implements ContentUploadRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  begin(input: BeginContentUploadInput): Promise<BeginContentUploadOutcome> {
    return this.orm.transaction(async (transaction) => {
      if (!(await activeSession(transaction, input.sessionId))) {
        return { kind: "unauthorized" } as const;
      }
      let existingId = await findExistingUploadId(
        transaction,
        input.uploadId,
        input.updateId
      );
      const access = await uploadAccess(transaction, input.noteId, input.userId, true);
      const gate = beginGate(access, input);
      if (gate) {
        return gate;
      }
      existingId ??= await findExistingUploadId(
        transaction,
        input.uploadId,
        input.updateId
      );
      const sectionId = await ensureSection(
        transaction,
        input.noteId,
        input.sectionId,
        input.expectedKeyEpoch
      );
      if (!sectionId) {
        return { kind: "not-found" } as const;
      }
      if (existingId) {
        const existing = await findUpload(transaction, existingId, true);
        if (!existing || !sameUpload(existing, input, sectionId)) {
          return { kind: "conflict" } as const;
        }
        let cleanupStorageKeys: string[] = [];
        if (existing.status === "expired" || existing.status === "aborted") {
          if (
            !(await reserveStorage(
              transaction,
              access!.ownerUserId,
              input.totalCipherBytes,
              input.quotaBytes
            ))
          ) {
            return { kind: "storage-limit" } as const;
          }
          cleanupStorageKeys = await deleteChunkMetadata(transaction, existing.id);
          await transaction
            .update(schema.contentUploads)
            .set({
              status: "receiving",
              expiresAt: input.expiresAt,
              updatedAt: sql`CURRENT_TIMESTAMP`
            })
            .where(eq(schema.contentUploads.id, existing.id));
        }
        return beginUploadView(transaction, existing.id, "existing", cleanupStorageKeys);
      }
      if (
        !(await reserveStorage(
          transaction,
          access!.ownerUserId,
          input.totalCipherBytes,
          input.quotaBytes
        ))
      ) {
        return { kind: "storage-limit" } as const;
      }
      const inserted = await transaction
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
        .onConflictDoNothing()
        .returning({ id: schema.contentUploads.id });
      if (inserted.length !== 1) {
        await releaseStorage(transaction, access!.ownerUserId, input.totalCipherBytes);
        return { kind: "conflict" } as const;
      }
      return beginUploadView(transaction, input.uploadId, "created", []);
    });
  }

  status(
    uploadId: string,
    userId: string,
    now: string
  ): Promise<ContentUploadView | null> {
    return this.orm.transaction(async (transaction) => {
      const upload = await findUpload(transaction, uploadId, true);
      if (!upload) {
        return null;
      }
      const access = await uploadAccess(transaction, upload.noteId, userId, true);
      if (!canEdit(access)) {
        return null;
      }
      let cleanupStorageKeys: string[] = [];
      if (
        reservesStorage(upload.status) &&
        Date.parse(upload.expiresAt) <= Date.parse(now)
      ) {
        await releaseStorage(transaction, upload.ownerUserId, upload.totalCipherBytes);
        cleanupStorageKeys = await deleteChunkMetadata(transaction, upload.id);
        await transaction
          .update(schema.contentUploads)
          .set({ status: "expired", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(schema.contentUploads.id, upload.id));
      }
      return readUploadView(transaction, upload.id, cleanupStorageKeys);
    });
  }

  async findEditable(
    uploadId: string,
    userId: string
  ): Promise<ContentUploadRecord | null> {
    const upload = await findUpload(this.orm, uploadId, false);
    if (!upload) {
      return null;
    }
    const access = await uploadAccess(this.orm, upload.noteId, userId, false);
    return canEdit(access) ? upload : null;
  }

  async findChunk(
    uploadId: string,
    chunkIndex: number
  ): Promise<ContentChunkRecord | null> {
    return findChunk(this.orm, uploadId, chunkIndex);
  }

  registerChunk(input: RegisterContentChunkInput): Promise<RegisterContentChunkOutcome> {
    return this.orm.transaction(async (transaction) => {
      if (!(await activeSession(transaction, input.sessionId))) {
        return "unauthorized" as const;
      }
      const upload = await findUpload(transaction, input.uploadId, true);
      if (!upload) {
        return "not-found" as const;
      }
      const access = await uploadAccess(transaction, upload.noteId, input.userId, true);
      if (!canEdit(access)) {
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
      const existing = await findChunk(transaction, upload.id, input.chunkIndex, true);
      if (existing) {
        return sameChunk(existing, input)
          ? ("raced" as const)
          : ("chunk-conflict" as const);
      }
      const inserted = await transaction
        .insert(schema.contentChunks)
        .values({
          uploadId: upload.id,
          chunkIndex: input.chunkIndex,
          cipherLength: input.cipherLength,
          cipherHash: input.cipherHash,
          storageKey: input.storageKey,
          nonce: input.nonce
        })
        .onConflictDoNothing()
        .returning({ chunkIndex: schema.contentChunks.chunkIndex });
      if (inserted.length !== 1) {
        const raced = await findChunk(transaction, upload.id, input.chunkIndex, false);
        return raced && sameChunk(raced, input)
          ? ("raced" as const)
          : ("chunk-conflict" as const);
      }
      const aggregate = await contentAggregate(transaction, upload.id);
      if (aggregate.bytes > upload.totalCipherBytes) {
        await transaction
          .update(schema.contentUploads)
          .set({ status: "invalid", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(schema.contentUploads.id, upload.id));
        return "manifest-mismatch" as const;
      }
      if (
        aggregate.count === upload.chunkCount &&
        aggregate.bytes === upload.totalCipherBytes
      ) {
        await transaction
          .update(schema.contentUploads)
          .set({ status: "complete", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(schema.contentUploads.id, upload.id));
      }
      return "stored" as const;
    });
  }

  abort(
    uploadId: string,
    sessionId: string,
    userId: string
  ): Promise<AbortContentUploadOutcome> {
    return this.orm.transaction(async (transaction) => {
      if (!(await activeSession(transaction, sessionId))) {
        return { kind: "unauthorized" } as const;
      }
      const upload = await findUpload(transaction, uploadId, true);
      if (!upload) {
        return { kind: "not-found" } as const;
      }
      const access = await uploadAccess(transaction, upload.noteId, userId, true);
      if (!canEdit(access)) {
        return { kind: "not-found" } as const;
      }
      if (upload.status === "committed") {
        return { kind: "conflict" } as const;
      }
      let storageKeys: string[] = [];
      if (reservesStorage(upload.status)) {
        await releaseStorage(transaction, upload.ownerUserId, upload.totalCipherBytes);
        storageKeys = await deleteChunkMetadata(transaction, upload.id);
        await transaction
          .update(schema.contentUploads)
          .set({ status: "aborted", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(schema.contentUploads.id, upload.id));
      }
      return { kind: "aborted", storageKeys } as const;
    });
  }

  async findManifestChunk(
    manifestId: string,
    chunkIndex: number
  ): Promise<ContentManifestChunkRecord | null> {
    const rows = await this.orm
      .select({
        noteId: schema.contentManifests.noteId,
        chunkIndex: schema.contentChunks.chunkIndex,
        cipherLength: schema.contentChunks.cipherLength,
        cipherHash: schema.contentChunks.cipherHash,
        nonce: schema.contentChunks.nonce,
        storageKey: schema.contentChunks.storageKey
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
      .limit(1);
    return rows[0] ?? null;
  }

  async quota(userId: string, quotaBytes: number): Promise<StorageQuotaStatus> {
    const rows = await this.orm
      .select({
        usedBytes: schema.storageAccounts.usedBytes,
        reservedBytes: schema.storageAccounts.reservedBytes
      })
      .from(schema.storageAccounts)
      .where(eq(schema.storageAccounts.userId, userId))
      .limit(1);
    return quotaStatus(rows[0], quotaBytes);
  }
}

async function activeSession(
  database: Pick<PostgresDatabase, "select">,
  sessionId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await database
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        gt(schema.sessions.idleExpiresAt, now),
        gt(schema.sessions.absoluteExpiresAt, now)
      )
    )
    .limit(1)
    .for("key share");
  return Boolean(rows[0]);
}

async function uploadAccess(
  database: Pick<PostgresDatabase, "select">,
  noteId: string,
  userId: string,
  lock: boolean
): Promise<UploadAccess | null> {
  const query = database
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
    .innerJoin(schema.noteMemberships, eq(schema.noteMemberships.noteId, schema.notes.id))
    .where(and(eq(schema.notes.id, noteId), eq(schema.noteMemberships.userId, userId)))
    .limit(1);
  const rows = lock
    ? await query.for("update", { of: [schema.notes, schema.noteMemberships] })
    : await query;
  return rows[0] ?? null;
}

async function ensureSection(
  database: Pick<PostgresDatabase, "select" | "insert">,
  noteId: string,
  sectionId: string,
  keyEpoch: number
): Promise<string | null> {
  const storedId = storageSectionId(noteId, sectionId);
  if (sectionId === ROOT_CRDT_SECTION_ID) {
    await database
      .insert(schema.noteSections)
      .values({ id: noteId, noteId, createdEpoch: keyEpoch })
      .onConflictDoNothing();
  }
  const rows = await database
    .select({
      id: schema.noteSections.id,
      createdEpoch: schema.noteSections.createdEpoch,
      isDeleted: schema.noteSections.isDeleted
    })
    .from(schema.noteSections)
    .where(
      and(eq(schema.noteSections.id, storedId), eq(schema.noteSections.noteId, noteId))
    )
    .limit(1)
    .for("update");
  const section = rows[0];
  return section && !section.isDeleted && section.createdEpoch <= keyEpoch
    ? section.id
    : null;
}

async function findExistingUploadId(
  database: Pick<PostgresDatabase, "select">,
  uploadId: string,
  updateId: string
): Promise<string | null> {
  const rows = await database
    .select({ id: schema.contentUploads.id })
    .from(schema.contentUploads)
    .where(
      or(
        eq(schema.contentUploads.id, uploadId),
        eq(schema.contentUploads.updateId, updateId)
      )
    )
    .limit(1)
    .for("update");
  return rows[0]?.id ?? null;
}

async function findUpload(
  database: Pick<PostgresDatabase, "select">,
  uploadId: string,
  lock: boolean
): Promise<ContentUploadRecord | null> {
  const query = database
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
    .limit(1);
  const rows = lock
    ? await query.for("update", { of: schema.contentUploads })
    : await query;
  const row = rows[0];
  return row
    ? {
        ...row,
        kind: row.kind as ContentKind,
        status: row.status as ContentUploadStatus
      }
    : null;
}

async function findChunk(
  database: Pick<PostgresDatabase, "select">,
  uploadId: string,
  chunkIndex: number,
  lock = false
): Promise<ContentChunkRecord | null> {
  const query = database
    .select({
      chunkIndex: schema.contentChunks.chunkIndex,
      cipherLength: schema.contentChunks.cipherLength,
      cipherHash: schema.contentChunks.cipherHash,
      nonce: schema.contentChunks.nonce,
      storageKey: schema.contentChunks.storageKey
    })
    .from(schema.contentChunks)
    .where(
      and(
        eq(schema.contentChunks.uploadId, uploadId),
        eq(schema.contentChunks.chunkIndex, chunkIndex)
      )
    )
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  return rows[0] ?? null;
}

async function readUploadView(
  database: Pick<PostgresDatabase, "select">,
  uploadId: string,
  cleanupStorageKeys: string[]
): Promise<ContentUploadView | null> {
  const upload = await findUpload(database, uploadId, false);
  if (!upload) {
    return null;
  }
  const chunks = await database
    .select({ chunkIndex: schema.contentChunks.chunkIndex })
    .from(schema.contentChunks)
    .where(eq(schema.contentChunks.uploadId, uploadId))
    .orderBy(schema.contentChunks.chunkIndex);
  return {
    upload,
    receivedChunkIndexes: chunks.map(({ chunkIndex }) => chunkIndex),
    cleanupStorageKeys
  };
}

async function beginUploadView(
  database: Pick<PostgresDatabase, "select">,
  uploadId: string,
  kind: "created" | "existing",
  cleanupStorageKeys: string[]
): Promise<BeginContentUploadOutcome> {
  const view = await readUploadView(database, uploadId, cleanupStorageKeys);
  return view ? { kind, ...view } : { kind: "conflict" };
}

async function reserveStorage(
  database: Pick<PostgresDatabase, "insert" | "update">,
  userId: string,
  bytes: number,
  quotaBytes: number
): Promise<boolean> {
  await database.insert(schema.storageAccounts).values({ userId }).onConflictDoNothing();
  const rows = await database
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
    .returning({ userId: schema.storageAccounts.userId });
  return rows.length === 1;
}

async function releaseStorage(
  database: Pick<PostgresDatabase, "update">,
  userId: string,
  bytes: number
): Promise<void> {
  await database
    .update(schema.storageAccounts)
    .set({
      reservedBytes: sql`GREATEST(${schema.storageAccounts.reservedBytes} - ${bytes}, 0)`,
      updatedAt: sql`CURRENT_TIMESTAMP`
    })
    .where(eq(schema.storageAccounts.userId, userId));
}

async function deleteChunkMetadata(
  database: Pick<PostgresDatabase, "delete">,
  uploadId: string
): Promise<string[]> {
  const rows = await database
    .delete(schema.contentChunks)
    .where(eq(schema.contentChunks.uploadId, uploadId))
    .returning({ storageKey: schema.contentChunks.storageKey });
  return rows.map(({ storageKey }) => storageKey);
}

async function contentAggregate(
  database: Pick<PostgresDatabase, "select">,
  uploadId: string
): Promise<{ count: number; bytes: number }> {
  const rows = await database
    .select({
      count: sql<number>`COUNT(*)`.mapWith(Number),
      bytes: sql<number>`COALESCE(SUM(${schema.contentChunks.cipherLength}), 0)`.mapWith(
        Number
      )
    })
    .from(schema.contentChunks)
    .where(eq(schema.contentChunks.uploadId, uploadId));
  return rows[0]!;
}
