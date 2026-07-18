import { createHash } from "node:crypto";
import type { AppContext } from "../http/app.js";
import { commitStorageBytes } from "./quota.js";

export type ContentKind = "update" | "checkpoint" | "root-update";

export interface ContentManifestSummary {
  manifestId: string;
  uploadId: string;
  updateId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  kind: ContentKind;
  firstSequence: number;
  lastSequence: number;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
}

export type ManifestCommitOutcome =
  | { kind: "committed"; manifest: ContentManifestSummary }
  | {
      kind:
        | "unauthorized"
        | "not-found"
        | "conflict"
        | "rotation-pending"
        | "stale-epoch"
        | "chunk-missing"
        | "manifest-mismatch"
        | "storage-limit";
    };

interface CommitInput {
  sessionId: string;
  userId: string;
  uploadId: string;
  requestId: string;
  updateId: string;
  expectedKeyEpoch: number;
}

interface AccessRow {
  noteId: string;
  ownerUserId: string;
  keyEpoch: number;
  rotationFenced: number;
  isDeleted: number;
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

export interface ContentChunkDescriptor {
  chunkIndex: number;
  cipherLength: number;
  cipherHash: string;
  nonce: Buffer;
}

class CommitRejected extends Error {
  constructor(readonly outcome: Exclude<ManifestCommitOutcome, { kind: "committed" }>) {
    super(outcome.kind);
  }
}

export function commitContentManifest(
  context: AppContext,
  input: CommitInput
): ManifestCommitOutcome {
  try {
    return context.db.sqlite.transaction((): ManifestCommitOutcome => {
      const activeSession = context.db.sqlite
        .prepare(`
          SELECT id FROM sessions
          WHERE id = ? AND idle_expires_at > ? AND absolute_expires_at > ?
        `)
        .get(input.sessionId, nowIso(), nowIso());
      if (!activeSession) {
        reject({ kind: "unauthorized" });
      }
      const upload = context.db.sqlite
        .prepare(`
          SELECT
            id,
            update_id AS updateId,
            note_id AS noteId,
            section_id AS sectionId,
            crypto_owner_id AS cryptoOwnerId,
            key_epoch AS keyEpoch,
            kind,
            format_version AS formatVersion,
            total_cipher_bytes AS totalCipherBytes,
            chunk_count AS chunkCount,
            manifest_hash AS manifestHash,
            checkpoint_sequence_cutoff AS checkpointSequenceCutoff,
            status
          FROM content_uploads
          WHERE id = ?
        `)
        .get(input.uploadId) as UploadRow | undefined;
      if (!upload) {
        reject({ kind: "not-found" });
      }
      const access = getAccess(context, upload.noteId, input.userId);
      if (!canEdit(access)) {
        reject({ kind: "not-found" });
      }
      if (access.isDeleted) {
        reject({ kind: "conflict" });
      }
      if (access.rotationFenced) {
        reject({ kind: "rotation-pending" });
      }
      if (
        upload.updateId !== input.updateId ||
        upload.keyEpoch !== input.expectedKeyEpoch ||
        access.keyEpoch !== input.expectedKeyEpoch
      ) {
        reject({ kind: "stale-epoch" });
      }
      const existing = existingManifest(context, upload.id);
      if (existing) {
        return { kind: "committed", manifest: existing };
      }
      if (upload.status !== "complete") {
        reject({ kind: "chunk-missing" });
      }
      const chunks = context.db.sqlite
        .prepare(`
          SELECT
            chunk_index AS chunkIndex,
            cipher_length AS cipherLength,
            cipher_hash AS cipherHash,
            nonce
          FROM content_chunks
          WHERE upload_id = ?
          ORDER BY chunk_index
        `)
        .all(upload.id) as ContentChunkDescriptor[];
      if (
        chunks.length !== upload.chunkCount ||
        chunks.some((chunk, index) => chunk.chunkIndex !== index) ||
        chunks.reduce((total, chunk) => total + chunk.cipherLength, 0) !==
          upload.totalCipherBytes
      ) {
        reject({ kind: "chunk-missing" });
      }
      if (contentManifestHash(chunks) !== upload.manifestHash) {
        reject({ kind: "manifest-mismatch" });
      }
      const section = context.db.sqlite
        .prepare(`
          SELECT current_sequence AS currentSequence
          FROM note_sections
          WHERE id = ? AND note_id = ? AND is_deleted = 0
        `)
        .get(upload.sectionId, upload.noteId) as { currentSequence: number } | undefined;
      if (!section) {
        reject({ kind: "not-found" });
      }
      if (
        upload.kind === "checkpoint" &&
        (upload.checkpointSequenceCutoff === null ||
          upload.checkpointSequenceCutoff > section.currentSequence)
      ) {
        reject({ kind: "conflict" });
      }
      const sequence = section.currentSequence + 1;
      context.db.sqlite
        .prepare(`
          INSERT INTO content_manifests (
            id, upload_id, update_id, note_id, section_id, key_epoch, kind,
            format_version, first_sequence, last_sequence, total_cipher_bytes,
            chunk_count, manifest_hash, checkpoint_sequence_cutoff
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.requestId,
          upload.id,
          upload.updateId,
          upload.noteId,
          upload.sectionId,
          upload.keyEpoch,
          upload.kind,
          upload.formatVersion,
          sequence,
          sequence,
          upload.totalCipherBytes,
          upload.chunkCount,
          upload.manifestHash,
          upload.checkpointSequenceCutoff
        );
      context.db.sqlite
        .prepare(`
          INSERT INTO section_updates (
            update_id, note_id, section_id, server_sequence, crypto_owner_id,
            key_epoch, format_version, kind, checkpoint_sequence_cutoff, manifest_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          upload.updateId,
          upload.noteId,
          upload.sectionId,
          sequence,
          upload.cryptoOwnerId,
          upload.keyEpoch,
          upload.formatVersion,
          upload.kind,
          upload.checkpointSequenceCutoff,
          input.requestId
        );
      context.db.sqlite
        .prepare(`
          UPDATE note_sections
          SET current_sequence = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND note_id = ?
        `)
        .run(sequence, upload.sectionId, upload.noteId);
      if (upload.kind === "checkpoint" && upload.checkpointSequenceCutoff !== null) {
        context.db.sqlite
          .prepare(`
            DELETE FROM section_updates
            WHERE note_id = ? AND section_id = ? AND key_epoch = ?
              AND server_sequence <= ? AND update_id <> ?
          `)
          .run(
            upload.noteId,
            upload.sectionId,
            upload.keyEpoch,
            upload.checkpointSequenceCutoff,
            upload.updateId
          );
      }
      if (!commitStorageBytes(
        context.db,
        access.ownerUserId,
        upload.totalCipherBytes
      )) {
        reject({ kind: "storage-limit" });
      }
      context.db.sqlite
        .prepare(`
          UPDATE content_uploads
          SET status = 'committed', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(upload.id);
      const manifest = existingManifest(context, upload.id);
      if (!manifest) {
        throw new Error("Committed content manifest was not readable");
      }
      return { kind: "committed", manifest };
    })();
  } catch (error) {
    if (error instanceof CommitRejected) {
      return error.outcome;
    }
    if (isConstraintError(error)) {
      const existing = existingManifest(context, input.uploadId);
      return existing
        ? { kind: "committed", manifest: existing }
        : { kind: "conflict" };
    }
    throw error;
  }
}

export function contentManifestHash(chunks: ContentChunkDescriptor[]): string {
  const hash = createHash("sha256");
  for (const chunk of [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex)) {
    hash.update(
      `${String(chunk.chunkIndex)}:${String(chunk.cipherLength)}:${chunk.cipherHash}:${chunk.nonce.toString("base64")}\n`
    );
  }
  return hash.digest("hex");
}

function existingManifest(
  context: AppContext,
  uploadId: string
): ContentManifestSummary | null {
  const row = context.db.sqlite
    .prepare(`
      SELECT
        id AS manifestId,
        upload_id AS uploadId,
        update_id AS updateId,
        note_id AS noteId,
        section_id AS sectionId,
        key_epoch AS keyEpoch,
        kind,
        first_sequence AS firstSequence,
        last_sequence AS lastSequence,
        total_cipher_bytes AS totalCipherBytes,
        chunk_count AS chunkCount,
        manifest_hash AS manifestHash
      FROM content_manifests
      WHERE upload_id = ?
    `)
    .get(uploadId) as ContentManifestSummary | undefined;
  if (!row) {
    return null;
  }
  return {
    ...row,
    sectionId: row.sectionId === row.noteId ? "root" : row.sectionId
  };
}

function getAccess(context: AppContext, noteId: string, userId: string): AccessRow | undefined {
  return context.db.sqlite
    .prepare(`
      SELECT
        n.id AS noteId,
        n.user_id AS ownerUserId,
        n.key_epoch AS keyEpoch,
        n.rotation_fenced AS rotationFenced,
        n.is_deleted AS isDeleted,
        m.role,
        m.status AS membershipStatus
      FROM notes n
      JOIN note_memberships m ON m.note_id = n.id
      WHERE n.id = ? AND m.user_id = ?
    `)
    .get(noteId, userId) as AccessRow | undefined;
}

function canEdit(access: AccessRow | undefined): access is AccessRow {
  return (
    access?.membershipStatus === "active" &&
    (access.role === "owner" || access.role === "editor")
  );
}

function reject(outcome: Exclude<ManifestCommitOutcome, { kind: "committed" }>): never {
  throw new CommitRejected(outcome);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/iu.test(error.message);
}
