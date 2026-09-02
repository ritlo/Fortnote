import { and, eq, gt, lte, ne, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import {
  contentManifestHash,
  type CommitContentManifestInput,
  type ContentChunkDescriptor,
  type ContentKind,
  type ContentManifestRepository,
  type ContentManifestSummary,
  type ManifestCommitOutcome
} from "./manifests.js";

interface AccessRow {
  ownerUserId: string;
  keyEpoch: number;
  rotationFenced: boolean;
  isDeleted: boolean;
  role: string;
  membershipStatus: string;
}

interface UploadRow {
  id: string;
  updateId: string;
  noteId: string;
  sectionId: string;
  cryptoOwnerId: string;
  keyEpoch: number;
  kind: ContentKind;
  formatVersion: number;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
  checkpointSequenceCutoff: number | null;
  status: string;
}

type StoredManifest = Omit<ContentManifestSummary, "checkpointSequenceCutoff"> & {
  checkpointSequenceCutoff: number | null;
};
type SqliteDatabase = BetterSQLite3Database<typeof schema>;

class CommitRejected extends Error {
  constructor(readonly outcome: Exclude<ManifestCommitOutcome, { kind: "committed" }>) {
    super(outcome.kind);
  }
}

export class SqliteContentManifestRepository implements ContentManifestRepository {
  constructor(private readonly orm: SqliteDatabase) {}

  commit(input: CommitContentManifestInput): Promise<ManifestCommitOutcome> {
    try {
      const outcome = this.orm.transaction((transaction): ManifestCommitOutcome => {
        if (!activeSession(transaction, input.sessionId)) {
          reject({ kind: "unauthorized" });
        }
        const upload = findUpload(transaction, input.uploadId);
        if (!upload) {
          reject({ kind: "not-found" });
        }
        const access = findAccess(transaction, upload.noteId, input.userId);
        validateGate(upload, access, input);
        const existing = existingManifest(transaction, upload.id);
        if (existing) {
          return { kind: "committed", manifest: existing };
        }
        if (upload.status !== "complete") {
          reject({ kind: "chunk-missing" });
        }
        validateChunks(upload, listChunks(transaction, upload.id));
        const section = transaction
          .select({ currentSequence: schema.noteSections.currentSequence })
          .from(schema.noteSections)
          .where(and(
            eq(schema.noteSections.id, upload.sectionId),
            eq(schema.noteSections.noteId, upload.noteId),
            eq(schema.noteSections.isDeleted, false)
          ))
          .get();
        if (!section) {
          reject({ kind: "not-found" });
        }
        validateCheckpoint(upload, section.currentSequence);
        const sequence = section.currentSequence + 1;
        insertManifest(transaction, input.requestId, upload, sequence);
        transaction.insert(schema.sectionUpdates).values({
          updateId: upload.updateId,
          noteId: upload.noteId,
          sectionId: upload.sectionId,
          serverSequence: sequence,
          cryptoOwnerId: upload.cryptoOwnerId,
          keyEpoch: upload.keyEpoch,
          formatVersion: upload.formatVersion,
          kind: upload.kind,
          checkpointSequenceCutoff: upload.checkpointSequenceCutoff,
          manifestId: input.requestId
        }).run();
        transaction.update(schema.noteSections).set({
          currentSequence: sequence,
          updatedAt: sql`CURRENT_TIMESTAMP`
        }).where(and(
          eq(schema.noteSections.id, upload.sectionId),
          eq(schema.noteSections.noteId, upload.noteId)
        )).run();
        compactCheckpoint(transaction, upload);
        if (!commitStorage(transaction, access!.ownerUserId, upload.totalCipherBytes)) {
          reject({ kind: "storage-limit" });
        }
        transaction.update(schema.contentUploads).set({
          status: "committed",
          updatedAt: sql`CURRENT_TIMESTAMP`
        }).where(eq(schema.contentUploads.id, upload.id)).run();
        const manifest = existingManifest(transaction, upload.id);
        if (!manifest) {
          throw new Error("Committed content manifest was not readable");
        }
        return { kind: "committed", manifest };
      });
      return Promise.resolve(outcome);
    } catch (error) {
      if (error instanceof CommitRejected) {
        return Promise.resolve(error.outcome);
      }
      if (isConstraintError(error)) {
        const existing = existingManifest(this.orm, input.uploadId);
        return Promise.resolve(existing
          ? { kind: "committed", manifest: existing }
          : { kind: "conflict" });
      }
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("Content manifest commit failed", { cause: error })
      );
    }
  }
}

