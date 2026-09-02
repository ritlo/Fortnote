import request from "supertest";
import { describe, expect, it } from "vitest";
import { getConfig } from "@server/config.js";
import { createApplicationDatabase } from "@server/db/application.js";
import type { PostgresApplicationDatabase } from "@server/db/postgres/client.js";
import { createApp } from "@server/http/app.js";
import {
  csrfHeaders,
  notePayload,
  registerPayload
} from "../support/http.js";

const postgresUrl = process.env.FORTNOTE_POSTGRES_TEST_URL;

describe.skipIf(!postgresUrl)("PostgreSQL runtime", () => {
  it("runs the application and stores encrypted attachments in PostgreSQL", async () => {
    const config = {
      ...getConfig({
        DATABASE_PROVIDER: "postgres",
        DATABASE_URL: postgresUrl,
        DATABASE_MAX_CONNECTIONS: "4"
      }),
      cookieSecure: false
    };
    const database = await createApplicationDatabase(config);
    expect(database.provider).toBe("postgres");
    const postgres = database as PostgresApplicationDatabase;

    try {
      await postgres.pool.query(
        "TRUNCATE TABLE users, attachment_objects CASCADE"
      );
      const agent = request.agent(createApp({ config, db: database }));
      const username = `postgres_runtime_${crypto.randomUUID()}`;
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
      const noteId = String(note.body.id);
      const attachmentId = crypto.randomUUID();
      const ciphertext = Buffer.from([4, 8, 15, 16, 23, 42]);

      await agent
        .post(`/api/notes/${noteId}/attachments`)
        .set(csrfHeaders())
        .set({
          "content-type": "application/octet-stream",
          "x-fortnote-attachment-id": attachmentId,
          "x-fortnote-size": String(ciphertext.byteLength),
          "x-fortnote-expected-key-epoch": "1",
          "x-fortnote-metadata-cipher": "postgres_attachment_metadata_cipher",
          "x-fortnote-metadata-nonce": "postgres_attachment_metadata_nonce",
          "x-fortnote-metadata-format-version": "2",
          "x-fortnote-encrypted-attachment-key": "postgres_encrypted_attachment_key",
          "x-fortnote-attachment-key-nonce": "postgres_attachment_key_nonce",
          "x-fortnote-file-nonce": "postgres_attachment_file_nonce"
        })
        .send(ciphertext)
        .expect(201);

      await expect(objectCounts(postgres)).resolves.toEqual({
        chunks: 1,
        objects: 1
      });
      const download = await agent
        .get(`/api/attachments/${attachmentId}`)
        .expect(200);
      expect(download.body).toEqual(ciphertext);

      await agent
        .delete(`/api/attachments/${attachmentId}`)
        .set(csrfHeaders())
        .expect(204);
      await expect(objectCounts(postgres)).resolves.toEqual({
        chunks: 0,
        objects: 0
      });
    } finally {
      await database.close();
    }
  });
});

async function objectCounts(database: PostgresApplicationDatabase) {
  const result = await database.pool.query<{
    chunks: number;
    objects: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::integer FROM attachment_objects) AS objects,
      (SELECT COUNT(*)::integer FROM attachment_object_chunks) AS chunks
  `);
  return result.rows[0];
}
