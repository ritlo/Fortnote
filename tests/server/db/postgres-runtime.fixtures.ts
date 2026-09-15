import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { getConfig, type ServerConfig } from "@server/config.js";
import { createApplicationDatabase } from "@server/db/client.js";
import type { ApplicationDatabase } from "@server/db/types.js";
import { contentManifestHash } from "@server/content/manifests.js";
import { TEST_DATABASE_URL } from "../support/database.js";
import { csrfHeaders, notePayload, registerPayload } from "../support/http.js";

export interface RuntimeHarness {
  config: ServerConfig;
  database: ApplicationDatabase;
  cleanup(): Promise<void>;
}

type HttpAgent = ReturnType<typeof request.agent>;

export async function createPostgresHarness(
  storageQuotaBytes?: number
): Promise<RuntimeHarness> {
  const config: ServerConfig = {
    ...getConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_MAX_CONNECTIONS: "8"
    }),
    ...(storageQuotaBytes === undefined ? {} : { storageQuotaBytes }),
    cookieSecure: false
  };
  const database = await createApplicationDatabase(config);
  try {
    await database.pool.query("TRUNCATE TABLE users, attachment_objects CASCADE");
    return { config, database, cleanup: () => Promise.resolve() };
  } catch (error) {
    await database.close();
    throw error;
  }
}

export async function registerAndCreateNote(
  agent: HttpAgent,
  label: string
): Promise<string> {
  await registerUser(agent, label);
  const note = await agent
    .post("/api/notes")
    .set(csrfHeaders())
    .send(notePayload())
    .expect(201);
  return String((note.body as { id: unknown }).id);
}

export async function registerUser(agent: HttpAgent, label: string) {
  const username = `${label}_${crypto.randomUUID()}`;
  await agent
    .post("/api/auth/register")
    .set(csrfHeaders())
    .send(registerPayload(username))
    .expect(201);
  const session = await agent.get("/api/auth/me").expect(200);
  return { userId: String((session.body as { id: unknown }).id), username };
}

export function sharingKeyPayload(version = 1) {
  return {
    sharingKeyVersion: version,
    publicKey: `contract_public_sharing_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    encryptedPrivateKey: `contract_encrypted_private_sharing_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    privateKeyNonce: `contract_private_key_nonce_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    formatVersion: 2
  };
}

export function attachmentPayload(ciphertext = Buffer.from([4, 8, 15, 16, 23, 42])) {
  return {
    id: crypto.randomUUID(),
    ciphertext
  };
}

export function contentBeginPayload(noteId: string) {
  return {
    uploadId: crypto.randomUUID(),
    updateId: crypto.randomUUID(),
    noteId,
    sectionId: "root",
    expectedKeyEpoch: 1,
    kind: "update",
    formatVersion: 2,
    totalCipherBytes: 6,
    chunkCount: 1,
    manifestHash: "a".repeat(64)
  };
}

export function committableContent(
  noteId: string,
  bytes: Buffer = Buffer.from([3, 1, 4, 1, 5, 9])
) {
  const cipherHash = createHash("sha256").update(bytes).digest("hex");
  const nonce = Buffer.alloc(24, 7);
  return {
    bytes,
    cipherHash,
    nonce,
    payload: {
      ...contentBeginPayload(noteId),
      totalCipherBytes: bytes.length,
      manifestHash: contentManifestHash([
        {
          chunkIndex: 0,
          cipherLength: bytes.byteLength,
          cipherHash,
          nonce
        }
      ])
    }
  };
}

export async function uploadContent(
  agent: HttpAgent,
  noteId: string,
  bytes: Buffer,
  commit = false
) {
  const content = committableContent(noteId, bytes);
  await agent
    .post("/api/content/uploads")
    .set(csrfHeaders())
    .send(content.payload)
    .expect(201);
  await agent
    .put(`/api/content/uploads/${content.payload.uploadId}/chunks/0`)
    .set(csrfHeaders())
    .set("content-type", "application/octet-stream")
    .set("content-length", String(bytes.length))
    .set("x-fortnote-cipher-hash", content.cipherHash)
    .set("x-fortnote-nonce", content.nonce.toString("base64"))
    .send(bytes)
    .expect(204);
  if (!commit) {
    return { ...content, manifestId: "" };
  }
  const response = await agent
    .post(`/api/content/uploads/${content.payload.uploadId}/commit`)
    .set(csrfHeaders())
    .send({
      requestId: crypto.randomUUID(),
      updateId: content.payload.updateId,
      expectedKeyEpoch: 1
    })
    .expect(201);
  return {
    ...content,
    manifestId: String((response.body as { manifestId: unknown }).manifestId)
  };
}

export function uploadAttachment(
  agent: HttpAgent,
  noteId: string,
  attachment: ReturnType<typeof attachmentPayload>
) {
  return agent
    .post(`/api/notes/${noteId}/attachments`)
    .set(csrfHeaders())
    .set({
      "content-type": "application/octet-stream",
      "x-fortnote-attachment-id": attachment.id,
      "x-fortnote-size": String(attachment.ciphertext.byteLength),
      "x-fortnote-expected-key-epoch": "1",
      "x-fortnote-metadata-cipher": "contract_attachment_metadata_cipher",
      "x-fortnote-metadata-nonce": "contract_attachment_metadata_nonce",
      "x-fortnote-metadata-format-version": "2",
      "x-fortnote-encrypted-attachment-key": "contract_encrypted_attachment_key",
      "x-fortnote-attachment-key-nonce": "contract_attachment_key_nonce",
      "x-fortnote-file-nonce": "contract_attachment_file_nonce"
    })
    .send(attachment.ciphertext);
}

export async function storageCounts(database: ApplicationDatabase) {
  const result = await database.pool.query<{
    chunks: number;
    objects: number;
    reservedBytes: number;
    usedBytes: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::integer FROM attachment_objects) AS objects,
      (SELECT COUNT(*)::integer FROM attachment_object_chunks) AS chunks,
      (SELECT reserved_bytes::integer FROM storage_accounts LIMIT 1) AS "reservedBytes",
      (SELECT used_bytes::integer FROM storage_accounts LIMIT 1) AS "usedBytes"
  `);
  const counts = result.rows[0];
  if (!counts) {
    throw new Error("PostgreSQL storage count query returned no rows");
  }
  return counts;
}

