import argon2 from "argon2";
import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../auth/session.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";

const kdfParamsSchema = z.object({
  salt: z.string().min(16),
  opsLimit: z.number().int().positive(),
  memLimit: z.number().int().positive(),
  version: z.number().int().positive()
});

const updateKeyMaterialSchema = z.object({
  newAuthVerifier: z.string().min(32).optional(),
  authKdf: kdfParamsSchema.optional(),
  encryptedRootKey: z.string().min(32),
  rootKeyNonce: z.string().min(16),
  vaultKdf: kdfParamsSchema,
  recoveryEncryptedRootKey: z.string().min(32).optional(),
  recoveryRootKeyNonce: z.string().min(16).optional(),
  recoveryAuthVerifier: z.string().min(32).optional(),
  recoveryKdf: kdfParamsSchema.optional(),
  keyMaterialVersion: z.number().int().positive()
});

export function createKeyMaterialRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const row = context.db.sqlite
      .prepare(
        `SELECT encrypted_root_key AS encryptedRootKey,
                root_key_nonce AS rootKeyNonce,
                kdf_salt AS kdfSalt,
                kdf_ops_limit AS kdfOpsLimit,
                kdf_mem_limit AS kdfMemLimit,
                kdf_version AS kdfVersion,
                recovery_encrypted_root_key AS recoveryEncryptedRootKey,
                recovery_root_key_nonce AS recoveryRootKeyNonce,
                recovery_kdf_salt AS recoveryKdfSalt,
                recovery_kdf_ops_limit AS recoveryKdfOpsLimit,
                recovery_kdf_mem_limit AS recoveryKdfMemLimit,
                recovery_kdf_version AS recoveryKdfVersion,
                key_material_version AS keyMaterialVersion
         FROM user_key_material
         WHERE user_id = ?`
      )
      .get(session.userId);

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

    const current = context.db.sqlite
      .prepare(
        `SELECT key_material_version AS keyMaterialVersion
         FROM user_key_material
         WHERE user_id = ?`
      )
      .get(session.userId) as { keyMaterialVersion: number } | undefined;

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
      recoveryRootKeyNonce
    } = parsed.data;

    if ((authKdf && !newAuthVerifier) || (!authKdf && newAuthVerifier)) {
      sendApiError(response, "bad_request", "Incomplete auth verifier payload");
      return;
    }

    const newAuthVerifierHash = newAuthVerifier
      ? await argon2.hash(newAuthVerifier)
      : null;

    const updateUserAuth = () => {
      if (!authKdf || !newAuthVerifierHash) {
        return;
      }

      context.db.sqlite
        .prepare(
          `UPDATE users
           SET auth_verifier_hash = ?,
               auth_kdf_salt = ?,
               auth_kdf_ops_limit = ?,
               auth_kdf_mem_limit = ?,
               auth_kdf_version = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(
          newAuthVerifierHash,
          authKdf.salt,
          authKdf.opsLimit,
          authKdf.memLimit,
          authKdf.version,
          session.userId
        );
    };

    if (
      recoveryEncryptedRootKey &&
      recoveryRootKeyNonce &&
      recoveryAuthVerifier &&
      recoveryKdf
    ) {
      const recoveryAuthVerifierHash = await argon2.hash(recoveryAuthVerifier);

      const update = context.db.sqlite.transaction(() => {
        updateUserAuth();
        context.db.sqlite
        .prepare(
          `UPDATE user_key_material
           SET encrypted_root_key = ?,
               root_key_nonce = ?,
               kdf_salt = ?,
               kdf_ops_limit = ?,
               kdf_mem_limit = ?,
               kdf_version = ?,
               recovery_encrypted_root_key = ?,
               recovery_root_key_nonce = ?,
               recovery_auth_verifier_hash = ?,
               recovery_kdf_salt = ?,
               recovery_kdf_ops_limit = ?,
               recovery_kdf_mem_limit = ?,
               recovery_kdf_version = ?,
               key_material_version = key_material_version + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ?`
        )
        .run(
          parsed.data.encryptedRootKey,
          parsed.data.rootKeyNonce,
          parsed.data.vaultKdf.salt,
          parsed.data.vaultKdf.opsLimit,
          parsed.data.vaultKdf.memLimit,
          parsed.data.vaultKdf.version,
          recoveryEncryptedRootKey,
          recoveryRootKeyNonce,
          recoveryAuthVerifierHash,
          recoveryKdf.salt,
          recoveryKdf.opsLimit,
          recoveryKdf.memLimit,
          recoveryKdf.version,
          session.userId
        );
      });
      update();
    } else {
      const update = context.db.sqlite.transaction(() => {
        updateUserAuth();
        context.db.sqlite
        .prepare(
          `UPDATE user_key_material
           SET encrypted_root_key = ?,
               root_key_nonce = ?,
               kdf_salt = ?,
               kdf_ops_limit = ?,
               kdf_mem_limit = ?,
               kdf_version = ?,
               key_material_version = key_material_version + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ?`
        )
        .run(
          parsed.data.encryptedRootKey,
          parsed.data.rootKeyNonce,
          parsed.data.vaultKdf.salt,
          parsed.data.vaultKdf.opsLimit,
          parsed.data.vaultKdf.memLimit,
          parsed.data.vaultKdf.version,
          session.userId
        );
      });
      update();
    }

    response.json({ keyMaterialVersion: current.keyMaterialVersion + 1 });
  });

  return router;
}
