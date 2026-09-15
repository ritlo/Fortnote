import { Router, type Response } from "express";
import { z } from "zod";
import { requireSessionAsync } from "../auth/session.js";
import { canReadNote } from "../notes/access.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { canonicalTimestamp } from "../db/timestamps.js";
import type { ManifestCommitOutcome } from "./manifests.js";
import type {
  BeginContentUploadOutcome,
  ContentUploadRecord,
  ContentUploadView
} from "./uploadRepository/contracts.js";

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
      context.addIssue({
        code: "custom",
        message: "Chunk count exceeds ciphertext bytes"
      });
    }
  });
const commitSchema = z.object({
  requestId: UUID,
  updateId: UUID,
  expectedKeyEpoch: z.number().int().positive()
});

export function createContentRouter(context: AppContext): Router {
  const router = Router();

  router.post("/content/uploads", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
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
    const { checkpointSequenceCutoff, ...uploadInput } = payload;
    const outcome = await context.db.contentUploads.begin({
      sessionId: session.id,
      userId: session.userId,
      ...uploadInput,
      ...(checkpointSequenceCutoff === undefined ? {} : { checkpointSequenceCutoff }),
      expiresAt: new Date(
        Date.now() + context.config.contentUploadExpiryMs
      ).toISOString(),
      quotaBytes: context.config.storageQuotaBytes
    });
    if (outcome.kind === "created" || outcome.kind === "existing") {
      await cleanupUploadStorage(context, outcome);
      response.status(outcome.kind === "created" ? 201 : 200).json(uploadStatus(outcome));
      return;
    }
    sendGateError(response, outcome.kind);
  });

  router.get("/content/uploads/:uploadId", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }
    const view = await context.db.contentUploads.status(
      request.params.uploadId,
      session.userId,
      new Date().toISOString()
    );
    if (!view) {
      sendApiError(response, "not_found", "Content upload not found");
      return;
    }
    await cleanupUploadStorage(context, view);
    response.json(uploadStatus(view));
  });

  router.put(
    "/content/uploads/:uploadId/chunks/:chunkIndex",
    async (request, response) => {
      const session = await requireSessionAsync(context.db, request, response);
      if (!session) {
        return;
      }
      const upload = await context.db.contentUploads.findEditable(
        request.params.uploadId,
        session.userId
      );
      const chunkIndex = Number(request.params.chunkIndex);
      const cipherLength = declaredLength(request.get("content-length"));
      const cipherHash = request.get("x-fortnote-cipher-hash") ?? "";
      const nonce = decodeNonce(request.get("x-fortnote-nonce"));
      if (!upload) {
        sendApiError(response, "not_found", "Content upload not found");
        return;
      }
      if (upload.noteIsDeleted) {
        sendApiError(response, "conflict", "Restore note before uploading content");
        return;
      }
      if (upload.rotationFenced) {
        sendApiError(response, "rotation_pending", "Note-key rotation is pending");
        return;
      }
      if (upload.noteKeyEpoch !== upload.keyEpoch) {
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
      const existing = await context.db.contentUploads.findChunk(upload.id, chunkIndex);
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
        const stored = await context.db.contentStorage.write({
          uploadId: upload.id,
          chunkIndex,
          expectedLength: cipherLength,
          expectedHash: cipherHash,
          maxBytes: context.config.contentChunkMaxBytes,
          source: request
        });
        const outcome = await context.db.contentUploads.registerChunk({
          sessionId: session.id,
          userId: session.userId,
          uploadId: upload.id,
          chunkIndex,
          cipherLength,
          cipherHash,
          nonce,
          storageKey: stored.fileCipherPath
        });
        if (outcome === "stored") {
          response.status(204).send();
          return;
        }
        if (outcome === "raced") {
          if (stored.deleteOnMetadataRace) {
            await context.db.contentStorage.delete(stored.fileCipherPath);
          }
          response.status(204).send();
          return;
        }
        await context.db.contentStorage.delete(stored.fileCipherPath);
        sendChunkOutcome(response, outcome);
      } catch (error) {
        if (
          error instanceof Error &&
          /length|hash|maximum|exceeds/iu.test(error.message)
        ) {
          sendApiError(response, "bad_request", error.message);
          return;
        }
        throw error;
      }
    }
  );

  router.delete("/content/uploads/:uploadId", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }
    const aborted = await context.db.contentUploads.abort(
      request.params.uploadId,
      session.id,
      session.userId
    );
    if (aborted.kind !== "aborted") {
      const errors = {
        "not-found": ["not_found", "Content upload not found"],
        unauthorized: ["unauthorized", "Session expired"],
        conflict: ["conflict", "Committed content cannot be aborted"]
      } as const;
      const [code, message] = errors[aborted.kind];
      sendApiError(response, code, message);
      return;
    }
    await context.db.contentStorage.deleteUpload(
      request.params.uploadId,
      aborted.storageKeys
    );
    response.status(204).send();
  });

  router.post("/content/uploads/:uploadId/commit", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }
    const parsed = commitSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid manifest commit payload");
      return;
    }
    const outcome = await context.db.contentManifests.commit({
      sessionId: session.id,
      userId: session.userId,
      uploadId: request.params.uploadId,
      ...parsed.data
    });
    if (outcome.kind === "committed") {
      context.realtime?.publishContentManifest({
        type: "crdt-manifest",
        formatVersion: 2,
        noteId: outcome.manifest.noteId,
        sectionId: outcome.manifest.sectionId,
        keyEpoch: outcome.manifest.keyEpoch,
        updateId: outcome.manifest.updateId,
        manifestId: outcome.manifest.manifestId,
        uploadId: outcome.manifest.uploadId,
        cryptoOwnerId: outcome.manifest.cryptoOwnerId,
        kind: outcome.manifest.kind,
        totalCipherBytes: outcome.manifest.totalCipherBytes,
        chunkCount: outcome.manifest.chunkCount,
        manifestHash: outcome.manifest.manifestHash,
        ...(outcome.manifest.checkpointSequenceCutoff === undefined
          ? {}
          : {
              checkpointSequenceCutoff: outcome.manifest.checkpointSequenceCutoff
            }),
        serverSequence: outcome.manifest.firstSequence
      });
      response.status(201).json(outcome.manifest);
      return;
    }
    sendManifestOutcome(response, outcome);
  });

  router.get(
    "/content/manifests/:manifestId/chunks/:chunkIndex",
    async (request, response) => {
      const session = await requireSessionAsync(context.db, request, response);
      if (!session) {
        return;
      }
      const chunkIndex = Number(request.params.chunkIndex);
      const row = await context.db.contentUploads.findManifestChunk(
        request.params.manifestId,
        chunkIndex
      );
      const access = row
        ? await context.db.noteAccess.find(row.noteId, session.userId)
        : undefined;
      if (!row || !canReadNote(access)) {
        sendApiError(response, "not_found", "Content chunk not found");
        return;
      }
      response.status(200).set({
        "content-type": "application/octet-stream",
        "content-length": String(row.cipherLength),
        "x-fortnote-cipher-hash": row.cipherHash,
        "x-fortnote-nonce": row.nonce.toString("base64")
      });
      const stream = await context.db.contentStorage.read(row.storageKey);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    }
  );

  router.get("/content/quota", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }
    response.json(
      await context.db.contentUploads.quota(
        session.userId,
        context.config.storageQuotaBytes
      )
    );
  });

  return router;
}

function uploadStatus(view: ContentUploadView) {
  const { upload } = view;
  return {
    uploadId: upload.id,
    status: upload.status,
    receivedChunkIndexes: view.receivedChunkIndexes,
    reservedBytes: reservesStorage(upload.status) ? upload.totalCipherBytes : 0,
    expiresAt: canonicalTimestamp(upload.expiresAt)
  };
}

async function cleanupUploadStorage(
  context: AppContext,
  view:
    | ContentUploadView
    | Extract<BeginContentUploadOutcome, { kind: "created" | "existing" }>
): Promise<void> {
  if (view.cleanupStorageKeys.length > 0) {
    await context.db.contentStorage.deleteUpload(view.upload.id, view.cleanupStorageKeys);
  }
}

function reservesStorage(status: ContentUploadRecord["status"]): boolean {
  return status === "receiving" || status === "complete" || status === "invalid";
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
  kind:
    | "unauthorized"
    | "not-found"
    | "conflict"
    | "rotation-pending"
    | "stale-epoch"
    | "storage-limit"
): void {
  const mapping = {
    unauthorized: ["unauthorized", "Session expired"],
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