export async function attachmentObjectState(
  database: ApplicationDatabase,
  attachmentId: string
) {
  const result = await database.pool.query<{
    byteLength: number;
    chunks: number;
    storedBytes: number;
    usedBytes: number;
  }>(
    `
    SELECT
      object.byte_length::integer AS "byteLength",
      COUNT(chunk.chunk_index)::integer AS chunks,
      COALESCE(SUM(octet_length(chunk.ciphertext)), 0)::integer AS "storedBytes",
      account.used_bytes::integer AS "usedBytes"
    FROM attachments attachment
    INNER JOIN notes note ON note.id = attachment.note_id
    INNER JOIN storage_accounts account ON account.user_id = note.user_id
    INNER JOIN attachment_objects object
      ON object.storage_key = attachment.storage_key
    LEFT JOIN attachment_object_chunks chunk
      ON chunk.storage_key = object.storage_key
    WHERE attachment.id = $1
    GROUP BY object.byte_length, account.used_bytes
  `,
    [attachmentId]
  );
  return requiredRow(result.rows[0], "attachment object state");
}

export async function uploadLifecycleState(
  database: ApplicationDatabase,
  uploadIds: string[],
  userId: string
) {
  const result = await database.pool.query<{
    expired: number;
    objects: number;
    reservedBytes: number;
    usedBytes: number;
  }>(
    `
    SELECT
      (SELECT COUNT(*)::integer FROM content_uploads
        WHERE id = ANY($1::text[]) AND status = 'expired') AS expired,
      (SELECT COUNT(*)::integer FROM attachment_objects) AS objects,
      account.reserved_bytes::integer AS "reservedBytes",
      account.used_bytes::integer AS "usedBytes"
    FROM storage_accounts account
    WHERE account.user_id = $2
  `,
    [uploadIds, userId]
  );
  return requiredRow(result.rows[0], "upload lifecycle state");
}

export async function storageAccountStates(
  database: ApplicationDatabase,
  userIds: string[]
): Promise<Record<string, { reservedBytes: number; usedBytes: number }>> {
  const result = await database.pool.query<{
    reservedBytes: number;
    usedBytes: number;
    userId: string;
  }>(
    `
    SELECT
      user_id AS "userId",
      reserved_bytes::integer AS "reservedBytes",
      used_bytes::integer AS "usedBytes"
    FROM storage_accounts
    WHERE user_id = ANY($1::text[])
  `,
    [userIds]
  );
  return Object.fromEntries(
    result.rows.map(({ userId, reservedBytes, usedBytes }) => [
      userId,
      { reservedBytes, usedBytes }
    ])
  );
}

export async function noteDeletionState(database: ApplicationDatabase, noteId: string) {
  const result = await database.pool.query<{
    attachments: number;
    notes: number;
    objects: number;
    permanentDeleteEvents: number;
    reservedBytes: number;
    usedBytes: number;
  }>(
    `
    SELECT
      (SELECT COUNT(*)::integer FROM notes WHERE id = $1) AS notes,
      (SELECT COUNT(*)::integer FROM attachments WHERE note_id = $1) AS attachments,
      (SELECT COUNT(*)::integer FROM attachment_objects) AS objects,
      (SELECT COUNT(*)::integer FROM note_events
        WHERE note_id = $1 AND event_type = 'note.permanently_deleted')
        AS "permanentDeleteEvents",
      (SELECT reserved_bytes::integer FROM storage_accounts LIMIT 1) AS "reservedBytes",
      (SELECT used_bytes::integer FROM storage_accounts LIMIT 1) AS "usedBytes"
  `,
    [noteId]
  );
  return requiredRow(result.rows[0], "note deletion state");
}

