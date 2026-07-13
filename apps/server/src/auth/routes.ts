import argon2 from "argon2";
import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { DEFAULT_KDF } from "@fortnote/shared";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  deleteUserSessions,
  findSession,
  readSessionToken,
  setSessionCookie
} from "./session.js";

const kdfParamsSchema = z.object({
  salt: z.string().min(16).max(128),
  opsLimit: z.number().int().positive().max(10),
  memLimit: z.number().int().positive().max(1024 * 1024 * 1024),
  version: z.number().int().positive().max(100)
});

const verifierSchema = z.string().min(32).max(128);
const encryptedKeySchema = z.string().min(32).max(256);
const nonceSchema = z.string().min(16).max(128);
const usernameSchema = z.string().min(1).max(64);

const registerSchema = z.object({
  username: z.string().min(3).max(64),
  authVerifier: verifierSchema,
  authKdf: kdfParamsSchema,
  vaultKdf: kdfParamsSchema,
  encryptedRootKey: encryptedKeySchema,
  rootKeyNonce: nonceSchema,
  recoveryAuthVerifier: verifierSchema,
  recoveryKdf: kdfParamsSchema,
  recoveryEncryptedRootKey: encryptedKeySchema,
  recoveryRootKeyNonce: nonceSchema
});

const loginSchema = z.object({
  username: usernameSchema,
  authVerifier: verifierSchema
});

const recoverSchema = z.object({
  username: usernameSchema,
  recoveryAuthVerifier: verifierSchema,
  newAuthVerifier: verifierSchema,
  authKdf: kdfParamsSchema,
  vaultKdf: kdfParamsSchema,
  encryptedRootKey: encryptedKeySchema,
  rootKeyNonce: nonceSchema,
  keyMaterialVersion: z.number().int().positive()
});

const DUMMY_RESPONSE_SECRET = nodeRandomBytes(32);
const DUMMY_AUTH_VERIFIER_HASH = argon2.hash(nodeRandomBytes(32));

class KeyMaterialVersionConflict extends Error {}

function unknownUserKdfResponse(username: string) {
  return {
    authKdfSalt: pseudorandomBase64(username, "auth-salt", 16),
    authKdfOpsLimit: DEFAULT_KDF.opsLimit,
    authKdfMemLimit: DEFAULT_KDF.memLimit,
    authKdfVersion: DEFAULT_KDF.version,
    vaultKdfSalt: pseudorandomBase64(username, "vault-salt", 16),
    vaultKdfOpsLimit: DEFAULT_KDF.opsLimit,
    vaultKdfMemLimit: DEFAULT_KDF.memLimit,
    vaultKdfVersion: DEFAULT_KDF.version
  };
}

function unknownUserRecoveryResponse(username: string) {
  return {
    recoveryEncryptedRootKey: pseudorandomBase64(username, "recovery-root", 48),
    recoveryRootKeyNonce: pseudorandomBase64(username, "recovery-nonce", 24),
    recoveryKdfSalt: pseudorandomBase64(username, "recovery-salt", 16),
    recoveryKdfOpsLimit: DEFAULT_KDF.opsLimit,
    recoveryKdfMemLimit: DEFAULT_KDF.memLimit,
    recoveryKdfVersion: DEFAULT_KDF.version,
    keyMaterialVersion: 1
  };
}

function pseudorandomBase64(username: string, label: string, byteLength: number): string {
  return createHmac("sha512", DUMMY_RESPONSE_SECRET)
    .update(`${label}:${username}`)
    .digest()
    .subarray(0, byteLength)
    .toString("base64");
}

function createRateLimiter(options: {
  key: (request: Request) => string;
  maxAttempts: number;
  windowMs: number;
}): RequestHandler {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  let nextCleanupAt = Date.now() + options.windowMs;

  return (request, response, next) => {
    const now = Date.now();
    if (now >= nextCleanupAt || attempts.size >= 10_000) {
      for (const [storedKey, attempt] of attempts) {
        if (attempt.resetAt <= now) {
          attempts.delete(storedKey);
        }
      }
      nextCleanupAt = now + options.windowMs;
    }
    const key = options.key(request);
    const current = attempts.get(key);
    if (!current && attempts.size >= 10_000) {
      sendApiError(response, "rate_limited", "Too many attempts");
      return;
    }
    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (current.count >= options.maxAttempts) {
      response.setHeader(
        "Retry-After",
        String(Math.ceil((current.resetAt - now) / 1000))
      );
      sendApiError(response, "rate_limited", "Too many attempts");
      return;
    }

    current.count += 1;
    next();
  };
}

