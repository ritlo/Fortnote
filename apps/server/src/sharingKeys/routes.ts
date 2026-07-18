import { and, desc, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../auth/session.js";
import * as schema from "../db/schema.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { canonicalizeHandle } from "../auth/identity.js";

const sharingKeySchema = z.object({
  sharingKeyVersion: z.number().int().positive(),
  publicKey: z.string().min(32),
  encryptedPrivateKey: z.string().min(32),
  privateKeyNonce: z.string().min(16),
  formatVersion: z.number().int().positive()
});

export function createSharingKeysRouter(context: AppContext): Router {
  const router = Router();

  router.get("/current", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const row = context.db.orm
      .select({
        sharingKeyVersion: schema.userSharingKeys.sharingKeyVersion,
        publicKey: schema.userSharingKeys.publicKey,
        encryptedPrivateKey: schema.userSharingKeys.encryptedPrivateKey,
        privateKeyNonce: schema.userSharingKeys.privateKeyNonce,
        formatVersion: schema.userSharingKeys.formatVersion,
        createdAt: schema.userSharingKeys.createdAt,
        updatedAt: schema.userSharingKeys.updatedAt
      })
      .from(schema.userSharingKeys)
      .where(eq(schema.userSharingKeys.userId, session.userId))
      .orderBy(desc(schema.userSharingKeys.sharingKeyVersion))
      .limit(1)
      .get();

    if (!row) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }

    response.json(row);
  });

  router.get("/versions/:version", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const version = z.coerce.number().int().positive().safeParse(request.params.version);
    if (!version.success) {
      sendApiError(response, "bad_request", "Invalid sharing key version");
      return;
    }

    const row = context.db.orm
      .select({
        sharingKeyVersion: schema.userSharingKeys.sharingKeyVersion,
        publicKey: schema.userSharingKeys.publicKey,
        encryptedPrivateKey: schema.userSharingKeys.encryptedPrivateKey,
        privateKeyNonce: schema.userSharingKeys.privateKeyNonce,
        formatVersion: schema.userSharingKeys.formatVersion,
        createdAt: schema.userSharingKeys.createdAt,
        updatedAt: schema.userSharingKeys.updatedAt
      })
      .from(schema.userSharingKeys)
      .where(and(
        eq(schema.userSharingKeys.userId, session.userId),
        eq(schema.userSharingKeys.sharingKeyVersion, version.data)
      ))
      .get();

    if (!row) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }

    response.json(row);
  });

  router.put("/current", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = sharingKeySchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid sharing key payload");
      return;
    }

    try {
      context.db.orm.insert(schema.userSharingKeys).values({
        userId: session.userId,
        sharingKeyVersion: parsed.data.sharingKeyVersion,
        publicKey: parsed.data.publicKey,
        encryptedPrivateKey: parsed.data.encryptedPrivateKey,
        privateKeyNonce: parsed.data.privateKeyNonce,
        formatVersion: parsed.data.formatVersion
      }).run();
    } catch {
      sendApiError(response, "conflict", "Sharing key version already exists");
      return;
    }

    response.status(201).json({
      sharingKeyVersion: parsed.data.sharingKeyVersion
    });
  });

  router.post("/cleanup", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const result = context.db.orm.run(sql`
      DELETE FROM ${schema.userSharingKeys}
      WHERE ${schema.userSharingKeys.userId} = ${session.userId}
        AND ${schema.userSharingKeys.sharingKeyVersion} < (
          SELECT MAX(current_keys.sharing_key_version)
          FROM ${schema.userSharingKeys} AS current_keys
          WHERE current_keys.user_id = ${schema.userSharingKeys.userId}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${schema.noteKeyShares}
          WHERE ${schema.noteKeyShares.recipientUserId} = ${schema.userSharingKeys.userId}
            AND ${schema.noteKeyShares.sharingKeyVersion} =
              ${schema.userSharingKeys.sharingKeyVersion}
        )
    `);

    response.json({ deleted: result.changes });
  });

  router.get("/lookup", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const username = z.string().min(1).max(128).safeParse(request.query.username);
    const canonicalHandle = username.success
      ? canonicalizeHandle(username.data)
      : null;
    if (!canonicalHandle) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }

    const row = context.db.orm
      .select({
        userId: schema.users.id,
        canonicalHandle: schema.users.canonicalHandle,
        displayName: schema.users.displayName,
        sharingKeyVersion: schema.userSharingKeys.sharingKeyVersion,
        publicKey: schema.userSharingKeys.publicKey,
        formatVersion: schema.userSharingKeys.formatVersion,
        createdAt: schema.userSharingKeys.createdAt
      })
      .from(schema.users)
      .innerJoin(
        schema.userSharingKeys,
        eq(schema.userSharingKeys.userId, schema.users.id)
      )
      .where(
        and(
          eq(schema.users.canonicalHandle, canonicalHandle),
          eq(schema.users.handleState, "active")
        )
      )
      .orderBy(desc(schema.userSharingKeys.sharingKeyVersion))
      .limit(1)
      .get();

    if (!row) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }

    response.json({
      ...row,
      username: row.canonicalHandle,
      canonicalHandle: row.canonicalHandle
    });
  });

  return router;
}