export async function membershipRevocationState(
  database: ApplicationDatabase,
  noteId: string,
  userId: string
) {
  const result = await database.pool.query<{
    keyShares: number;
    revokeEvents: number;
    status: string;
  }>(
    `
    SELECT
      (SELECT status FROM note_memberships
        WHERE note_id = $1 AND user_id = $2) AS status,
      (SELECT COUNT(*)::integer FROM note_key_shares
        WHERE note_id = $1 AND recipient_user_id = $2) AS "keyShares",
      (SELECT COUNT(*)::integer FROM note_events
        WHERE note_id = $1 AND event_type = 'membership.revoked') AS "revokeEvents"
  `,
    [noteId, userId]
  );
  return requiredRow(result.rows[0], "membership revocation state");
}

export async function rotationState(database: ApplicationDatabase, noteId: string) {
  const result = await database.pool.query<{
    keyEpoch: number;
    rotationEvents: number;
    version: number;
  }>(
    `
    SELECT
      (SELECT key_epoch FROM notes WHERE id = $1) AS "keyEpoch",
      (SELECT version FROM notes WHERE id = $1) AS version,
      (SELECT COUNT(*)::integer FROM note_events
        WHERE note_id = $1 AND event_type = 'membership.revoked'
          AND payload_metadata LIKE '%"targetEpoch":%') AS "rotationEvents"
  `,
    [noteId]
  );
  return requiredRow(result.rows[0], "rotation state");
}

export async function eventPruningState(database: ApplicationDatabase, cursor: number) {
  const result = await database.pool.query<{
    acknowledgements: number;
    events: number;
    minimumCursor: number;
  }>(
    `
    SELECT
      (SELECT COUNT(*)::integer FROM event_cursors
        WHERE cursor >= $1) AS acknowledgements,
      (SELECT COUNT(*)::integer FROM note_events
        WHERE cursor <= $1) AS events,
      (SELECT MIN(cursor)::integer FROM event_cursors) AS "minimumCursor"
  `,
    [cursor]
  );
  return requiredRow(result.rows[0], "event pruning state");
}

export async function contentCommitState(
  database: ApplicationDatabase,
  uploadId: string,
  noteId: string
) {
  const result = await database.pool.query<{
    chunks: number;
    currentSequence: number;
    manifests: number;
    objects: number;
    reservedBytes: number;
    sectionUpdates: number;
    usedBytes: number;
  }>(
    `
    SELECT
      (SELECT COUNT(*)::integer FROM content_manifests
        WHERE upload_id = $1) AS manifests,
      (SELECT COUNT(*)::integer FROM section_updates
        WHERE note_id = $2) AS "sectionUpdates",
      (SELECT current_sequence FROM note_sections
        WHERE note_id = $2 AND id = $2) AS "currentSequence",
      (SELECT COUNT(*)::integer FROM attachment_objects) AS objects,
      (SELECT COUNT(*)::integer FROM attachment_object_chunks) AS chunks,
      (SELECT reserved_bytes::integer FROM storage_accounts LIMIT 1) AS "reservedBytes",
      (SELECT used_bytes::integer FROM storage_accounts LIMIT 1) AS "usedBytes"
  `,
    [uploadId, noteId]
  );
  return requiredRow(result.rows[0], "content commit state");
}

export async function failingMigrationsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fortnote-pg-migration-failure-"));
  await mkdir(join(directory, "meta"));
  await Promise.all([
    writeFile(
      join(directory, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: Date.now() + 60_000,
            tag: "9999_expected_failure",
            breakpoints: true
          }
        ]
      })
    ),
    writeFile(
      join(directory, "9999_expected_failure.sql"),
      [
        "CREATE TABLE migration_failure_probe (id integer PRIMARY KEY);",
        "--> statement-breakpoint",
        "SELECT * FROM migration_failure_missing_table;"
      ].join("\n")
    )
  ]);
  return directory;
}

export async function activeConnectionCount(
  database: ApplicationDatabase
): Promise<number> {
  const result = await database.pool.query<{ count: number }>(`
    SELECT COUNT(*)::integer AS count
    FROM pg_stat_activity
    WHERE datname = current_database()
  `);
  return requiredRow(result.rows[0], "active connection count").count;
}

export async function migrationFailureState(database: ApplicationDatabase) {
  const result = await database.pool.query<{
    activeConnections: number;
    probeTable: string | null;
  }>(`
    SELECT
      to_regclass('public.migration_failure_probe')::text AS "probeTable",
      (SELECT COUNT(*)::integer FROM pg_stat_activity
        WHERE datname = current_database()) AS "activeConnections"
  `);
  return requiredRow(result.rows[0], "migration failure state");
}

export function requiredRow<T>(row: T | undefined, label: string): T {
  if (!row) {
    throw new Error(`PostgreSQL ${label} query returned no rows`);
  }
  return row;
}