function accountRateLimitKey(request: Request): string {
  const body = request.body as unknown;
  const bodyUsername =
    typeof body === "object" && body !== null && "username" in body
      ? stringValue(body.username)
      : "";
  const queryUsername = stringValue(request.query.username);
  const username = (bodyUsername || queryUsername).trim().toLowerCase();
  return `${request.method}:${request.path}:${username}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function createAuthRouter(context: AppContext): Router {
  const router = Router();
  const preAuthIpRateLimit = createRateLimiter({
    key: (request) => request.ip ?? "unknown",
    maxAttempts: 60,
    windowMs: 5 * 60 * 1000
  });
  const preAuthAccountRateLimit = createRateLimiter({
    key: accountRateLimitKey,
    maxAttempts: 20,
    windowMs: 5 * 60 * 1000
  });
  const preAuthRateLimits = [preAuthIpRateLimit, preAuthAccountRateLimit];

  router.get("/kdf-params", ...preAuthRateLimits, (request, response) => {
    const username = usernameSchema.safeParse(request.query.username);
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

    response.json(row ?? unknownUserKdfResponse(username.data));
  });

  router.get("/recovery-params", ...preAuthRateLimits, (request, response) => {
    const username = usernameSchema.safeParse(request.query.username);
    if (!username.success) {
      sendApiError(response, "bad_request", "Username is required");
      return;
    }

    const row = context.db.sqlite
      .prepare(
        `SELECT user_key_material.recovery_encrypted_root_key AS recoveryEncryptedRootKey,
                user_key_material.recovery_root_key_nonce AS recoveryRootKeyNonce,
                user_key_material.recovery_kdf_salt AS recoveryKdfSalt,
                user_key_material.recovery_kdf_ops_limit AS recoveryKdfOpsLimit,
                user_key_material.recovery_kdf_mem_limit AS recoveryKdfMemLimit,
                user_key_material.recovery_kdf_version AS recoveryKdfVersion,
                user_key_material.key_material_version AS keyMaterialVersion
         FROM users
         JOIN user_key_material ON user_key_material.user_id = users.id
         WHERE users.username = ?`
      )
      .get(username.data);

    response.json(row ?? unknownUserRecoveryResponse(username.data));
  });

  router.post("/register", ...preAuthRateLimits, async (request, response) => {
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

  router.post("/login", ...preAuthRateLimits, async (request, response) => {
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

    const dummyVerifierHash = await DUMMY_AUTH_VERIFIER_HASH;
    const verifierMatches = await argon2.verify(
      row?.authVerifierHash ?? dummyVerifierHash,
      parsed.data.authVerifier
    );
    if (!row || !verifierMatches) {
      sendApiError(response, "unauthorized", "Invalid username or password");
      return;
    }

    const token = createSession(context.db, row.id);
    setSessionCookie(response, token, context.config.cookieSecure);
    response.json({ id: row.id, username: parsed.data.username });
  });

  router.post("/recover", ...preAuthRateLimits, async (request, response) => {
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

    const dummyVerifierHash = await DUMMY_AUTH_VERIFIER_HASH;
    const verifierMatches = await argon2.verify(
      row?.recoveryAuthVerifierHash ?? dummyVerifierHash,
      parsed.data.recoveryAuthVerifier
    );
    if (row?.keyMaterialVersion !== parsed.data.keyMaterialVersion || !verifierMatches) {
      sendApiError(response, "unauthorized", "Invalid recovery key");
      return;
    }

    const newAuthVerifierHash = await argon2.hash(parsed.data.newAuthVerifier);
    let recovered: { token: string; revokedSessionIds: string[] };
    try {
      const recoverAccount = context.db.sqlite.transaction(() => {
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

        const keyMaterialUpdate = context.db.sqlite
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
             WHERE user_id = ? AND key_material_version = ?`
          )
          .run(
            parsed.data.encryptedRootKey,
            parsed.data.rootKeyNonce,
            parsed.data.vaultKdf.salt,
            parsed.data.vaultKdf.opsLimit,
            parsed.data.vaultKdf.memLimit,
            parsed.data.vaultKdf.version,
            row.id,
            parsed.data.keyMaterialVersion
          );
        if (keyMaterialUpdate.changes !== 1) {
          throw new KeyMaterialVersionConflict();
        }

        const revokedSessionIds = deleteUserSessions(context.db, row.id);
        return {
          token: createSession(context.db, row.id),
          revokedSessionIds
        };
      });
      recovered = recoverAccount();
    } catch (error) {
      if (error instanceof KeyMaterialVersionConflict) {
        sendApiError(response, "conflict", "Key material version conflict");
        return;
      }
      throw error;
    }

    for (const sessionId of recovered.revokedSessionIds) {
      context.realtime?.closeSession(sessionId);
    }
    const token = recovered.token;
    setSessionCookie(response, token, context.config.cookieSecure);
    response.json({ id: row.id, username: parsed.data.username });
  });

  router.post("/logout", (request, response) => {
    const token = readSessionToken(request.get("cookie"));
    const sessionId = deleteSession(context.db, token);
    if (sessionId) {
      context.realtime?.closeSession(sessionId);
    }
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
