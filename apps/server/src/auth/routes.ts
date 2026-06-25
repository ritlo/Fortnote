import argon2 from "argon2";
import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  findSession,
  readSessionToken,
  setSessionCookie
} from "./session.js";

const kdfParamsSchema = z.object({
  salt: z.string().min(16),
  opsLimit: z.number().int().positive(),
  memLimit: z.number().int().positive(),
  version: z.number().int().positive()
});

const registerSchema = z.object({
  username: z.string().min(3).max(64),
  authVerifier: z.string().min(32),
  authKdf: kdfParamsSchema,
  vaultKdf: kdfParamsSchema,
  encryptedRootKey: z.string().min(32),
  rootKeyNonce: z.string().min(16),
  recoveryAuthVerifier: z.string().min(32),
  recoveryKdf: kdfParamsSchema,
  recoveryEncryptedRootKey: z.string().min(32),
  recoveryRootKeyNonce: z.string().min(16)
});

const loginSchema = z.object({
  username: z.string().min(1),
  authVerifier: z.string().min(32)
});

const recoverSchema = z.object({
  username: z.string().min(1),
  recoveryAuthVerifier: z.string().min(32),
  newAuthVerifier: z.string().min(32),
  authKdf: kdfParamsSchema,
  vaultKdf: kdfParamsSchema,
  encryptedRootKey: z.string().min(32),
  rootKeyNonce: z.string().min(16),
  keyMaterialVersion: z.number().int().positive()
});

export function createAuthRouter(context: AppContext): Router {
  const router = Router();

  router.get("/kdf-params", (request, response) => {
    const username = z.string().min(1).safeParse(request.query.username);
    if (!username.success) {
      sendApiError(response, "bad_request", "Username is required");
      return;
    }

    const row = context.db.sqlite
      .prepare(
        `SELECT users.auth_kdf_salt AS authKdfSalt,
                users.auth_kdf_ops_limit AS authKdfOpsLimit,
                users.auth_kdf_mem_limit AS authKdfMemLimit,
                users.auth_kdf_version AS authKdfVersion,
                user_key_material.kdf_salt AS vaultKdfSalt,
                user_key_material.kdf_ops_limit AS vaultKdfOpsLimit,
                user_key_material.kdf_mem_limit AS vaultKdfMemLimit,
                user_key_material.kdf_version AS vaultKdfVersion
         FROM users
         JOIN user_key_material ON user_key_material.user_id = users.id
         WHERE users.username = ?`
      )
      .get(username.data);

    if (!row) {
      sendApiError(response, "not_found", "Account not found");
      return;
    }

    response.json(row);
  });

  router.post("/register", async (request, response) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid registration payload");
      return;
    }

    const userId = crypto.randomUUID();
    const authVerifierHash = await argon2.hash(parsed.data.authVerifier);
    const recoveryAuthVerifierHash = await argon2.hash(
      parsed.data.recoveryAuthVerifier
    );

    try {
      const insert = context.db.sqlite.transaction(() => {
        context.db.sqlite
          .prepare(
            `INSERT INTO users (
              id,
              username,
              auth_verifier_hash,
              auth_kdf_salt,
              auth_kdf_ops_limit,
              auth_kdf_mem_limit,
              auth_kdf_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            userId,
            parsed.data.username,
            authVerifierHash,
            parsed.data.authKdf.salt,
            parsed.data.authKdf.opsLimit,
            parsed.data.authKdf.memLimit,
            parsed.data.authKdf.version
          );

        context.db.sqlite
          .prepare(
            `INSERT INTO user_key_material (
              user_id,
              encrypted_root_key,
              root_key_nonce,
              kdf_salt,
              kdf_ops_limit,
              kdf_mem_limit,
              kdf_version,
              recovery_encrypted_root_key,
              recovery_root_key_nonce,
              recovery_auth_verifier_hash,
              recovery_kdf_salt,
              recovery_kdf_ops_limit,
              recovery_kdf_mem_limit,
              recovery_kdf_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            userId,
            parsed.data.encryptedRootKey,
            parsed.data.rootKeyNonce,
            parsed.data.vaultKdf.salt,
            parsed.data.vaultKdf.opsLimit,
            parsed.data.vaultKdf.memLimit,
            parsed.data.vaultKdf.version,
            parsed.data.recoveryEncryptedRootKey,
            parsed.data.recoveryRootKeyNonce,
            recoveryAuthVerifierHash,
            parsed.data.recoveryKdf.salt,
            parsed.data.recoveryKdf.opsLimit,
            parsed.data.recoveryKdf.memLimit,
            parsed.data.recoveryKdf.version
          );
      });
      insert();
    } catch {
      sendApiError(response, "conflict", "Username is already registered");
      return;
    }

    const token = createSession(context.db, userId);
    setSessionCookie(response, token, context.config.cookieSecure);
    response.status(201).json({ id: userId, username: parsed.data.username });
  });

  router.post("/login", async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid login payload");
      return;
    }

    const row = context.db.sqlite
      .prepare("SELECT id, auth_verifier_hash AS authVerifierHash FROM users WHERE username = ?")
      .get(parsed.data.username) as
      | { id: string; authVerifierHash: string }
      | undefined;

    if (!row || !(await argon2.verify(row.authVerifierHash, parsed.data.authVerifier))) {
      sendApiError(response, "unauthorized", "Invalid username or password");
      return;
    }

    const token = createSession(context.db, row.id);
    setSessionCookie(response, token, context.config.cookieSecure);
    response.json({ id: row.id, username: parsed.data.username });
  });

  router.post("/recover", async (request, response) => {
    const parsed = recoverSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid recovery payload");
      return;
    }

    const row = context.db.sqlite
      .prepare(
        `SELECT users.id,
                user_key_material.recovery_auth_verifier_hash AS recoveryAuthVerifierHash,
                user_key_material.key_material_version AS keyMaterialVersion
         FROM users
         JOIN user_key_material ON user_key_material.user_id = users.id
         WHERE users.username = ?`
      )
      .get(parsed.data.username) as
      | {
          id: string;
          recoveryAuthVerifierHash: string;
          keyMaterialVersion: number;
        }
      | undefined;

    if (!row) {
      sendApiError(response, "unauthorized", "Invalid recovery key");
      return;
    }

    if (
      row.keyMaterialVersion !== parsed.data.keyMaterialVersion ||
      !(await argon2.verify(
        row.recoveryAuthVerifierHash,
        parsed.data.recoveryAuthVerifier
      ))
    ) {
      sendApiError(response, "unauthorized", "Invalid recovery key");
      return;
    }

    const newAuthVerifierHash = await argon2.hash(parsed.data.newAuthVerifier);
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
        parsed.data.authKdf.salt,
        parsed.data.authKdf.opsLimit,
        parsed.data.authKdf.memLimit,
        parsed.data.authKdf.version,
        row.id
      );

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
        row.id
      );

    const token = createSession(context.db, row.id);
    setSessionCookie(response, token, context.config.cookieSecure);
    response.json({ id: row.id, username: parsed.data.username });
  });

  router.post("/logout", (request, response) => {
    const token = readSessionToken(request.get("cookie"));
    deleteSession(context.db, token);
    clearSessionCookie(response, context.config.cookieSecure);
    response.status(204).send();
  });

  router.get("/me", (request, response) => {
    const session = findSession(context.db, readSessionToken(request.get("cookie")));
    if (!session) {
      sendApiError(response, "unauthorized", "Not signed in");
      return;
    }

    response.json({ id: session.userId, username: session.username });
  });

  return router;
}
