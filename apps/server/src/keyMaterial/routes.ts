import argon2 from "argon2";
import { Router } from "express";
import { z } from "zod";
import { requireSessionAsync, setSessionCookie } from "../auth/session.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";

const kdfParamsSchema = z.object({
  salt: z.string().min(16).max(128),
  opsLimit: z.number().int().positive().max(10),
  memLimit: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024 * 1024),
  version: z.number().int().positive().max(100)
});

const updateKeyMaterialSchema = z.object({
  newAuthVerifier: z.string().min(32).max(128).optional(),
  authKdf: kdfParamsSchema.optional(),
  encryptedRootKey: z.string().min(32).max(256),
  rootKeyNonce: z.string().min(16).max(128),
  rootKeyFormatVersion: z.literal(2),
  rootKeyContextVersion: z.number().int().positive(),
  vaultKdf: kdfParamsSchema,
  recoveryEncryptedRootKey: z.string().min(32).max(256).optional(),
  recoveryRootKeyNonce: z.string().min(16).max(128).optional(),
  recoveryRootKeyFormatVersion: z.literal(2).optional(),
  recoveryRootKeyContextVersion: z.number().int().positive().optional(),
  recoveryAuthVerifier: z.string().min(32).max(128).optional(),
  recoveryKdf: kdfParamsSchema.optional(),
  keyMaterialVersion: z.number().int().positive()
});

export function createKeyMaterialRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const row = await context.db.accounts.keyMaterial(session.userId);

    if (!row) {
      sendApiError(response, "not_found", "Key material not found");
      return;
    }

    response.json(row);
  });

  router.put("/", async (request, response) => {
    const session = await requireSessionAsync(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = updateKeyMaterialSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid key material payload");
      return;
    }

    const {
      authKdf,
      newAuthVerifier,
      recoveryAuthVerifier,
      recoveryEncryptedRootKey,
      recoveryKdf,
      recoveryRootKeyContextVersion,
      recoveryRootKeyFormatVersion,
      recoveryRootKeyNonce
    } = parsed.data;

    const recoveryFieldCount = [
      recoveryAuthVerifier,
      recoveryEncryptedRootKey,
      recoveryKdf,
      recoveryRootKeyNonce,
      recoveryRootKeyFormatVersion,
      recoveryRootKeyContextVersion
    ].filter((value) => value !== undefined).length;
    if (recoveryFieldCount !== 0 && recoveryFieldCount !== 6) {
      sendApiError(response, "bad_request", "Incomplete recovery key payload");
      return;
    }

    if ((authKdf && !newAuthVerifier) || (!authKdf && newAuthVerifier)) {
      sendApiError(response, "bad_request", "Incomplete auth verifier payload");
      return;
    }

    const newAuthVerifierHash = newAuthVerifier
      ? await argon2.hash(newAuthVerifier)
      : null;
    const recoveryAuthVerifierHash = recoveryAuthVerifier
      ? await argon2.hash(recoveryAuthVerifier)
      : null;

    const sessionRotation = await context.db.accounts.rotateKeyMaterial({
      userId: session.userId,
      expectedKeyMaterialVersion: parsed.data.keyMaterialVersion,
      encryptedRootKey: parsed.data.encryptedRootKey,
      rootKeyNonce: parsed.data.rootKeyNonce,
      rootKeyFormatVersion: parsed.data.rootKeyFormatVersion,
      rootKeyContextVersion: parsed.data.rootKeyContextVersion,
      vaultKdf: parsed.data.vaultKdf,
      ...(authKdf && newAuthVerifierHash
        ? { auth: { verifierHash: newAuthVerifierHash, kdf: authKdf } }
        : {}),
      ...(recoveryEncryptedRootKey &&
      recoveryRootKeyNonce &&
      recoveryRootKeyFormatVersion &&
      recoveryRootKeyContextVersion &&
      recoveryAuthVerifierHash &&
      recoveryKdf
        ? {
            recovery: {
              encryptedRootKey: recoveryEncryptedRootKey,
              rootKeyNonce: recoveryRootKeyNonce,
              rootKeyFormatVersion: recoveryRootKeyFormatVersion,
              rootKeyContextVersion: recoveryRootKeyContextVersion,
              verifierHash: recoveryAuthVerifierHash,
              kdf: recoveryKdf
            }
          }
        : {})
    });
    if (sessionRotation.kind === "not-found") {
      sendApiError(response, "not_found", "Key material not found");
      return;
    }
    if (sessionRotation.kind === "conflict") {
      sendApiError(response, "conflict", "Key material version conflict");
      return;
    }

    for (const sessionId of sessionRotation.revokedSessionIds) {
      context.realtime?.closeSession(sessionId);
    }
    if (sessionRotation.replacementToken !== null) {
      setSessionCookie(
        response,
        sessionRotation.replacementToken,
        context.config.cookieSecure
      );
    }

    response.json({ keyMaterialVersion: sessionRotation.keyMaterialVersion });
  });

  return router;
}