function activeSession(database: Pick<SqliteDatabase, "select">, sessionId: string): boolean {
  const now = new Date().toISOString();
  return Boolean(database.select({ id: schema.sessions.id }).from(schema.sessions).where(and(
    eq(schema.sessions.id, sessionId),
    gt(schema.sessions.idleExpiresAt, now),
    gt(schema.sessions.absoluteExpiresAt, now)
  )).get());
}

function findUpload(
  database: Pick<SqliteDatabase, "select">,
  uploadId: string
): UploadRow | null {
  const row = database.select({
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
    status: schema.contentUploads.status
  }).from(schema.contentUploads).where(eq(schema.contentUploads.id, uploadId)).get();
  return row ? { ...row, kind: row.kind as ContentKind } : null;
}

function findAccess(
  database: Pick<SqliteDatabase, "select">,
  noteId: string,
  userId: string
): AccessRow | null {
  return database.select({
    ownerUserId: schema.notes.userId,
    keyEpoch: schema.notes.keyEpoch,
    rotationFenced: schema.notes.rotationFenced,
    isDeleted: schema.notes.isDeleted,
    role: schema.noteMemberships.role,
    membershipStatus: schema.noteMemberships.status
  }).from(schema.notes).innerJoin(
    schema.noteMemberships,
    eq(schema.noteMemberships.noteId, schema.notes.id)
  ).where(and(
    eq(schema.notes.id, noteId),
    eq(schema.noteMemberships.userId, userId)
  )).get() ?? null;
}

function validateGate(
  upload: UploadRow,
  access: AccessRow | null,
  input: CommitContentManifestInput
): void {
  if (access?.membershipStatus !== "active" ||
    (access.role !== "owner" && access.role !== "editor")) {
    reject({ kind: "not-found" });
  }
  if (access.isDeleted) {
    reject({ kind: "conflict" });
  }
  if (access.rotationFenced) {
    reject({ kind: "rotation-pending" });
  }
  if (upload.updateId !== input.updateId ||
    upload.keyEpoch !== input.expectedKeyEpoch ||
    access.keyEpoch !== input.expectedKeyEpoch) {
    reject({ kind: "stale-epoch" });
  }
}

function listChunks(
  database: Pick<SqliteDatabase, "select">,
  uploadId: string
): ContentChunkDescriptor[] {
  return database.select({
    chunkIndex: schema.contentChunks.chunkIndex,
    cipherLength: schema.contentChunks.cipherLength,
    cipherHash: schema.contentChunks.cipherHash,
    nonce: schema.contentChunks.nonce
  }).from(schema.contentChunks).where(
    eq(schema.contentChunks.uploadId, uploadId)
  ).orderBy(schema.contentChunks.chunkIndex).all();
}

function validateChunks(upload: UploadRow, chunks: ContentChunkDescriptor[]): void {
  if (chunks.length !== upload.chunkCount ||
    chunks.some((chunk, index) => chunk.chunkIndex !== index) ||
    chunks.reduce((total, chunk) => total + chunk.cipherLength, 0) !== upload.totalCipherBytes) {
    reject({ kind: "chunk-missing" });
  }
  if (contentManifestHash(chunks) !== upload.manifestHash) {
    reject({ kind: "manifest-mismatch" });
  }
}

