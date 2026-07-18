import argon2 from "argon2";
import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { DEFAULT_KDF } from "@fortnote/shared";
import * as schema from "../db/schema.js";
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
import { accountDisplayName, canonicalizeHandle } from "./identity.js";

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
  username: z.string().min(1).max(128),
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

interface AccountIdentity {
  id: string;
  username: string;
  displayName: string | null;
  canonicalHandle: string | null;
  handleState: string;
}

function findAccountIdentity(context: AppContext, suppliedHandle: string): AccountIdentity | null {
  const selection = {
    id: schema.users.id,
    username: schema.users.username,
    displayName: schema.users.displayName,
    canonicalHandle: schema.users.canonicalHandle,
    handleState: schema.users.handleState
  };
  const canonicalHandle = canonicalizeHandle(suppliedHandle);
  if (canonicalHandle) {
    const canonical = context.db.orm
      .select(selection)
      .from(schema.users)
      .where(eq(schema.users.canonicalHandle, canonicalHandle))
      .get();
    if (canonical) {
      return canonical;
    }
  }
  return context.db.orm
    .select(selection)
    .from(schema.users)
    .where(
      and(
        isNull(schema.users.canonicalHandle),
        eq(schema.users.username, suppliedHandle)
      )
    )
    .get() ?? null;
}

