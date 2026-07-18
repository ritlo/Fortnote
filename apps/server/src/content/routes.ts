import { Router, type Response } from "express";
import { z } from "zod";
import { requireSession } from "../auth/session.js";
import { canEditNote, canReadNote, getNoteAccess } from "../notes/access.js";
import { ensureNoteSection } from "../notes/sections.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import {
  commitContentManifest,
  type ManifestCommitOutcome
} from "./manifests.js";
import {
  getStorageQuotaStatus,
  releaseStorageBytes,
  reserveStorageBytes
} from "./quota.js";
import {
  ContentChunkConflictError,
  deleteEncryptedContentChunk,
  deleteUncommittedContentUpload,
  readEncryptedContentChunk,
  writeEncryptedContentChunk
} from "./storage.js";

const UUID = z.uuid();
const HASH = z.string().regex(/^[0-9a-f]{64}$/u);
const SECTION_ID = z.union([z.literal("root"), UUID]);
const uploadBeginSchema = z
  .object({
    uploadId: UUID,
    updateId: UUID,
    noteId: UUID,
    sectionId: SECTION_ID,
    expectedKeyEpoch: z.number().int().positive(),
    kind: z.enum(["update", "checkpoint", "root-update"]),
    formatVersion: z.literal(2),
    totalCipherBytes: z.number().int().positive(),
    chunkCount: z.number().int().positive().max(1_000_000),
    manifestHash: HASH,
    checkpointSequenceCutoff: z.number().int().nonnegative().optional()
  })
  .superRefine((value, context) => {
    if (value.kind === "checkpoint" && value.checkpointSequenceCutoff === undefined) {
      context.addIssue({ code: "custom", message: "Checkpoint cutoff is required" });
    }
    if (value.kind !== "checkpoint" && value.checkpointSequenceCutoff !== undefined) {
      context.addIssue({ code: "custom", message: "Checkpoint cutoff is not allowed" });
    }
    if (value.chunkCount > value.totalCipherBytes) {
      context.addIssue({ code: "custom", message: "Chunk count exceeds ciphertext bytes" });
    }
  });
const commitSchema = z.object({
  requestId: UUID,
  updateId: UUID,
  expectedKeyEpoch: z.number().int().positive()
});

interface UploadRow {
  id: string;
  updateId: string;
  noteId: string;
  sectionId: string;
  cryptoOwnerId: string;
  keyEpoch: number;
  kind: "update" | "checkpoint" | "root-update";
  formatVersion: number;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
  checkpointSequenceCutoff: number | null;
  status: "receiving" | "complete" | "committed" | "aborted" | "expired" | "invalid";
  expiresAt: string;
  ownerUserId: string;
}

interface ChunkRow {
  chunkIndex: number;
  cipherLength: number;
  cipherHash: string;
  nonce: Buffer;
  fileCipherPath: string;
}

