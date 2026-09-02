import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { getConfig, type ServerConfig } from "@server/config.js";
import { createApplicationDatabase } from "@server/db/application.js";
import type { PostgresApplicationDatabase } from "@server/db/postgres/client.js";
import type { ApplicationDatabase } from "@server/db/types.js";
import { createApp } from "@server/http/app.js";
import {
  csrfHeaders,
  notePayload,
  registerPayload
} from "../support/http.js";

const postgresUrl = process.env.FORTNOTE_POSTGRES_TEST_URL;

interface RuntimeHarness {
  config: ServerConfig;
  database: ApplicationDatabase;
  cleanup(): Promise<void>;
}

type HttpAgent = ReturnType<typeof request.agent>;

const runtimeProviders: Array<{
  createHarness: () => Promise<RuntimeHarness>;
  enabled: boolean;
  name: string;
  provider: ApplicationDatabase["provider"];
}> = [
  {
    createHarness: createSqliteHarness,
    enabled: true,
    name: "SQLite",
    provider: "sqlite"
  },
  {
    createHarness: createPostgresHarness,
    enabled: Boolean(postgresUrl),
    name: "PostgreSQL",
    provider: "postgres"
  }
];

describe.each(runtimeProviders)("$name runtime contract", (runtime) => {
  it.skipIf(!runtime.enabled)(
    "runs auth, note, and encrypted attachment workflows",
    async () => {
      const harness = await runtime.createHarness();
      try {
        expect(harness.database.provider).toBe(runtime.provider);
        const agent = request.agent(
          createApp({ config: harness.config, db: harness.database })
        );
        const noteId = await registerAndCreateNote(agent, runtime.provider);
        const attachment = attachmentPayload();

        await uploadAttachment(agent, noteId, attachment).expect(201);
        const stored = await harness.database.attachmentMetadata.find(
          attachment.id
        );
        expect(stored).toMatchObject({
          id: attachment.id,
          noteId,
          size: attachment.ciphertext.byteLength
        });
        const download = await agent
          .get(`/api/attachments/${attachment.id}`)
          .expect(200);
        expect(download.body).toEqual(attachment.ciphertext);

        await agent
          .delete(`/api/attachments/${attachment.id}`)
          .set(csrfHeaders())
          .expect(204);
        await agent.get(`/api/attachments/${attachment.id}`).expect(404);
      } finally {
        await harness.database.close();
        await harness.cleanup();
      }
    }
  );
});

