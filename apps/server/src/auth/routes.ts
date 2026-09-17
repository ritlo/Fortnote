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
  readSessionToken,
  setSessionCookie
} from "./session.js";
import { accountDisplayName, canonicalizeHandle } from "./identity.js";
import type { AccountIdentity } from "./accountRepository.js";

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

const verifierSchema = z.string().min(32).max(128);
const encryptedKeySchema = z.string().min(32).max(256);
const nonceSchema = z.string().min(16).max(128);
const usernameSchema = z.string().min(1).max(64);

const registerSchema = z.object({
  id: z.uuid(),
  username: z.string().min(1).max(128),
  authVerifier: verifierSchema,
  authKdf: kdfParamsSchema,
  vaultKdf: kdfParamsSchema,
  encryptedRootKey: encryptedKeySchema,
  rootKeyNonce: nonceSchema,
  rootKeyFormatVersion: z.literal(2),
  recoveryAuthVerifier: verifierSchema,
  recoveryKdf: kdfParamsSchema,
  recoveryEncryptedRootKey: encryptedKeySchema,
  recoveryRootKeyNonce: nonceSchema,
  recoveryRootKeyFormatVersion: z.literal(2)
});

// Registration envelopes bind the root key to the first key material version.
const INITIAL_KEY_MATERIAL_VERSION = 1;

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
  rootKeyFormatVersion: z.literal(2),
  rootKeyContextVersion: z.number().int().positive(),
  keyMaterialVersion: z.number().int().positive()
});

const DUMMY_RESPONSE_SECRET = nodeRandomBytes(32);
const DUMMY_AUTH_VERIFIER_HASH = argon2.hash(nodeRandomBytes(32));

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
    userId: pseudorandomUuid(username, "user-id"),
    recoveryEncryptedRootKey: pseudorandomBase64(username, "recovery-root", 48),
    recoveryRootKeyNonce: pseudorandomBase64(username, "recovery-nonce", 24),
    recoveryRootKeyFormatVersion: 2,
    recoveryRootKeyContextVersion: 1,
    recoveryKdfSalt: pseudorandomBase64(username, "recovery-salt", 16),
    recoveryKdfOpsLimit: DEFAULT_KDF.opsLimit,
    recoveryKdfMemLimit: DEFAULT_KDF.memLimit,
    recoveryKdfVersion: DEFAULT_KDF.version,
    keyMaterialVersion: 1
  };
}