export function createContentRouter(context: AppContext): Router {
  const router = Router();

  router.post("/content/uploads", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const parsed = uploadBeginSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid content upload payload");
      return;
    }
    const payload = parsed.data;
    if (payload.totalCipherBytes > context.config.storageQuotaBytes) {
      sendApiError(response, "storage_limit", "Encrypted content exceeds storage quota");
      return;
    }
    const outcome = context.db.sqlite.transaction(() => {
      const access = getNoteAccess(context, payload.noteId, session.userId);
      if (!canEditNote(access)) {
        return { kind: "not-found" as const };
      }
      if (access.isDeleted) {
        return { kind: "conflict" as const };
      }
      const noteState = context.db.sqlite
        .prepare("SELECT rotation_fenced AS rotationFenced FROM notes WHERE id = ?")
        .get(access.noteId) as { rotationFenced: number };
      if (noteState.rotationFenced) {
        return { kind: "rotation-pending" as const };
      }
      if (access.keyEpoch !== payload.expectedKeyEpoch) {
        return { kind: "stale-epoch" as const };
      }
      const section = ensureNoteSection(
        context,
        payload.noteId,
        payload.sectionId,
        payload.expectedKeyEpoch
      );
      if (!section) {
        return { kind: "not-found" as const };
      }
      const existing = context.db.sqlite
        .prepare(`
          SELECT id FROM content_uploads WHERE id = ? OR update_id = ?
        `)
        .get(payload.uploadId, payload.updateId) as { id: string } | undefined;
      if (existing) {
        const upload = getUpload(context, existing.id);
        return upload && sameUpload(upload, payload, section.id)
          ? { kind: "existing" as const, upload }
          : { kind: "conflict" as const };
      }
      if (!reserveStorageBytes(
        context.db,
        access.ownerUserId,
        payload.totalCipherBytes,
        context.config.storageQuotaBytes
      )) {
        return { kind: "storage-limit" as const };
      }
      const expiresAt = new Date(
        Date.now() + context.config.contentUploadExpiryMs
      ).toISOString();
      context.db.sqlite
        .prepare(`
          INSERT INTO content_uploads (
            id, update_id, note_id, section_id, crypto_owner_id, key_epoch,
            kind, format_version, total_cipher_bytes, chunk_count, manifest_hash,
            checkpoint_sequence_cutoff, status, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receiving', ?)
        `)
        .run(
          payload.uploadId,
          payload.updateId,
          payload.noteId,
          section.id,
          access.cryptoOwnerId,
          payload.expectedKeyEpoch,
          payload.kind,
          payload.formatVersion,
          payload.totalCipherBytes,
          payload.chunkCount,
          payload.manifestHash,
          payload.checkpointSequenceCutoff ?? null,
          expiresAt
        );
      return { kind: "created" as const, upload: getUpload(context, payload.uploadId)! };
    })();
    if (outcome.kind === "created" || outcome.kind === "existing") {
      response.status(outcome.kind === "created" ? 201 : 200).json(uploadStatus(context, outcome.upload));
      return;
    }
    sendGateError(response, outcome.kind);
  });

  router.get("/content/uploads/:uploadId", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const upload = getUpload(context, request.params.uploadId);
    if (!upload || !canEditNote(getNoteAccess(context, upload.noteId, session.userId))) {
      sendApiError(response, "not_found", "Content upload not found");
      return;
    }
    expireUploadIfNeeded(context, upload);
    response.json(uploadStatus(context, getUpload(context, upload.id)!));
  });

  router.put("/content/uploads/:uploadId/chunks/:chunkIndex", async (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const upload = getUpload(context, request.params.uploadId);
    const chunkIndex = Number(request.params.chunkIndex);
    const cipherLength = declaredLength(request.get("content-length"));
    const cipherHash = request.get("x-fortnote-cipher-hash") ?? "";
    const nonce = decodeNonce(request.get("x-fortnote-nonce"));
    const initialAccess = upload
      ? getNoteAccess(context, upload.noteId, session.userId)
      : undefined;
    if (!upload || !canEditNote(initialAccess)) {
      sendApiError(response, "not_found", "Content upload not found");
      return;
    }
    const initialState = noteMutationState(context, upload.noteId);
    if (initialAccess.isDeleted || initialState?.isDeleted) {
      sendApiError(response, "conflict", "Restore note before uploading content");
      return;
    }
    if (initialState?.rotationFenced) {
      sendApiError(response, "rotation_pending", "Note-key rotation is pending");
      return;
    }
    if (initialAccess.keyEpoch !== upload.keyEpoch) {
      sendApiError(response, "stale_epoch", "Note key epoch changed");
      return;
    }
    if (
      !Number.isSafeInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= upload.chunkCount ||
      cipherLength === null ||
      cipherLength <= 0 ||
      cipherLength > context.config.contentChunkMaxBytes ||
      !/^[0-9a-f]{64}$/u.test(cipherHash) ||
      !nonce
    ) {
      sendApiError(response, "bad_request", "Invalid encrypted content chunk");
      return;
    }
    if (upload.status !== "receiving" && upload.status !== "complete") {
      sendApiError(response, "conflict", "Content upload is not receiving chunks");
      return;
    }
    const existing = getChunk(context, upload.id, chunkIndex);
    if (existing) {
      if (
        existing.cipherLength === cipherLength &&
        existing.cipherHash === cipherHash &&
        existing.nonce.equals(nonce)
      ) {
        response.status(204).send();
      } else {
        sendApiError(response, "chunk_conflict", "Conflicting encrypted chunk");
      }
      return;
    }
    try {
      const stored = await writeEncryptedContentChunk(context.config, {
        uploadId: upload.id,
        chunkIndex,
        expectedLength: cipherLength,
        expectedHash: cipherHash,
        maxBytes: context.config.contentChunkMaxBytes,
        source: request
      });
      const outcome = context.db.sqlite.transaction(() => {
        if (!activeSession(context, session.id)) {
          return "unauthorized" as const;
        }
        const current = getUpload(context, upload.id);
        const access = current
          ? getNoteAccess(context, current.noteId, session.userId)
          : undefined;
        if (!current || !canEditNote(access)) {
          return "not-found" as const;
        }
        const noteState = noteMutationState(context, current.noteId);
        if (access.isDeleted || noteState?.isDeleted) {
          return "conflict" as const;
        }
        if (noteState?.rotationFenced) {
          return "rotation-pending" as const;
        }
        if (access.keyEpoch !== current.keyEpoch || noteState?.keyEpoch !== current.keyEpoch) {
          return "stale-epoch" as const;
        }
        if (current.status !== "receiving" && current.status !== "complete") {
          return "conflict" as const;
        }
        const raced = getChunk(context, current.id, chunkIndex);
        if (raced) {
          return raced.cipherLength === cipherLength &&
            raced.cipherHash === cipherHash &&
            raced.nonce.equals(nonce)
            ? "stored" as const
            : "chunk-conflict" as const;
        }
        context.db.sqlite
          .prepare(`
            INSERT INTO content_chunks (
              upload_id, chunk_index, cipher_length, cipher_hash, file_cipher_path, nonce
            ) VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(current.id, chunkIndex, cipherLength, cipherHash, stored.fileCipherPath, nonce);
        const aggregate = contentAggregate(context, current.id);
        if (aggregate.bytes > current.totalCipherBytes) {
          context.db.sqlite
            .prepare("UPDATE content_uploads SET status = 'invalid' WHERE id = ?")
            .run(current.id);
          return "manifest-mismatch" as const;
        }
        if (
          aggregate.count === current.chunkCount &&
          aggregate.bytes === current.totalCipherBytes
        ) {
          context.db.sqlite
            .prepare(`
              UPDATE content_uploads
              SET status = 'complete', updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `)
            .run(current.id);
        }
        return "stored" as const;
      })();
      if (outcome === "stored") {
        response.status(204).send();
        return;
      }
      await deleteEncryptedContentChunk(context.config, upload.id, chunkIndex);
      sendChunkOutcome(response, outcome);
    } catch (error) {
      if (error instanceof ContentChunkConflictError) {
        sendApiError(response, "chunk_conflict", error.message);
        return;
      }
      if (error instanceof Error && /length|hash|maximum|exceeds/iu.test(error.message)) {
        sendApiError(response, "bad_request", error.message);
        return;
      }
      throw error;
    }
  });

  router.delete("/content/uploads/:uploadId", async (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const upload = getUpload(context, request.params.uploadId);
    if (!upload || !canEditNote(getNoteAccess(context, upload.noteId, session.userId))) {
      sendApiError(response, "not_found", "Content upload not found");
      return;
    }
    const aborted = context.db.sqlite.transaction(() => {
      const current = getUpload(context, upload.id);
      if (!current) {
        return false;
      }
      if (current.status === "committed") {
        return false;
      }
      if (reservesStorage(current.status)) {
        releaseStorageBytes(context.db, current.ownerUserId, current.totalCipherBytes);
        context.db.sqlite
          .prepare(`
            UPDATE content_uploads
            SET status = 'aborted', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .run(current.id);
      }
      return true;
    })();
    if (!aborted) {
      sendApiError(response, "conflict", "Committed content cannot be aborted");
      return;
    }
    await deleteUncommittedContentUpload(context.config, upload.id);
    response.status(204).send();
  });

  router.post("/content/uploads/:uploadId/commit", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const parsed = commitSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid manifest commit payload");
      return;
    }
    const outcome = commitContentManifest(context, {
      sessionId: session.id,
      userId: session.userId,
      uploadId: request.params.uploadId,
      ...parsed.data
    });
    if (outcome.kind === "committed") {
      response.status(201).json(outcome.manifest);
      return;
    }
    sendManifestOutcome(response, outcome);
  });

  router.get("/content/manifests/:manifestId/chunks/:chunkIndex", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const chunkIndex = Number(request.params.chunkIndex);
    const row = context.db.sqlite
      .prepare(`
        SELECT
          m.note_id AS noteId,
          m.upload_id AS uploadId,
          c.chunk_index AS chunkIndex,
          c.cipher_length AS cipherLength,
          c.cipher_hash AS cipherHash,
          c.nonce
        FROM content_manifests m
        JOIN content_chunks c ON c.upload_id = m.upload_id
        WHERE m.id = ? AND c.chunk_index = ?
      `)
      .get(request.params.manifestId, chunkIndex) as
        | {
            noteId: string;
            uploadId: string;
            chunkIndex: number;
            cipherLength: number;
            cipherHash: string;
            nonce: Buffer;
          }
        | undefined;
    if (!row || !canReadNote(getNoteAccess(context, row.noteId, session.userId))) {
      sendApiError(response, "not_found", "Content chunk not found");
      return;
    }
    response.status(200).set({
      "content-type": "application/octet-stream",
      "content-length": String(row.cipherLength),
      "x-fortnote-cipher-hash": row.cipherHash,
      "x-fortnote-nonce": row.nonce.toString("base64")
    });
    const stream = readEncryptedContentChunk(context.config, row.uploadId, row.chunkIndex);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });

  router.get("/content/quota", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    response.json(
      getStorageQuotaStatus(context.db, session.userId, context.config.storageQuotaBytes)
    );
  });

  return router;
}