function validateCheckpoint(upload: UploadRow, currentSequence: number): void {
  if (upload.kind === "checkpoint" &&
    (upload.checkpointSequenceCutoff === null ||
      upload.checkpointSequenceCutoff > currentSequence)) {
    reject({ kind: "conflict" });
  }
}

function insertManifest(
  database: Pick<SqliteDatabase, "insert">,
  manifestId: string,
  upload: UploadRow,
  sequence: number
): void {
  database.insert(schema.contentManifests).values({
    id: manifestId,
    uploadId: upload.id,
    updateId: upload.updateId,
    noteId: upload.noteId,
    sectionId: upload.sectionId,
    keyEpoch: upload.keyEpoch,
    kind: upload.kind,
    formatVersion: upload.formatVersion,
    firstSequence: sequence,
    lastSequence: sequence,
    totalCipherBytes: upload.totalCipherBytes,
    chunkCount: upload.chunkCount,
    manifestHash: upload.manifestHash,
    checkpointSequenceCutoff: upload.checkpointSequenceCutoff
  }).run();
}

function compactCheckpoint(
  database: Pick<SqliteDatabase, "delete">,
  upload: UploadRow
): void {
  if (upload.kind !== "checkpoint" || upload.checkpointSequenceCutoff === null) {
    return;
  }
  database.delete(schema.sectionUpdates).where(and(
    eq(schema.sectionUpdates.noteId, upload.noteId),
    eq(schema.sectionUpdates.sectionId, upload.sectionId),
    eq(schema.sectionUpdates.keyEpoch, upload.keyEpoch),
    lte(schema.sectionUpdates.serverSequence, upload.checkpointSequenceCutoff),
    ne(schema.sectionUpdates.updateId, upload.updateId)
  )).run();
}

function commitStorage(
  database: Pick<SqliteDatabase, "update">,
  userId: string,
  bytes: number
): boolean {
  return database.update(schema.storageAccounts).set({
    usedBytes: sql`${schema.storageAccounts.usedBytes} + ${bytes}`,
    reservedBytes: sql`${schema.storageAccounts.reservedBytes} - ${bytes}`,
    updatedAt: sql`CURRENT_TIMESTAMP`
  }).where(and(
    eq(schema.storageAccounts.userId, userId),
    sql`${schema.storageAccounts.reservedBytes} >= ${bytes}`
  )).run().changes === 1;
}

function existingManifest(
  database: Pick<SqliteDatabase, "select">,
  uploadId: string
): ContentManifestSummary | null {
  const row = database.select({
    manifestId: schema.contentManifests.id,
    uploadId: schema.contentManifests.uploadId,
    updateId: schema.contentManifests.updateId,
    noteId: schema.contentManifests.noteId,
    sectionId: schema.contentManifests.sectionId,
    cryptoOwnerId: schema.contentUploads.cryptoOwnerId,
    keyEpoch: schema.contentManifests.keyEpoch,
    kind: schema.contentManifests.kind,
    firstSequence: schema.contentManifests.firstSequence,
    lastSequence: schema.contentManifests.lastSequence,
    totalCipherBytes: schema.contentManifests.totalCipherBytes,
    chunkCount: schema.contentManifests.chunkCount,
    manifestHash: schema.contentManifests.manifestHash,
    checkpointSequenceCutoff: schema.contentManifests.checkpointSequenceCutoff
  }).from(schema.contentManifests).innerJoin(
    schema.contentUploads,
    eq(schema.contentUploads.id, schema.contentManifests.uploadId)
  ).where(eq(schema.contentManifests.uploadId, uploadId)).get() as StoredManifest | undefined;
  if (!row) {
    return null;
  }
  const { checkpointSequenceCutoff, ...manifest } = row;
  return {
    ...manifest,
    ...(checkpointSequenceCutoff === null ? {} : { checkpointSequenceCutoff }),
    sectionId: row.sectionId === row.noteId ? "root" : row.sectionId
  };
}

function reject(outcome: Exclude<ManifestCommitOutcome, { kind: "committed" }>): never {
  throw new CommitRejected(outcome);
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/iu.test(error.message);
}
