import { Router } from "express";
import { z } from "zod";
import { requireSessionAsync } from "../auth/session.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { withCanonicalTimestamps } from "../db/timestamps.js";
import { canonicalizeHandle } from "../auth/identity.js";

const sharingKeySchema = z.object({
  sharingKeyVersion: z.number().int().positive(),
  publicKey: z.string().min(32),
  encryptedPrivateKey: z.string().min(32),
  privateKeyNonce: z.string().min(16),
  formatVersion: z.literal(2)
});

export function createSharingKeysRouter(context: AppContext): Router {
  const router = Router();

  router.get("/current", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const row = await context.db.sharingKeys.current(session.userId);

    if (!row) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }

    response.json(withCanonicalTimestamps(row));
  });

  router.get("/versions/:version", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const version = z.coerce.number().int().positive().safeParse(request.params.version);
    if (!version.success) {
      sendApiError(response, "bad_request", "Invalid sharing key version");
      return;
    }

    const row = await context.db.sharingKeys.version(session.userId, version.data);

    if (!row) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }

    response.json(withCanonicalTimestamps(row));
  });

  router.put("/current", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = sharingKeySchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid sharing key payload");
      return;
    }

    const outcome = await context.db.sharingKeys.put(session.userId, parsed.data);
    if (outcome === "conflict") {
      sendApiError(response, "conflict", "Sharing key version already exists");
      return;
    }
    response.status(201).json({
      sharingKeyVersion: parsed.data.sharingKeyVersion
    });
  });

  router.post("/cleanup", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    response.json({ deleted: await context.db.sharingKeys.cleanup(session.userId) });
  });

  router.get("/lookup", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const username = z.string().min(1).max(128).safeParse(request.query.username);
    const canonicalHandle = username.success ? canonicalizeHandle(username.data) : null;
    if (!canonicalHandle) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }

    const row = await context.db.sharingKeys.lookup(canonicalHandle);

    if (!row) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }

    response.json({
      ...withCanonicalTimestamps(row),
      username: row.canonicalHandle,
      canonicalHandle: row.canonicalHandle
    });
  });

  return router;
}