function getUpload(context: AppContext, uploadId: string): UploadRow | null {
  return (context.db.sqlite
    .prepare(`
      SELECT
        u.id,
        u.update_id AS updateId,
        u.note_id AS noteId,
        u.section_id AS sectionId,
        u.crypto_owner_id AS cryptoOwnerId,
        u.key_epoch AS keyEpoch,
        u.kind,
        u.format_version AS formatVersion,
        u.total_cipher_bytes AS totalCipherBytes,
        u.chunk_count AS chunkCount,
        u.manifest_hash AS manifestHash,
        u.checkpoint_sequence_cutoff AS checkpointSequenceCutoff,
        u.status,
        u.expires_at AS expiresAt,
        n.user_id AS ownerUserId
      FROM content_uploads u
      JOIN notes n ON n.id = u.note_id
      WHERE u.id = ?
    `)
    .get(uploadId) as UploadRow | undefined) ?? null;
}

function getChunk(context: AppContext, uploadId: string, chunkIndex: number): ChunkRow | null {
  return (context.db.sqlite
    .prepare(`
      SELECT
        chunk_index AS chunkIndex,
        cipher_length AS cipherLength,
        cipher_hash AS cipherHash,
        nonce,
        file_cipher_path AS fileCipherPath
      FROM content_chunks
      WHERE upload_id = ? AND chunk_index = ?
    `)
    .get(uploadId, chunkIndex) as ChunkRow | undefined) ?? null;
}