describe.skipIf(!postgresUrl)("PostgreSQL concurrency", () => {
  it("allows only one concurrent attachment reservation within quota", async () => {
    const harness = await createPostgresHarness(6);
    const postgres = harness.database as PostgresApplicationDatabase;
    try {
      const agent = request.agent(
        createApp({ config: harness.config, db: harness.database })
      );
      const noteId = await registerAndCreateNote(agent, "concurrent_quota");
      const uploads = [attachmentPayload(), attachmentPayload()];
      const responses = await Promise.all(
        uploads.map((attachment) =>
          uploadAttachment(agent, noteId, attachment)
        )
      );

      expect(responses.map(({ status }) => status).sort()).toEqual([201, 413]);
      await expect(storageCounts(postgres)).resolves.toEqual({
        chunks: 1,
        objects: 1,
        reservedBytes: 0,
        usedBytes: 6
      });
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });

  it("serializes concurrent attachment deletion without quota underflow", async () => {
    const harness = await createPostgresHarness();
    const postgres = harness.database as PostgresApplicationDatabase;
    try {
      const agent = request.agent(
        createApp({ config: harness.config, db: harness.database })
      );
      const noteId = await registerAndCreateNote(agent, "concurrent_delete");
      const attachment = attachmentPayload();
      await uploadAttachment(agent, noteId, attachment).expect(201);

      const responses = await Promise.all([
        agent
          .delete(`/api/attachments/${attachment.id}`)
          .set(csrfHeaders()),
        agent
          .delete(`/api/attachments/${attachment.id}`)
          .set(csrfHeaders())
      ]);

      expect(responses.map(({ status }) => status).sort()).toEqual([204, 404]);
      await expect(storageCounts(postgres)).resolves.toEqual({
        chunks: 0,
        objects: 0,
        reservedBytes: 0,
        usedBytes: 0
      });
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });

  it("allows only one concurrent content reservation within quota", async () => {
    const harness = await createPostgresHarness(6);
    const postgres = harness.database as PostgresApplicationDatabase;
    try {
      const agent = request.agent(
        createApp({ config: harness.config, db: harness.database })
      );
      const noteId = await registerAndCreateNote(agent, "concurrent_content");
      const payloads = [contentBeginPayload(noteId), contentBeginPayload(noteId)];
      const responses = await Promise.all(
        payloads.map((payload) =>
          agent
            .post("/api/content/uploads")
            .set(csrfHeaders())
            .send(payload)
        )
      );

      expect(responses.map(({ status }) => status).sort()).toEqual([201, 413]);
      await expect(storageCounts(postgres)).resolves.toEqual({
        chunks: 0,
        objects: 0,
        reservedBytes: 6,
        usedBytes: 0
      });
      const accepted = responses.findIndex(({ status }) => status === 201);
      await agent
        .delete(`/api/content/uploads/${payloads[accepted]!.uploadId}`)
        .set(csrfHeaders())
        .expect(204);
      expect((await storageCounts(postgres)).reservedBytes).toBe(0);
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });

  it("serializes concurrent permanent note deletion and ciphertext cleanup", async () => {
    const harness = await createPostgresHarness();
    const postgres = harness.database as PostgresApplicationDatabase;
    try {
      const agent = request.agent(
        createApp({ config: harness.config, db: harness.database })
      );
      const noteId = await registerAndCreateNote(agent, "concurrent_note_delete");
      const attachment = attachmentPayload();
      await uploadAttachment(agent, noteId, attachment).expect(201);

      const responses = await Promise.all([
        agent.delete(`/api/notes/${noteId}/permanent`).set(csrfHeaders()),
        agent.delete(`/api/notes/${noteId}/permanent`).set(csrfHeaders())
      ]);

      expect(responses.map(({ status }) => status).sort()).toEqual([204, 404]);
      await expect(noteDeletionState(postgres, noteId)).resolves.toEqual({
        attachments: 0,
        notes: 0,
        objects: 0,
        permanentDeleteEvents: 1,
        reservedBytes: 0,
        usedBytes: 0
      });
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });

  it("serializes concurrent membership revocation", async () => {
    const harness = await createPostgresHarness();
    const postgres = harness.database as PostgresApplicationDatabase;
    try {
      const app = createApp({ config: harness.config, db: harness.database });
      const owner = request.agent(app);
      const collaborator = request.agent(app);
      const noteId = await registerAndCreateNote(owner, "concurrent_revoke_owner");
      const member = await registerUser(collaborator, "concurrent_revoke_member");
      await collaborator
        .put("/api/sharing-keys/current")
        .set(csrfHeaders())
        .send(sharingKeyPayload())
        .expect(201);
      await owner
        .post(`/api/notes/${noteId}/memberships`)
        .set(csrfHeaders())
        .send({
          username: member.username,
          role: "editor",
          sharingKeyVersion: 1,
          encryptedNoteKey: "concurrent_member_note_key_abcdefghijklmnopqrstuvwxyz",
          formatVersion: 1
        })
        .expect(201);

      const responses = await Promise.all([
        owner
          .delete(`/api/notes/${noteId}/memberships/${member.userId}`)
          .set(csrfHeaders()),
        owner
          .delete(`/api/notes/${noteId}/memberships/${member.userId}`)
          .set(csrfHeaders())
      ]);

      expect(responses.map(({ status }) => status).sort()).toEqual([204, 404]);
      await expect(
        membershipRevocationState(postgres, noteId, member.userId)
      ).resolves.toEqual({
        keyShares: 0,
        revokeEvents: 1,
        status: "revoked"
      });
      await collaborator.get(`/api/notes/${noteId}`).expect(404);
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });

  it("allows only one concurrent key rotation for a note version", async () => {
    const harness = await createPostgresHarness();
    const postgres = harness.database as PostgresApplicationDatabase;
    try {
      const agent = request.agent(
        createApp({ config: harness.config, db: harness.database })
      );
      const noteId = await registerAndCreateNote(agent, "concurrent_rotation");
      const rotation = {
        encryptedNoteKey: "concurrent_rotated_note_key_abcdefghijklmnopqrstuvwxyz",
        noteKeyNonce: "concurrent_rotated_note_nonce_abcdefghijklmnopqrstuvwxyz",
        contentCipher: "concurrent_rotated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "concurrent_rotated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 512,
        version: 1,
        shares: [],
        attachmentKeys: []
      };
      const responses = await Promise.all([
        agent
          .post(`/api/notes/${noteId}/key-rotation`)
          .set(csrfHeaders())
          .send(rotation),
        agent
          .post(`/api/notes/${noteId}/key-rotation`)
          .set(csrfHeaders())
          .send(rotation)
      ]);

      expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
      await expect(rotationState(postgres, noteId)).resolves.toEqual({
        keyEpoch: 2,
        rotationEvents: 1,
        version: 2
      });
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });

  it("prunes events after concurrent acknowledgements reach the same cursor", async () => {
    const harness = await createPostgresHarness();
    const postgres = harness.database as PostgresApplicationDatabase;
    try {
      const app = createApp({ config: harness.config, db: harness.database });
      const owner = request.agent(app);
      const collaborator = request.agent(app);
      const noteId = await registerAndCreateNote(owner, "concurrent_ack_owner");
      const member = await registerUser(collaborator, "concurrent_ack_member");
      await collaborator
        .put("/api/sharing-keys/current")
        .set(csrfHeaders())
        .send(sharingKeyPayload())
        .expect(201);
      await owner
        .post(`/api/notes/${noteId}/memberships`)
        .set(csrfHeaders())
        .send({
          username: member.username,
          role: "editor",
          sharingKeyVersion: 1,
          encryptedNoteKey: "concurrent_ack_note_key_abcdefghijklmnopqrstuvwxyz",
          formatVersion: 1
        })
        .expect(201);
      const cursorResult = await postgres.pool.query<{ cursor: number }>(
        "SELECT MAX(cursor)::integer AS cursor FROM note_events"
      );
      const cursor = requiredRow(
        cursorResult.rows[0],
        "latest event cursor"
      ).cursor;

      const responses = await Promise.all([
        owner
          .post("/api/events/ack")
          .set(csrfHeaders())
          .send({ cursor }),
        collaborator
          .post("/api/events/ack")
          .set(csrfHeaders())
          .send({ cursor })
      ]);

      expect(responses.map(({ status }) => status)).toEqual([204, 204]);
      await expect(eventPruningState(postgres, cursor)).resolves.toEqual({
        acknowledgements: 2,
        events: 0,
        minimumCursor: cursor
      });
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });
});

async function createSqliteHarness(): Promise<RuntimeHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), "fortnote-sqlite-contract-"));
  const config: ServerConfig = {
    ...getConfig({}),
    database: { provider: "sqlite", path: ":memory:" },
    dataDir,
    cookieSecure: false
  };
  try {
    const database = await createApplicationDatabase(config);
    return {
      config,
      database,
      cleanup: () => rm(dataDir, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

async function createPostgresHarness(
  storageQuotaBytes?: number
): Promise<RuntimeHarness> {
  if (!postgresUrl) {
    throw new Error("FORTNOTE_POSTGRES_TEST_URL is required");
  }
  const config: ServerConfig = {
    ...getConfig({
      DATABASE_PROVIDER: "postgres",
      DATABASE_URL: postgresUrl,
      DATABASE_MAX_CONNECTIONS: "8"
    }),
    ...(storageQuotaBytes === undefined ? {} : { storageQuotaBytes }),
    cookieSecure: false
  };
  const database = await createApplicationDatabase(config);
  try {
    const postgres = database as PostgresApplicationDatabase;
    await postgres.pool.query(
      "TRUNCATE TABLE users, attachment_objects CASCADE"
    );
    return { config, database, cleanup: () => Promise.resolve() };
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function registerAndCreateNote(
  agent: HttpAgent,
  label: string
): Promise<string> {
  await registerUser(agent, label);
  const note = await agent
    .post("/api/notes")
    .set(csrfHeaders())
    .send(notePayload())
    .expect(201);
  return String(note.body.id);
}

async function registerUser(agent: HttpAgent, label: string) {
  const username = `${label}_${crypto.randomUUID()}`;
  await agent
    .post("/api/auth/register")
    .set(csrfHeaders())
    .send(registerPayload(username))
    .expect(201);
  const session = await agent.get("/api/auth/me").expect(200);
  return { userId: String(session.body.id), username };
}

function sharingKeyPayload() {
  return {
    sharingKeyVersion: 1,
    publicKey: "contract_public_sharing_key_abcdefghijklmnopqrstuvwxyz",
    encryptedPrivateKey:
      "contract_encrypted_private_sharing_key_abcdefghijklmnopqrstuvwxyz",
    privateKeyNonce: "contract_private_key_nonce_abcdefghijklmnopqrstuvwxyz",
    formatVersion: 1
  };
}

function attachmentPayload() {
  return {
    id: crypto.randomUUID(),
    ciphertext: Buffer.from([4, 8, 15, 16, 23, 42])
  };
}

function contentBeginPayload(noteId: string) {
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

function uploadAttachment(
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

async function storageCounts(database: PostgresApplicationDatabase) {
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

async function noteDeletionState(
  database: PostgresApplicationDatabase,
  noteId: string
) {
  const result = await database.pool.query<{
    attachments: number;
    notes: number;
    objects: number;
    permanentDeleteEvents: number;
    reservedBytes: number;
    usedBytes: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::integer FROM notes WHERE id = $1) AS notes,
      (SELECT COUNT(*)::integer FROM attachments WHERE note_id = $1) AS attachments,
      (SELECT COUNT(*)::integer FROM attachment_objects) AS objects,
      (SELECT COUNT(*)::integer FROM note_events
        WHERE note_id = $1 AND event_type = 'note.permanently_deleted')
        AS "permanentDeleteEvents",
      (SELECT reserved_bytes::integer FROM storage_accounts LIMIT 1) AS "reservedBytes",
      (SELECT used_bytes::integer FROM storage_accounts LIMIT 1) AS "usedBytes"
  `, [noteId]);
  return requiredRow(result.rows[0], "note deletion state");
}

async function membershipRevocationState(
  database: PostgresApplicationDatabase,
  noteId: string,
  userId: string
) {
  const result = await database.pool.query<{
    keyShares: number;
    revokeEvents: number;
    status: string;
  }>(`
    SELECT
      (SELECT status FROM note_memberships
        WHERE note_id = $1 AND user_id = $2) AS status,
      (SELECT COUNT(*)::integer FROM note_key_shares
        WHERE note_id = $1 AND recipient_user_id = $2) AS "keyShares",
      (SELECT COUNT(*)::integer FROM note_events
        WHERE note_id = $1 AND event_type = 'membership.revoked') AS "revokeEvents"
  `, [noteId, userId]);
  return requiredRow(result.rows[0], "membership revocation state");
}

async function rotationState(
  database: PostgresApplicationDatabase,
  noteId: string
) {
  const result = await database.pool.query<{
    keyEpoch: number;
    rotationEvents: number;
    version: number;
  }>(`
    SELECT
      (SELECT key_epoch FROM notes WHERE id = $1) AS "keyEpoch",
      (SELECT version FROM notes WHERE id = $1) AS version,
      (SELECT COUNT(*)::integer FROM note_events
        WHERE note_id = $1 AND event_type = 'note.updated'
          AND payload_metadata LIKE '%"keyRotated":true%') AS "rotationEvents"
  `, [noteId]);
  return requiredRow(result.rows[0], "rotation state");
}

async function eventPruningState(
  database: PostgresApplicationDatabase,
  cursor: number
) {
  const result = await database.pool.query<{
    acknowledgements: number;
    events: number;
    minimumCursor: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::integer FROM event_cursors
        WHERE cursor >= $1) AS acknowledgements,
      (SELECT COUNT(*)::integer FROM note_events
        WHERE cursor <= $1) AS events,
      (SELECT MIN(cursor)::integer FROM event_cursors) AS "minimumCursor"
  `, [cursor]);
  return requiredRow(result.rows[0], "event pruning state");
}

function requiredRow<T>(row: T | undefined, label: string): T {
  if (!row) {
    throw new Error(`PostgreSQL ${label} query returned no rows`);
  }
  return row;
}