function pseudorandomUuid(username: string, label: string): string {
  const bytes = createHmac("sha256", DUMMY_RESPONSE_SECRET)
    .update(`${label}:${username}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

async function findAccountIdentity(
  context: AppContext,
  suppliedHandle: string
): Promise<AccountIdentity | null> {
  const canonicalHandle = canonicalizeHandle(suppliedHandle);
  return canonicalHandle ? context.db.accounts.findIdentity(canonicalHandle) : null;
}

function accountResponse(identity: AccountIdentity) {
  return {
    id: identity.id,
    username: identity.canonicalHandle ?? identity.username,
    displayName: identity.displayName ?? identity.username,
    canonicalHandle: identity.canonicalHandle
  };
}

export function createAuthRouter(context: AppContext): Router {
  const router = Router();
  const preAuthIpRateLimit = createRateLimiter({
    key: (request) => request.ip ?? "unknown",
    maxAttempts: context.config.authIpRateLimitMaxAttempts,
    windowMs: 5 * 60 * 1000
  });
  const preAuthAccountRateLimit = createRateLimiter({
    key: accountRateLimitKey,
    maxAttempts: context.config.authAccountRateLimitMaxAttempts,
    windowMs: 5 * 60 * 1000
  });
  const preAuthRateLimits = [preAuthIpRateLimit, preAuthAccountRateLimit];

  router.get("/kdf-params", ...preAuthRateLimits, async (request, response) => {
    const username = usernameSchema.safeParse(request.query.username);
    if (!username.success) {
      sendApiError(response, "bad_request", "Username is required");
      return;
    }

    const identity = await findAccountIdentity(context, username.data);
    const row = identity ? await context.db.accounts.kdfParameters(identity.id) : null;

    response.json(
      row ?? unknownUserKdfResponse(canonicalizeHandle(username.data) ?? username.data)
    );
  });

  router.get("/recovery-params", ...preAuthRateLimits, async (request, response) => {
    const username = usernameSchema.safeParse(request.query.username);
    if (!username.success) {
      sendApiError(response, "bad_request", "Username is required");
      return;
    }

    const identity = await findAccountIdentity(context, username.data);
    const row = identity
      ? await context.db.accounts.recoveryParameters(identity.id)
      : null;

    response.json(
      row ??
        unknownUserRecoveryResponse(canonicalizeHandle(username.data) ?? username.data)
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
    const userId = parsed.data.id;
    const authVerifierHash = await argon2.hash(parsed.data.authVerifier);
    const recoveryAuthVerifierHash = await argon2.hash(parsed.data.recoveryAuthVerifier);

    const registration = await context.db.accounts.register({
      user: {
        id: userId,
        username: canonicalHandle,
        displayName,
        canonicalHandle,
        authVerifierHash,
        authKdfSalt: parsed.data.authKdf.salt,
        authKdfOpsLimit: parsed.data.authKdf.opsLimit,
        authKdfMemLimit: parsed.data.authKdf.memLimit,
        authKdfVersion: parsed.data.authKdf.version
      },
      keyMaterial: {
        encryptedRootKey: parsed.data.encryptedRootKey,
        rootKeyNonce: parsed.data.rootKeyNonce,
        rootKeyFormatVersion: parsed.data.rootKeyFormatVersion,
        rootKeyContextVersion: INITIAL_KEY_MATERIAL_VERSION,
        kdfSalt: parsed.data.vaultKdf.salt,
        kdfOpsLimit: parsed.data.vaultKdf.opsLimit,
        kdfMemLimit: parsed.data.vaultKdf.memLimit,
        kdfVersion: parsed.data.vaultKdf.version,
        recoveryEncryptedRootKey: parsed.data.recoveryEncryptedRootKey,
        recoveryRootKeyNonce: parsed.data.recoveryRootKeyNonce,
        recoveryRootKeyFormatVersion: parsed.data.recoveryRootKeyFormatVersion,
        recoveryRootKeyContextVersion: INITIAL_KEY_MATERIAL_VERSION,
        recoveryAuthVerifierHash,
        recoveryKdfSalt: parsed.data.recoveryKdf.salt,
        recoveryKdfOpsLimit: parsed.data.recoveryKdf.opsLimit,
        recoveryKdfMemLimit: parsed.data.recoveryKdf.memLimit,
        recoveryKdfVersion: parsed.data.recoveryKdf.version
      }
    });
    if (registration.kind === "handle-taken") {
      sendApiError(response, "conflict", "Username is already registered");
      return;
    }
    if (registration.kind === "id-taken") {
      // Account IDs are random, so a collision needs a new ID rather than a new handle.
      sendApiError(response, "conflict", "Account could not be created; try again");
      return;
    }

    const token = await createSession(context.db, userId);
    setSessionCookie(response, token, context.config.cookieSecure);
    response.status(201).json(
      accountResponse({
        id: userId,
        username: canonicalHandle,
        displayName,
        canonicalHandle
      })
    );
  });

  router.post("/login", ...preAuthRateLimits, async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid login payload");
      return;
    }

    const identity = await findAccountIdentity(context, parsed.data.username);
    const authVerifierHash = identity
      ? await context.db.accounts.authVerifierHash(identity.id)
      : null;

    const dummyVerifierHash = await DUMMY_AUTH_VERIFIER_HASH;
    const verifierMatches = await argon2.verify(
      authVerifierHash ?? dummyVerifierHash,
      parsed.data.authVerifier
    );
    if (!identity || !authVerifierHash || !verifierMatches) {
      sendApiError(response, "unauthorized", "Invalid username or password");
      return;
    }

    const token = await createSession(context.db, identity.id);
    setSessionCookie(response, token, context.config.cookieSecure);
    response.json(accountResponse(identity));
  });

  router.post("/recover", ...preAuthRateLimits, async (request, response) => {
    const parsed = recoverSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid recovery payload");
      return;
    }
    const identity = await findAccountIdentity(context, parsed.data.username);
    const row = identity ? await context.db.accounts.recoveryVerifier(identity.id) : null;

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
    const recovered = await context.db.accounts.recover({
      userId: row.id,
      expectedKeyMaterialVersion: parsed.data.keyMaterialVersion,
      newAuthVerifierHash,
      authKdf: parsed.data.authKdf,
      vaultKdf: parsed.data.vaultKdf,
      encryptedRootKey: parsed.data.encryptedRootKey,
      rootKeyNonce: parsed.data.rootKeyNonce,
      rootKeyFormatVersion: parsed.data.rootKeyFormatVersion,
      rootKeyContextVersion: parsed.data.rootKeyContextVersion
    });
    if (recovered.kind === "conflict") {
      sendApiError(response, "conflict", "Key material version conflict");
      return;
    }

    for (const sessionId of recovered.revokedSessionIds) {
      context.realtime?.closeSession(sessionId);
    }
    const token = recovered.token;
    setSessionCookie(response, token, context.config.cookieSecure);
    response.json(accountResponse(identity));
  });

  router.post("/logout", async (request, response) => {
    const token = readSessionToken(request.get("cookie"));
    const sessionId = await deleteSession(context.db, token);
    if (sessionId) {
      context.realtime?.closeSession(sessionId);
    }
    clearSessionCookie(response, context.config.cookieSecure);
    response.status(204).send();
  });

  router.get("/me", async (request, response) => {
    const session = await context.db.sessions.find(
      readSessionToken(request.get("cookie"))
    );
    if (!session) {
      sendApiError(response, "unauthorized", "Not signed in");
      return;
    }

    response.json(accountResponse({ ...session, id: session.userId }));
  });

  return router;
}