function uploadStatus(context: AppContext, upload: UploadRow) {
  const chunks = context.db.sqlite
    .prepare(`
      SELECT chunk_index AS chunkIndex
      FROM content_chunks WHERE upload_id = ? ORDER BY chunk_index
    `)
    .all(upload.id) as { chunkIndex: number }[];
  return {
    uploadId: upload.id,
    status: upload.status,
    receivedChunkIndexes: chunks.map(({ chunkIndex }) => chunkIndex),
    reservedBytes:
      reservesStorage(upload.status)
        ? upload.totalCipherBytes
        : 0,
    expiresAt: upload.expiresAt
  };
}

function sameUpload(
  upload: UploadRow,
  payload: z.infer<typeof uploadBeginSchema>,
  storedSectionId: string
): boolean {
  return (
    upload.id === payload.uploadId &&
    upload.updateId === payload.updateId &&
    upload.noteId === payload.noteId &&
    upload.sectionId === storedSectionId &&
    upload.keyEpoch === payload.expectedKeyEpoch &&
    upload.kind === payload.kind &&
    upload.formatVersion === payload.formatVersion &&
    upload.totalCipherBytes === payload.totalCipherBytes &&
    upload.chunkCount === payload.chunkCount &&
    upload.manifestHash === payload.manifestHash &&
    upload.checkpointSequenceCutoff === (payload.checkpointSequenceCutoff ?? null)
  );
}

