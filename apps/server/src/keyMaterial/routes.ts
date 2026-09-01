import argon2 from "argon2";
import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import {
  createSqliteSessionInTransaction,
  deleteSqliteUserSessionsInTransaction,
  requireSession,
  setSessionCookie
} from "../auth/session.js";
import * as schema from "../db/schema.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";

const kdfParamsSchema = z.object({
  salt: z.string().min(16).max(128),
  opsLimit: z.number().int().positive().max(10),
  memLimit: z.number().int().positive().max(1024 * 1024 * 1024),
  version: z.number().int().positive().max(100)
});

const updateKeyMaterialSchema = z.object({
  newAuthVerifier: z.string().min(32).max(128).optional(),
  authKdf: kdfParamsSchema.optional(),
  encryptedRootKey: z.string().min(32).max(256),
  rootKeyNonce: z.string().min(16).max(128),
  rootKeyFormatVersion: z.number().int().min(1).max(2).optional(),
  rootKeyContextVersion: z.number().int().positive().optional(),
  vaultKdf: kdfParamsSchema,
  recoveryEncryptedRootKey: z.string().min(32).max(256).optional(),
  recoveryRootKeyNonce: z.string().min(16).max(128).optional(),
  recoveryRootKeyFormatVersion: z.number().int().min(1).max(2).optional(),
  recoveryRootKeyContextVersion: z.number().int().positive().optional(),
  recoveryAuthVerifier: z.string().min(32).max(128).optional(),
  recoveryKdf: kdfParamsSchema.optional(),
  keyMaterialVersion: z.number().int().positive()
});

class KeyMaterialVersionConflict extends Error {}

