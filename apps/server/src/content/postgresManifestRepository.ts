import { and, eq, gt, lte, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import {
  contentManifestHash,
  type CommitContentManifestInput,
  type ContentKind,
  type ContentManifestRepository,
  type ContentManifestSummary,
  type ManifestCommitOutcome
} from "./manifests.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

class CommitRejected extends Error {
  constructor(readonly outcome: Exclude<ManifestCommitOutcome, { kind: "committed" }>) {
    super(outcome.kind);
  }
}

export class PostgresContentManifestRepository
  implements ContentManifestRepository
{
  constructor(private readonly orm: PostgresDatabase) {}

  async commit(input: CommitContentManifestInput): Promise<ManifestCommitOutcome> {
    try {
      return await this.orm.transaction(async (transaction) => {
        const now = new Date().toISOString();
        const sessions = await transaction
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(and(
            eq(schema.sessions.id, input.sessionId),
            gt(schema.sessions.idleExpiresAt, now),
            gt(schema.sessions.absoluteExpiresAt, now)
          ))
          .limit(1)
          .for("key share");
        if (!sessions[0]) reject({ kind: "unauthorized" });

        const uploads = await transaction
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
            status: schema.contentUploads.status
          })
          .from(schema.contentUploads)
          .where(eq(schema.contentUploads.id, input.uploadId))
          .limit(1)
          .for("update");
        const rawUpload = uploads[0];
        if (!rawUpload) reject({ kind: "not-found" });
        const upload = { ...rawUpload, kind: rawUpload.kind as ContentKind };

        const accessRows = await transaction
          .select({
            ownerUserId: schema.notes.userId,
            keyEpoch: schema.notes.keyEpoch,
            rotationFenced: schema.notes.rotationFenced,
            isDeleted: schema.notes.isDeleted,
            role: schema.noteMemberships.role,
            membershipStatus: schema.noteMemberships.status
          })
          .from(schema.notes)
          .innerJoin(schema.noteMemberships, eq(schema.noteMemberships.noteId, schema.notes.id))
          .where(and(
            eq(schema.notes.id, upload.noteId),
            eq(schema.noteMemberships.userId, input.userId)
          ))
          .limit(1)
          .for("update", { of: [schema.notes, schema.noteMemberships] });
        const access = accessRows[0];
        if (access?.membershipStatus !== "active" ||
          (access.role !== "owner" && access.role !== "editor")) {
          reject({ kind: "not-found" });
        }
        if (access.isDeleted) reject({ kind: "conflict" });
        if (access.rotationFenced) reject({ kind: "rotation-pending" });
        if (upload.updateId !== input.updateId ||
          upload.keyEpoch !== input.expectedKeyEpoch ||
          access.keyEpoch !== input.expectedKeyEpoch) {
          reject({ kind: "stale-epoch" });
        }

        const existing = await readManifest(transaction, upload.id);
        if (existing) return { kind: "committed", manifest: existing } as const;
        if (upload.status !== "complete") reject({ kind: "chunk-missing" });

        const chunks = await transaction
          .select({
            chunkIndex: schema.contentChunks.chunkIndex,
            cipherLength: schema.contentChunks.cipherLength,
            cipherHash: schema.contentChunks.cipherHash,
            nonce: schema.contentChunks.nonce
          })
          .from(schema.contentChunks)
          .where(eq(schema.contentChunks.uploadId, upload.id))
          .orderBy(schema.contentChunks.chunkIndex)
          .for("key share");
        if (chunks.length !== upload.chunkCount ||
          chunks.some((chunk, index) => chunk.chunkIndex !== index) ||
          chunks.reduce((total, chunk) => total + chunk.cipherLength, 0) !== upload.totalCipherBytes) {
          reject({ kind: "chunk-missing" });
        }
        if (contentManifestHash(chunks) !== upload.manifestHash) {
          reject({ kind: "manifest-mismatch" });
        }

        const sections = await transaction
          .select({ currentSequence: schema.noteSections.currentSequence })
          .from(schema.noteSections)
          .where(and(
            eq(schema.noteSections.id, upload.sectionId),
            eq(schema.noteSections.noteId, upload.noteId),
            eq(schema.noteSections.isDeleted, false)
          ))
          .limit(1)
          .for("update");
        const section = sections[0];
        if (!section) reject({ kind: "not-found" });
        if (upload.kind === "checkpoint" &&
          (upload.checkpointSequenceCutoff === null ||
            upload.checkpointSequenceCutoff > section.currentSequence)) {
          reject({ kind: "conflict" });
        }
        const sequence = section.currentSequence + 1;
        await transaction.insert(schema.contentManifests).values({
          id: input.requestId,
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
        });
        await transaction.insert(schema.sectionUpdates).values({
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
        });
        const advanced = await transaction.update(schema.noteSections).set({
          currentSequence: sequence,
          updatedAt: sql`CURRENT_TIMESTAMP`
        }).where(and(
          eq(schema.noteSections.id, upload.sectionId),
          eq(schema.noteSections.noteId, upload.noteId),
          eq(schema.noteSections.currentSequence, section.currentSequence)
        )).returning({ id: schema.noteSections.id });
        if (advanced.length !== 1) throw new Error("Section sequence changed while locked");
        if (upload.kind === "checkpoint" && upload.checkpointSequenceCutoff !== null) {
          await transaction.delete(schema.sectionUpdates).where(and(
            eq(schema.sectionUpdates.noteId, upload.noteId),
            eq(schema.sectionUpdates.sectionId, upload.sectionId),
            eq(schema.sectionUpdates.keyEpoch, upload.keyEpoch),
            lte(schema.sectionUpdates.serverSequence, upload.checkpointSequenceCutoff),
            ne(schema.sectionUpdates.updateId, upload.updateId)
          ));
        }
        const committed = await transaction.update(schema.storageAccounts).set({
          usedBytes: sql`${schema.storageAccounts.usedBytes} + ${upload.totalCipherBytes}`,
          reservedBytes: sql`${schema.storageAccounts.reservedBytes} - ${upload.totalCipherBytes}`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        }).where(and(
          eq(schema.storageAccounts.userId, access.ownerUserId),
          sql`${schema.storageAccounts.reservedBytes} >= ${upload.totalCipherBytes}`
        )).returning({ userId: schema.storageAccounts.userId });
        if (committed.length !== 1) reject({ kind: "storage-limit" });
        await transaction.update(schema.contentUploads).set({
          status: "committed",
          updatedAt: sql`CURRENT_TIMESTAMP`
        }).where(eq(schema.contentUploads.id, upload.id));
        const manifest = await readManifest(transaction, upload.id);
        if (!manifest) throw new Error("Committed content manifest was not readable");
        return { kind: "committed", manifest } as const;
      });
    } catch (error) {
      if (error instanceof CommitRejected) return error.outcome;
      if (isConstraintError(error)) {
        const existing = await readManifest(this.orm, input.uploadId);
        return existing
          ? { kind: "committed", manifest: existing }
          : { kind: "conflict" };
      }
      throw error;
    }
  }
}

async function readManifest(
  database: Pick<PostgresDatabase, "select">,
  uploadId: string
): Promise<ContentManifestSummary | null> {
  const rows = await database.select({
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
  ).where(eq(schema.contentManifests.uploadId, uploadId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const { checkpointSequenceCutoff, ...manifest } = row;
  return {
    ...manifest,
    kind: manifest.kind as ContentKind,
    ...(checkpointSequenceCutoff === null ? {} : { checkpointSequenceCutoff }),
    sectionId: row.sectionId === row.noteId ? "root" : row.sectionId
  };
}

function reject(outcome: Exclude<ManifestCommitOutcome, { kind: "committed" }>): never {
  throw new CommitRejected(outcome);
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique|duplicate/iu.test(error.message);
}