function contentAggregate(context: AppContext, uploadId: string): { count: number; bytes: number } {
  return context.db.sqlite
    .prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(cipher_length), 0) AS bytes
      FROM content_chunks WHERE upload_id = ?
    `)
    .get(uploadId) as { count: number; bytes: number };
}

function noteMutationState(
  context: AppContext,
  noteId: string
): { isDeleted: number; keyEpoch: number; rotationFenced: number } | null {
  return (
    (context.db.sqlite
      .prepare(`
        SELECT
          is_deleted AS isDeleted,
          key_epoch AS keyEpoch,
          rotation_fenced AS rotationFenced
        FROM notes WHERE id = ?
      `)
      .get(noteId) as
      | { isDeleted: number; keyEpoch: number; rotationFenced: number }
      | undefined) ?? null
  );
}

function expireUploadIfNeeded(context: AppContext, upload: UploadRow): void {
  if (
    !reservesStorage(upload.status) ||
    Date.parse(upload.expiresAt) > Date.now()
  ) {
    return;
  }
  context.db.sqlite.transaction(() => {
    const current = getUpload(context, upload.id);
    if (!current || !reservesStorage(current.status)) {
      return;
    }
    releaseStorageBytes(context.db, current.ownerUserId, current.totalCipherBytes);
    context.db.sqlite
      .prepare("UPDATE content_uploads SET status = 'expired' WHERE id = ?")
      .run(current.id);
  })();
}

function reservesStorage(status: UploadRow["status"]): boolean {
  return status === "receiving" || status === "complete" || status === "invalid";
}

function activeSession(context: AppContext, sessionId: string): boolean {
  const now = new Date().toISOString();
  return Boolean(
    context.db.sqlite
      .prepare(`
        SELECT id FROM sessions
        WHERE id = ? AND idle_expires_at > ? AND absolute_expires_at > ?
      `)
      .get(sessionId, now, now)
  );
}

function declaredLength(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value)) {
    return null;
  }
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

function decodeNonce(value: string | undefined): Buffer | null {
  if (!value) {
    return null;
  }
  const nonce = Buffer.from(value, "base64");
  return nonce.length === 24 && nonce.toString("base64") === value ? nonce : null;
}

function sendGateError(
  response: Response,
  kind: "not-found" | "conflict" | "rotation-pending" | "stale-epoch" | "storage-limit"
): void {
  const mapping = {
    "not-found": ["not_found", "Note not found"],
    conflict: ["conflict", "Content upload conflicts with note state"],
    "rotation-pending": ["rotation_pending", "Note-key rotation is pending"],
    "stale-epoch": ["stale_epoch", "Note key epoch changed"],
    "storage-limit": ["storage_limit", "Storage quota exceeded"]
  } as const;
  const [code, message] = mapping[kind];
  sendApiError(response, code, message);
}

function sendChunkOutcome(
  response: Response,
  outcome:
    | "unauthorized"
    | "not-found"
    | "stale-epoch"
    | "rotation-pending"
    | "conflict"
    | "chunk-conflict"
    | "manifest-mismatch"
): void {
  const mapping = {
    unauthorized: ["unauthorized", "Session expired"],
    "not-found": ["not_found", "Content upload not found"],
    "stale-epoch": ["stale_epoch", "Note key epoch changed"],
    "rotation-pending": ["rotation_pending", "Note-key rotation is pending"],
    conflict: ["conflict", "Content upload is no longer writable"],
    "chunk-conflict": ["chunk_conflict", "Conflicting encrypted chunk"],
    "manifest-mismatch": ["manifest_mismatch", "Encrypted content size mismatch"]
  } as const;
  const [code, message] = mapping[outcome];
  sendApiError(response, code, message);
}

function sendManifestOutcome(
  response: Response,
  outcome: Exclude<ManifestCommitOutcome, { kind: "committed" }>
): void {
  const mapping = {
    unauthorized: ["unauthorized", "Session expired"],
    "not-found": ["not_found", "Content upload not found"],
    conflict: ["conflict", "Content manifest conflicts with current state"],
    "rotation-pending": ["rotation_pending", "Note-key rotation is pending"],
    "stale-epoch": ["stale_epoch", "Note key epoch changed"],
    "chunk-missing": ["chunk_missing", "Encrypted content chunks are missing"],
    "manifest-mismatch": ["manifest_mismatch", "Encrypted content manifest mismatch"],
    "storage-limit": ["storage_limit", "Storage reservation is unavailable"]
  } as const;
  const [code, message] = mapping[outcome.kind];
  sendApiError(response, code, message);
}
