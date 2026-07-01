import { Router } from "express";
import { z } from "zod";
import { requireSession } from "../auth/session.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";

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

    const row = context.db.sqlite
      .prepare(
        `SELECT sharing_key_version AS sharingKeyVersion,
                public_key AS publicKey,
                encrypted_private_key AS encryptedPrivateKey,
                private_key_nonce AS privateKeyNonce,
                format_version AS formatVersion,
                created_at AS createdAt,
                updated_at AS updatedAt
         FROM user_sharing_keys
         WHERE user_id = ?
         ORDER BY sharing_key_version DESC
         LIMIT 1`
      )
      .get(session.userId);

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
      context.db.sqlite
        .prepare(
          `INSERT INTO user_sharing_keys (
            user_id,
            sharing_key_version,
            public_key,
            encrypted_private_key,
            private_key_nonce,
            format_version
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          session.userId,
          parsed.data.sharingKeyVersion,
          parsed.data.publicKey,
          parsed.data.encryptedPrivateKey,
          parsed.data.privateKeyNonce,
          parsed.data.formatVersion
        );
    } catch {
      sendApiError(response, "conflict", "Sharing key version already exists");
      return;
    }

    response.status(201).json({
      sharingKeyVersion: parsed.data.sharingKeyVersion
    });
  });

  router.get("/lookup", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const username = z.string().min(1).max(64).safeParse(request.query.username);
    if (!username.success) {
      sendApiError(response, "bad_request", "Username is required");
      return;
    }

    const row = context.db.sqlite
      .prepare(
        `SELECT users.id AS userId,
                users.username,
                user_sharing_keys.sharing_key_version AS sharingKeyVersion,
                user_sharing_keys.public_key AS publicKey,
                user_sharing_keys.format_version AS formatVersion,
                user_sharing_keys.created_at AS createdAt
         FROM users
         JOIN user_sharing_keys ON user_sharing_keys.user_id = users.id
         WHERE users.username = ?
         ORDER BY user_sharing_keys.sharing_key_version DESC
         LIMIT 1`
      )
      .get(username.data);

    if (!row) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }

    response.json(row);
  });

  return router;
}