export function createKeyMaterialRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const row = context.db.orm
      .select({
        encryptedRootKey: schema.userKeyMaterial.encryptedRootKey,
        rootKeyNonce: schema.userKeyMaterial.rootKeyNonce,
        rootKeyFormatVersion: schema.userKeyMaterial.rootKeyFormatVersion,
        rootKeyContextVersion: schema.userKeyMaterial.rootKeyContextVersion,
        kdfSalt: schema.userKeyMaterial.kdfSalt,
        kdfOpsLimit: schema.userKeyMaterial.kdfOpsLimit,
        kdfMemLimit: schema.userKeyMaterial.kdfMemLimit,
        kdfVersion: schema.userKeyMaterial.kdfVersion,
        recoveryEncryptedRootKey: schema.userKeyMaterial.recoveryEncryptedRootKey,
        recoveryRootKeyNonce: schema.userKeyMaterial.recoveryRootKeyNonce,
        recoveryRootKeyFormatVersion:
          schema.userKeyMaterial.recoveryRootKeyFormatVersion,
        recoveryRootKeyContextVersion:
          schema.userKeyMaterial.recoveryRootKeyContextVersion,
        recoveryKdfSalt: schema.userKeyMaterial.recoveryKdfSalt,
        recoveryKdfOpsLimit: schema.userKeyMaterial.recoveryKdfOpsLimit,
        recoveryKdfMemLimit: schema.userKeyMaterial.recoveryKdfMemLimit,
        recoveryKdfVersion: schema.userKeyMaterial.recoveryKdfVersion,
        keyMaterialVersion: schema.userKeyMaterial.keyMaterialVersion
      })
      .from(schema.userKeyMaterial)
      .where(eq(schema.userKeyMaterial.userId, session.userId))
      .get();

    if (!row) {
      sendApiError(response, "not_found", "Key material not found");
      return;
    }

    response.json(row);
  });

  router.put("/", async (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = updateKeyMaterialSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid key material payload");
      return;
    }

    const current = context.db.orm
      .select({ keyMaterialVersion: schema.userKeyMaterial.keyMaterialVersion })
      .from(schema.userKeyMaterial)
      .where(eq(schema.userKeyMaterial.userId, session.userId))
      .get();

    if (!current) {
      sendApiError(response, "not_found", "Key material not found");
      return;
    }

    if (current.keyMaterialVersion !== parsed.data.keyMaterialVersion) {
      sendApiError(response, "conflict", "Key material version conflict");
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
      recoveryRootKeyNonce
    ].filter((value) => value !== undefined).length;
    if (recoveryFieldCount !== 0 && recoveryFieldCount !== 4) {
      sendApiError(response, "bad_request", "Incomplete recovery key payload");
      return;
    }

    if (
      (parsed.data.rootKeyFormatVersion === 2 &&
        parsed.data.rootKeyContextVersion === undefined) ||
      (recoveryRootKeyFormatVersion === 2 &&
        recoveryRootKeyContextVersion === undefined) ||
      ((recoveryRootKeyFormatVersion !== undefined ||
        recoveryRootKeyContextVersion !== undefined) &&
        recoveryFieldCount !== 4)
    ) {
      sendApiError(response, "bad_request", "Incomplete protected key context");
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

    let sessionRotation: {
      replacementToken: string | null;
      revokedSessionIds: string[];
    };
    try {
      sessionRotation = context.db.orm.transaction((tx) => {
        if (authKdf && newAuthVerifierHash) {
          tx.update(schema.users)
            .set({
              authVerifierHash: newAuthVerifierHash,
              authKdfSalt: authKdf.salt,
              authKdfOpsLimit: authKdf.opsLimit,
              authKdfMemLimit: authKdf.memLimit,
              authKdfVersion: authKdf.version,
              updatedAt: sql`CURRENT_TIMESTAMP`
            })
            .where(eq(schema.users.id, session.userId))
            .run();
        }
        const result = tx.update(schema.userKeyMaterial)
          .set({
            encryptedRootKey: parsed.data.encryptedRootKey,
            rootKeyNonce: parsed.data.rootKeyNonce,
            rootKeyFormatVersion: parsed.data.rootKeyFormatVersion ?? 1,
            rootKeyContextVersion:
              parsed.data.rootKeyContextVersion ?? current.keyMaterialVersion + 1,
            kdfSalt: parsed.data.vaultKdf.salt,
            kdfOpsLimit: parsed.data.vaultKdf.opsLimit,
            kdfMemLimit: parsed.data.vaultKdf.memLimit,
            kdfVersion: parsed.data.vaultKdf.version,
            recoveryEncryptedRootKey,
            recoveryRootKeyNonce,
            recoveryRootKeyFormatVersion:
              recoveryFieldCount === 4 ? (recoveryRootKeyFormatVersion ?? 1) : undefined,
            recoveryRootKeyContextVersion:
              recoveryFieldCount === 4
                ? (recoveryRootKeyContextVersion ?? current.keyMaterialVersion + 1)
                : undefined,
            recoveryAuthVerifierHash: recoveryAuthVerifierHash ?? undefined,
            recoveryKdfSalt: recoveryKdf?.salt,
            recoveryKdfOpsLimit: recoveryKdf?.opsLimit,
            recoveryKdfMemLimit: recoveryKdf?.memLimit,
            recoveryKdfVersion: recoveryKdf?.version,
            keyMaterialVersion: sql`${schema.userKeyMaterial.keyMaterialVersion} + 1`,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(and(
            eq(schema.userKeyMaterial.userId, session.userId),
            eq(schema.userKeyMaterial.keyMaterialVersion, parsed.data.keyMaterialVersion)
          ))
          .run();
        if (result.changes !== 1) {
          throw new KeyMaterialVersionConflict();
        }
        if (!newAuthVerifierHash) {
          return { replacementToken: null, revokedSessionIds: [] as string[] };
        }
        const revokedSessionIds = deleteSqliteUserSessionsInTransaction(
          context.db,
          session.userId,
          tx
        );
        return {
          replacementToken: createSqliteSessionInTransaction(
            context.db,
            session.userId,
            tx
          ),
          revokedSessionIds
        };
      });
    } catch (error) {
      if (error instanceof KeyMaterialVersionConflict) {
        sendApiError(response, "conflict", "Key material version conflict");
        return;
      }
      throw error;
    }

    for (const sessionId of sessionRotation.revokedSessionIds) {
      context.realtime?.closeSession(sessionId);
    }
    if (sessionRotation.replacementToken !== null) {
      setSessionCookie(response, sessionRotation.replacementToken, context.config.cookieSecure);
    }

    response.json({ keyMaterialVersion: current.keyMaterialVersion + 1 });
  });

  return router;
}
