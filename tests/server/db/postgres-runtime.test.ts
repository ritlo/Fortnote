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
  const username = `${label}_${crypto.randomUUID()}`;
  await agent
    .post("/api/auth/register")
    .set(csrfHeaders())
    .send(registerPayload(username))
    .expect(201);
  const note = await agent
    .post("/api/notes")
    .set(csrfHeaders())
    .send(notePayload())
    .expect(201);
  return String(note.body.id);
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