function accountResponse(identity: AccountIdentity) {
  return {
    id: identity.id,
    username: identity.canonicalHandle ?? identity.username,
    displayName: identity.displayName ?? identity.username,
    canonicalHandle: identity.canonicalHandle,
    handleState: identity.handleState
  };
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

    const identity = findAccountIdentity(context, username.data);
    const row = identity ? context.db.orm
      .select({
        authKdfSalt: schema.users.authKdfSalt,
        authKdfOpsLimit: schema.users.authKdfOpsLimit,
        authKdfMemLimit: schema.users.authKdfMemLimit,
        authKdfVersion: schema.users.authKdfVersion,
        vaultKdfSalt: schema.userKeyMaterial.kdfSalt,
        vaultKdfOpsLimit: schema.userKeyMaterial.kdfOpsLimit,
        vaultKdfMemLimit: schema.userKeyMaterial.kdfMemLimit,
        vaultKdfVersion: schema.userKeyMaterial.kdfVersion
      })
      .from(schema.users)
      .innerJoin(
        schema.userKeyMaterial,
        eq(schema.userKeyMaterial.userId, schema.users.id)
      )
      .where(eq(schema.users.id, identity.id))
      .get() : null;

    response.json(row ?? unknownUserKdfResponse(canonicalizeHandle(username.data) ?? username.data));
  });

  router.get("/recovery-params", ...preAuthRateLimits, (request, response) => {
    const username = usernameSchema.safeParse(request.query.username);
    if (!username.success) {
      sendApiError(response, "bad_request", "Username is required");
      return;
    }

    const identity = findAccountIdentity(context, username.data);
    const row = identity ? context.db.orm
      .select({
        recoveryEncryptedRootKey: schema.userKeyMaterial.recoveryEncryptedRootKey,
        recoveryRootKeyNonce: schema.userKeyMaterial.recoveryRootKeyNonce,
        recoveryKdfSalt: schema.userKeyMaterial.recoveryKdfSalt,
        recoveryKdfOpsLimit: schema.userKeyMaterial.recoveryKdfOpsLimit,
        recoveryKdfMemLimit: schema.userKeyMaterial.recoveryKdfMemLimit,
        recoveryKdfVersion: schema.userKeyMaterial.recoveryKdfVersion,
        keyMaterialVersion: schema.userKeyMaterial.keyMaterialVersion
      })
      .from(schema.users)
      .innerJoin(
        schema.userKeyMaterial,
        eq(schema.userKeyMaterial.userId, schema.users.id)
      )
      .where(eq(schema.users.id, identity.id))
      .get() : null;

    response.json(
      row ?? unknownUserRecoveryResponse(canonicalizeHandle(username.data) ?? username.data)
    );
  });

  router.post("/register", ...preAuthRateLimits, async (request, response) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid registration payload");
      return;
    }

    const canonicalHandle = canonicalizeHandle(parsed.data.username);
    if (!canonicalHandle) {
      sendApiError(response, "bad_request", "Invalid account handle");
      return;
    }
    const displayName = accountDisplayName(parsed.data.username);
    const userId = crypto.randomUUID();
    const authVerifierHash = await argon2.hash(parsed.data.authVerifier);
    const recoveryAuthVerifierHash = await argon2.hash(
      parsed.data.recoveryAuthVerifier
    );

    try {
      context.db.orm.transaction((tx) => {
        tx.insert(schema.users).values({
          id: userId,
          username: canonicalHandle,
          displayName,
          canonicalHandle,
          handleState: "active",
          authVerifierHash,
          authKdfSalt: parsed.data.authKdf.salt,
          authKdfOpsLimit: parsed.data.authKdf.opsLimit,
          authKdfMemLimit: parsed.data.authKdf.memLimit,
          authKdfVersion: parsed.data.authKdf.version
        }).run();

        tx.insert(schema.userKeyMaterial).values({
          userId,
          encryptedRootKey: parsed.data.encryptedRootKey,
          rootKeyNonce: parsed.data.rootKeyNonce,
          kdfSalt: parsed.data.vaultKdf.salt,
          kdfOpsLimit: parsed.data.vaultKdf.opsLimit,
          kdfMemLimit: parsed.data.vaultKdf.memLimit,
          kdfVersion: parsed.data.vaultKdf.version,
          recoveryEncryptedRootKey: parsed.data.recoveryEncryptedRootKey,
          recoveryRootKeyNonce: parsed.data.recoveryRootKeyNonce,
          recoveryAuthVerifierHash,
          recoveryKdfSalt: parsed.data.recoveryKdf.salt,
          recoveryKdfOpsLimit: parsed.data.recoveryKdf.opsLimit,
          recoveryKdfMemLimit: parsed.data.recoveryKdf.memLimit,
          recoveryKdfVersion: parsed.data.recoveryKdf.version
        }).run();
      });
    } catch {
      sendApiError(response, "conflict", "Username is already registered");
      return;
    }

    const token = createSession(context.db, userId);
    setSessionCookie(response, token, context.config.cookieSecure);
    response.status(201).json(
      accountResponse({
        id: userId,
        username: canonicalHandle,
        displayName,
        canonicalHandle,
        handleState: "active"
      })
    );
  });

  router.post("/login", ...preAuthRateLimits, async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid login payload");
      return;
    }

    const identity = findAccountIdentity(context, parsed.data.username);
    const row = identity
      ? context.db.orm
          .select({ authVerifierHash: schema.users.authVerifierHash })
          .from(schema.users)
          .where(eq(schema.users.id, identity.id))
          .get()
      : null;

    const dummyVerifierHash = await DUMMY_AUTH_VERIFIER_HASH;
    const verifierMatches = await argon2.verify(
      row?.authVerifierHash ?? dummyVerifierHash,
      parsed.data.authVerifier
    );
    if (!identity || !row || !verifierMatches) {
      sendApiError(response, "unauthorized", "Invalid username or password");
      return;
    }

    const token = createSession(context.db, identity.id);
    setSessionCookie(response, token, context.config.cookieSecure);
    response.json(accountResponse(identity));
  });

  router.post("/recover", ...preAuthRateLimits, async (request, response) => {
    const parsed = recoverSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid recovery payload");
      return;
    }

    const identity = findAccountIdentity(context, parsed.data.username);
    const row = identity ? context.db.orm
      .select({
        id: schema.users.id,
        recoveryAuthVerifierHash: schema.userKeyMaterial.recoveryAuthVerifierHash,
        keyMaterialVersion: schema.userKeyMaterial.keyMaterialVersion
      })
      .from(schema.users)
      .innerJoin(
        schema.userKeyMaterial,
        eq(schema.userKeyMaterial.userId, schema.users.id)
      )
      .where(eq(schema.users.id, identity.id))
      .get() : null;

    const dummyVerifierHash = await DUMMY_AUTH_VERIFIER_HASH;
    const verifierMatches = await argon2.verify(
      row?.recoveryAuthVerifierHash ?? dummyVerifierHash,
      parsed.data.recoveryAuthVerifier
    );
    if (
      !identity?.id ||
      row?.keyMaterialVersion !== parsed.data.keyMaterialVersion ||
      !verifierMatches
    ) {
      sendApiError(response, "unauthorized", "Invalid recovery key");
      return;
    }

    const newAuthVerifierHash = await argon2.hash(parsed.data.newAuthVerifier);
    let recovered: { token: string; revokedSessionIds: string[] };
    try {
      recovered = context.db.orm.transaction((tx) => {
        tx.update(schema.users)
          .set({
            authVerifierHash: newAuthVerifierHash,
            authKdfSalt: parsed.data.authKdf.salt,
            authKdfOpsLimit: parsed.data.authKdf.opsLimit,
            authKdfMemLimit: parsed.data.authKdf.memLimit,
            authKdfVersion: parsed.data.authKdf.version,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(eq(schema.users.id, row.id))
          .run();

        const keyMaterialUpdate = tx.update(schema.userKeyMaterial)
          .set({
            encryptedRootKey: parsed.data.encryptedRootKey,
            rootKeyNonce: parsed.data.rootKeyNonce,
            kdfSalt: parsed.data.vaultKdf.salt,
            kdfOpsLimit: parsed.data.vaultKdf.opsLimit,
            kdfMemLimit: parsed.data.vaultKdf.memLimit,
            kdfVersion: parsed.data.vaultKdf.version,
            keyMaterialVersion: sql`${schema.userKeyMaterial.keyMaterialVersion} + 1`,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(and(
            eq(schema.userKeyMaterial.userId, row.id),
            eq(schema.userKeyMaterial.keyMaterialVersion, parsed.data.keyMaterialVersion)
          ))
          .run();
        if (keyMaterialUpdate.changes !== 1) {
          throw new KeyMaterialVersionConflict();
        }

        const revokedSessionIds = deleteUserSessions(context.db, row.id, tx);
        return {
          token: createSession(context.db, row.id, tx),
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

    for (const sessionId of recovered.revokedSessionIds) {
      context.realtime?.closeSession(sessionId);
    }
    const token = recovered.token;
    setSessionCookie(response, token, context.config.cookieSecure);
    response.json(accountResponse(identity));
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

  router.put("/handle", (request, response) => {
    const session = findSession(context.db, readSessionToken(request.get("cookie")));
    if (!session) {
      sendApiError(response, "unauthorized", "Not signed in");
      return;
    }
    const parsed = z.object({ handle: z.string().min(1).max(128) }).safeParse(request.body);
    const canonicalHandle = parsed.success
      ? canonicalizeHandle(parsed.data.handle)
      : null;
    if (!canonicalHandle) {
      sendApiError(response, "bad_request", "Invalid account handle");
      return;
    }
    try {
      const result = context.db.orm
        .update(schema.users)
        .set({
          username: canonicalHandle,
          canonicalHandle,
          handleState: "active",
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(and(eq(schema.users.id, session.userId), isNull(schema.users.canonicalHandle)))
        .run();
      if (result.changes !== 1) {
        sendApiError(response, "conflict", "Account handle is already active");
        return;
      }
    } catch {
      sendApiError(response, "conflict", "Account handle is unavailable");
      return;
    }
    response.json(
      accountResponse({
        id: session.userId,
        username: canonicalHandle,
        displayName: session.displayName,
        canonicalHandle,
        handleState: "active"
      })
    );
  });

  router.get("/me", (request, response) => {
    const session = findSession(context.db, readSessionToken(request.get("cookie")));
    if (!session) {
      sendApiError(response, "unauthorized", "Not signed in");
      return;
    }

    response.json(accountResponse({ ...session, id: session.userId }));
  });

  return router;
}
