import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  expireContentUploadsPage,
  reconcileStorageAccountsPage,
  removeOrphanContentObjectsPage
} from "@server/content/maintenance.js";
import { createApplicationDatabase } from "@server/db/application.js";
import {
  createPostgresResources,
  type PostgresApplicationDatabase
} from "@server/db/postgres/client.js";
import type { ApplicationDatabase } from "@server/db/types.js";
import { createApp } from "@server/http/app.js";
import { readStoredAttachment, readStoredNote } from "../../e2e/support/stored.js";
import { protectedNotePayload } from "../notes/routes.fixtures.js";
import {
  csrfHeaders,
  notePayload,
  registerPayload
} from "../support/http.js";
import {
  activeConnectionCount,
  attachmentObjectState,
  attachmentPayload,
  committableContent,
  contentBeginPayload,
  contentCommitState,
  createPostgresHarness,
  eventPruningState,
  failingMigrationsDirectory,
  membershipRevocationState,
  migrationFailureState,
  noteDeletionState,
  postgresUrl,
  registerAndCreateNote,
  registerUser,
  requiredRow,
  rotationState,
  runtimeProviders,
  sharingKeyPayload,
  storageAccountStates,
  storageCounts,
  uploadAttachment,
  uploadContent,
  uploadLifecycleState
} from "./postgres-runtime.fixtures.js";

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
        await agent
          .get("/api/ready")
          .expect(200)
          .expect({ ok: true, checks: { database: "up" } });
        const account = await registerUser(agent, runtime.provider);
        const note = notePayload();
        await agent.post("/api/notes").set(csrfHeaders()).send(note).expect(201);
        const noteId = note.id;
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

        const contentBytes = Buffer.from("stored-content-probe-ciphertext");
        await uploadContent(agent, noteId, contentBytes, true);
        const inspected = await readStoredNote(account.username, harness.config);
        expect(inspected.attachments).toHaveLength(1);
        expect(inspected.attachments[0]?.bytes).toEqual(attachment.ciphertext);
        expect(inspected.contentBytes).toContainEqual(contentBytes);
        expect(inspected.databasePayload).toContain(note.encryptedNoteKey);
        const storageKey = inspected.attachments[0]!.storageKey;
        expect(await readStoredAttachment(storageKey, harness.config)).toEqual(attachment.ciphertext);

        await agent
          .delete(`/api/attachments/${attachment.id}`)
          .set(csrfHeaders())
          .expect(204);
        await agent.get(`/api/attachments/${attachment.id}`).expect(404);
        await expect(readStoredAttachment(storageKey, harness.config)).rejects.toThrow("Stored ciphertext not found");
      } finally {
        await harness.database.close();
        await harness.cleanup();
      }
    }
  );

  it.skipIf(!runtime.enabled)("returns canonical timestamps from both save APIs", async () => {
    const harness = await runtime.createHarness();
    try {
      const agent = request.agent(createApp({ config: harness.config, db: harness.database }));
      await registerUser(agent, `${runtime.provider}_timestamps`);
      for (const format of ["legacy", "protected"] as const) {
        const note = format === "legacy" ? notePayload() : protectedNotePayload();
        await agent.post("/api/notes").set(csrfHeaders()).send(note).expect(201);
        const response = await agent.put(`/api/notes/${note.id}`).set(csrfHeaders())
          .send(format === "legacy" ? {
            version: 1, contentCipher: "timestamp_content_cipher",
            contentNonce: "timestamp_content_nonce", contentLength: 24
          } : { rootVersion: 1, keyEpoch: 1 })
          .expect(200);
        const updatedAt = response.body.updatedAt as string;
        expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(new Date(updatedAt).toISOString()).toBe(updatedAt);
      }
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });

  it.skipIf(!runtime.enabled)("rejects mis-sized content chunks with provider-neutral errors", async () => {
    const harness = await runtime.createHarness();
    try {
      const declared = Buffer.from("declared-content-chunk-ciphertext");
      const write = (source: Buffer, maxBytes = 1024) =>
        harness.database.contentStorage.write({
          uploadId: crypto.randomUUID(),
          chunkIndex: 0,
          expectedLength: declared.byteLength,
          expectedHash: createHash("sha256").update(declared).digest("hex"),
          maxBytes,
          source: Readable.from([source])
        });
      // The chunk route maps these messages to 400 responses.
      await expect(write(declared.subarray(0, 8))).rejects.toThrow(
        "Encrypted content chunk length mismatch"
      );
      await expect(write(Buffer.concat([declared, declared]), declared.byteLength))
        .rejects.toThrow("Encrypted content chunk exceeds maximum bytes");
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });

  it.skipIf(!runtime.enabled)(
    "rotates account credentials and encrypted key material",
    async () => {
      const harness = await runtime.createHarness();
      try {
        const app = createApp({ config: harness.config, db: harness.database });
        const agent = request.agent(app);
        const account = await registerUser(agent, `${runtime.provider}_key_rotation`);
        const initial = registerPayload(account.username);

        await request(app)
          .get("/api/auth/kdf-params")
          .query({ username: account.username })
          .expect(200)
          .expect(({ body }) => {
            expect(body).toMatchObject({
              authKdfVersion: 1,
              vaultKdfVersion: 1
            });
          });
        await request(app)
          .get("/api/auth/recovery-params")
          .query({ username: account.username })
          .expect(200)
          .expect(({ body }) => {
            expect(body).toMatchObject({
              recoveryKdfVersion: 1,
              keyMaterialVersion: 1
            });
          });
        await agent.get("/api/key-material").expect(200).expect(({ body }) => {
          expect(body).toMatchObject({
            encryptedRootKey: initial.encryptedRootKey,
            keyMaterialVersion: 1
          });
        });

        const newAuthVerifier = `rotated_auth_verifier_${account.userId}`;
        await agent
          .put("/api/key-material")
          .set(csrfHeaders())
          .send({
            newAuthVerifier,
            authKdf: {
              salt: `rotated_auth_salt_${account.userId}`,
              opsLimit: 4,
              memLimit: 67108864,
              version: 1
            },
            encryptedRootKey: `rotated_encrypted_root_key_${account.userId}`,
            rootKeyNonce: `rotated_root_key_nonce_${account.userId}`,
            rootKeyFormatVersion: 2,
            rootKeyContextVersion: 2,
            vaultKdf: {
              salt: `rotated_vault_salt_${account.userId}`,
              opsLimit: 4,
              memLimit: 67108864,
              version: 1
            },
            keyMaterialVersion: 1
          })
          .expect(200)
          .expect({ keyMaterialVersion: 2 });
        await agent
          .put("/api/key-material")
          .set(csrfHeaders())
          .send({
            encryptedRootKey: `stale_encrypted_root_key_${account.userId}`,
            rootKeyNonce: `stale_root_key_nonce_${account.userId}`,
            vaultKdf: {
              salt: `stale_vault_salt_${account.userId}`,
              opsLimit: 4,
              memLimit: 67108864,
              version: 1
            },
            keyMaterialVersion: 1
          })
          .expect(409);

        await agent.post("/api/auth/logout").set(csrfHeaders()).expect(204);
        await request(app)
          .post("/api/auth/login")
          .set(csrfHeaders())
          .send({
            username: account.username,
            authVerifier: initial.authVerifier
          })
          .expect(401);
        await request(app)
          .post("/api/auth/login")
          .set(csrfHeaders())
          .send({ username: account.username, authVerifier: newAuthVerifier })
          .expect(200);
      } finally {
        await harness.database.close();
        await harness.cleanup();
      }
    }
  );

  it.skipIf(!runtime.enabled)(
    "retains and cleans sharing keys across membership changes",
    async () => {
      const harness = await runtime.createHarness();
      try {
        const app = createApp({ config: harness.config, db: harness.database });
        const owner = request.agent(app);
        const recipient = request.agent(app);
        await registerUser(owner, `${runtime.provider}_sharing_owner`);
        const member = await registerUser(
          recipient,
          `${runtime.provider}_sharing_recipient`
        );
        await recipient
          .put("/api/sharing-keys/current")
          .set(csrfHeaders())
          .send(sharingKeyPayload(1))
          .expect(201);
        await recipient
          .put("/api/sharing-keys/current")
          .set(csrfHeaders())
          .send(sharingKeyPayload(2))
          .expect(201);
        await owner
          .get("/api/sharing-keys/lookup")
          .query({ username: member.username })
          .expect(200)
          .expect(({ body }) => {
            expect(body).toMatchObject({
              userId: member.userId,
              sharingKeyVersion: 2,
              publicKey: sharingKeyPayload(2).publicKey
            });
            expect(body.encryptedPrivateKey).toBeUndefined();
          });

        const note = await owner
          .post("/api/notes")
          .set(csrfHeaders())
          .send(notePayload())
          .expect(201);
        const noteId = String(note.body.id);
        await owner
          .post(`/api/notes/${noteId}/memberships`)
          .set(csrfHeaders())
          .send({
            username: member.username,
            role: "viewer",
            sharingKeyVersion: 1,
            encryptedNoteKey: "contract_member_note_key_abcdefghijklmnopqrstuvwxyz",
            formatVersion: 1
          })
          .expect(201);
        await recipient
          .post("/api/sharing-keys/cleanup")
          .set(csrfHeaders())
          .expect(200)
          .expect({ deleted: 0 });

        await owner
          .delete(`/api/notes/${noteId}/memberships/${member.userId}`)
          .set(csrfHeaders())
          .expect(204);
        await recipient
          .post("/api/sharing-keys/cleanup")
          .set(csrfHeaders())
          .expect(200)
          .expect({ deleted: 1 });
        await recipient
          .get("/api/sharing-keys/current")
          .expect(200)
          .expect(({ body }) => {
            expect(body).toMatchObject(sharingKeyPayload(2));
          });
      } finally {
        await harness.database.close();
        await harness.cleanup();
      }
    }
  );
});

describe.skipIf(!postgresUrl)("PostgreSQL startup lifecycle", () => {
  it("applies bounded connection, statement, and lock waits", async () => {
    const harness = await createPostgresHarness();
    const postgres = harness.database as PostgresApplicationDatabase;
    try {
      if (harness.config.database.provider !== "postgres") {
        throw new Error("PostgreSQL harness returned SQLite configuration");
      }
      expect(postgres.pool.options.connectionTimeoutMillis).toBe(
        harness.config.database.connectionTimeoutMs
      );
      const settings = await postgres.pool.query<{
        lockTimeout: string;
        statementTimeout: string;
      }>(`
        SELECT
          current_setting('lock_timeout') AS "lockTimeout",
          current_setting('statement_timeout') AS "statementTimeout"
      `);
      expect(settings.rows[0]).toEqual({
        lockTimeout: "5s",
        statementTimeout: "30s"
      });
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });

  it("reapplies migrations and serves persisted data after restart", async () => {
    const harness = await createPostgresHarness();
    let database: ApplicationDatabase | null = harness.database;
    try {
      const firstAgent = request.agent(
        createApp({ config: harness.config, db: database })
      );
      const account = await registerUser(firstAgent, "postgres_restart");
      const note = await firstAgent
        .post("/api/notes")
        .set(csrfHeaders())
        .send(notePayload())
        .expect(201);
      const noteId = String(note.body.id);
      const attachment = attachmentPayload();
      await uploadAttachment(firstAgent, noteId, attachment).expect(201);

      await database.close();
      database = null;
      database = await createApplicationDatabase(harness.config);
      const restartedAgent = request.agent(
        createApp({ config: harness.config, db: database })
      );
      await restartedAgent
        .post("/api/auth/login")
        .set(csrfHeaders())
        .send({
          username: account.username,
          authVerifier: registerPayload(account.username).authVerifier
        })
        .expect(200);
      await restartedAgent.get(`/api/notes/${noteId}`).expect(200);
      const download = await restartedAgent
        .get(`/api/attachments/${attachment.id}`)
        .expect(200);
      expect(download.body).toEqual(attachment.ciphertext);
    } finally {
      await database?.close();
      await harness.cleanup();
    }
  });

  it("rolls back a failed migration, closes its pool, and recovers", async () => {
    const harness = await createPostgresHarness();
    const postgres = harness.database as PostgresApplicationDatabase;
    const migrationsDirectory = await failingMigrationsDirectory();
    try {
      if (harness.config.database.provider !== "postgres") {
        throw new Error("PostgreSQL harness returned SQLite configuration");
      }
      const connectionsBefore = await activeConnectionCount(postgres);
      await expect(
        createPostgresResources(harness.config.database, {
          migrationsDirectory
        })
      ).rejects.toThrow(/migration_failure_missing_table|does not exist/iu);

      expect(await migrationFailureState(postgres)).toEqual({
        activeConnections: connectionsBefore,
        probeTable: null
      });
      const restarted = await createApplicationDatabase(harness.config);
      await restarted.close();
      expect(await activeConnectionCount(postgres)).toBe(connectionsBefore);
    } finally {
      await rm(migrationsDirectory, { recursive: true, force: true });
      await harness.database.close();
      await harness.cleanup();
    }
  });
});

describe.skipIf(!postgresUrl)("PostgreSQL storage lifecycle", () => {
  it("releases pooled connections while an attachment upload stream stalls", async () => {
    const harness = await createPostgresHarness();
    try {
      if (harness.config.database.provider !== "postgres") {
        throw new Error("PostgreSQL harness returned SQLite configuration");
      }
      const resources = await createPostgresResources({
        ...harness.config.database,
        maxConnections: 1,
        connectionTimeoutMs: 2_000
      });
      try {
        const storageId = crypto.randomUUID();
        const ciphertext = Buffer.alloc(300 * 1024);
        for (let index = 0; index < ciphertext.length; index += 1) {
          ciphertext[index] = index % 251;
        }
        const source = new PassThrough();
        const written = resources.attachmentStorage.write({
          storageId,
          source,
          expectedBytes: ciphertext.length,
          maxBytes: ciphertext.length
        });
        source.write(ciphertext.subarray(0, 256 * 1024));

        // With the upload stalled, the single pooled connection must stay usable.
        let storedChunks = 0;
        for (let attempt = 0; attempt < 50 && storedChunks === 0; attempt += 1) {
          const result = await resources.pool.query<{ count: number }>(
            "SELECT COUNT(*)::integer AS count FROM attachment_object_chunks WHERE storage_key = $1",
            [storageId]
          );
          storedChunks = result.rows[0]?.count ?? 0;
          if (storedChunks === 0) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        expect(storedChunks).toBe(1);

        source.end(ciphertext.subarray(256 * 1024));
        await written;
        const parts: Buffer[] = [];
        for await (const part of await resources.attachmentStorage.read(storageId)) {
          parts.push(part as Buffer);
        }
        expect(Buffer.concat(parts)).toEqual(ciphertext);

        const rejectedId = crypto.randomUUID();
        await expect(resources.attachmentStorage.write({
          storageId: rejectedId,
          source: Readable.from([ciphertext]),
          expectedBytes: 1024,
          maxBytes: 1024
        })).rejects.toThrow("Encrypted attachment exceeds maximum bytes");
        const leftovers = await resources.pool.query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM attachment_objects WHERE storage_key = $1",
          [rejectedId]
        );
        expect(leftovers.rows[0]?.count).toBe(0);
      } finally {
        await resources.close();
      }
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });

  it("streams attachment ciphertext across database chunks in order", async () => {
    const harness = await createPostgresHarness();
    const postgres = harness.database as PostgresApplicationDatabase;
    try {
      const agent = request.agent(
        createApp({ config: harness.config, db: harness.database })
      );
      const noteId = await registerAndCreateNote(agent, "postgres_streaming");
      const ciphertext = Buffer.alloc(2 * 256 * 1024 + 37);
      for (let index = 0; index < ciphertext.length; index += 1) {
        ciphertext[index] = index % 251;
      }
      const attachment = attachmentPayload(ciphertext);

      await uploadAttachment(agent, noteId, attachment).expect(201);
      const stored = await attachmentObjectState(postgres, attachment.id);
      expect(stored).toMatchObject({
        byteLength: ciphertext.length,
        chunks: 3,
        storedBytes: ciphertext.length,
        usedBytes: ciphertext.length
      });
      const download = await agent
        .get(`/api/attachments/${attachment.id}`)
        .expect(200);
      expect(download.body).toEqual(ciphertext);

      await agent
        .delete(`/api/attachments/${attachment.id}`)
        .set(csrfHeaders())
        .expect(204);
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

  it("expires uploads, removes old orphans, and reconciles quota in pages", async () => {
    const harness = await createPostgresHarness();
    const postgres = harness.database as PostgresApplicationDatabase;
    const config = { ...harness.config, maintenanceBatchSize: 2 };
    const context = { config, db: harness.database };
    try {
      const app = createApp(context);
      const owner = request.agent(app);
      const account = await registerUser(owner, "postgres_maintenance_owner");
      const note = await owner
        .post("/api/notes")
        .set(csrfHeaders())
        .send(notePayload())
        .expect(201);
      const noteId = String(note.body.id);
      const expiring = await Promise.all(
        ["expired one", "expired two", "expired three"].map((value) =>
          uploadContent(owner, noteId, Buffer.from(value))
        )
      );
      const committed = await uploadContent(
        owner,
        noteId,
        Buffer.from("durable committed content"),
        true
      );
      await postgres.pool.query(`
        UPDATE content_uploads
        SET expires_at = '2000-01-01T00:00:00.000Z'
        WHERE status <> 'committed'
      `);

      await expect(expireContentUploadsPage(context)).resolves.toEqual({
        processed: 2,
        hasMore: true
      });
      await expect(expireContentUploadsPage(context)).resolves.toEqual({
        processed: 1,
        hasMore: false
      });
      await expect(
        uploadLifecycleState(
          postgres,
          expiring.map(({ payload }) => payload.uploadId),
          account.userId
        )
      ).resolves.toEqual({
        expired: 3,
        objects: 1,
        reservedBytes: 0,
        usedBytes: committed.bytes.length
      });
      const committedDownload = await owner
        .get(`/api/content/manifests/${committed.manifestId}/chunks/0`)
        .expect(200);
      expect(committedDownload.body).toEqual(committed.bytes);

      const orphanIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (const storageId of orphanIds) {
        await postgres.attachmentStorage.write({
          storageId,
          source: Readable.from(Buffer.from("old orphan ciphertext")),
          expectedBytes: 21,
          maxBytes: 1024
        });
      }
      await postgres.pool.query(
        "UPDATE attachment_objects SET created_at = $1 WHERE storage_key = ANY($2::uuid[])",
        ["2000-01-01T00:00:00.000Z", orphanIds]
      );
      await expect(
        removeOrphanContentObjectsPage(context)
      ).resolves.toEqual({ scanned: 2, removed: 2, done: false });
      await expect(
        removeOrphanContentObjectsPage(context)
      ).resolves.toEqual({ scanned: 1, removed: 1, done: true });
      expect((await storageCounts(postgres)).objects).toBe(1);

      const otherUserIds = [];
      for (const label of ["postgres_reconcile_two", "postgres_reconcile_three"]) {
        const agent = request.agent(app);
        const other = await registerUser(agent, label);
        otherUserIds.push(other.userId);
        await agent
          .post("/api/notes")
          .set(csrfHeaders())
          .send(notePayload())
          .expect(201);
      }
      await postgres.pool.query(`
        INSERT INTO storage_accounts (user_id, used_bytes, reserved_bytes)
        SELECT id, 999, 999 FROM users
        ON CONFLICT (user_id) DO UPDATE
        SET used_bytes = 999, reserved_bytes = 999
      `);

      const firstPage = await reconcileStorageAccountsPage(context);
      expect(firstPage).toMatchObject({ processed: 2, hasMore: true });
      await expect(
        reconcileStorageAccountsPage(context, firstPage.nextUserId)
      ).resolves.toMatchObject({ processed: 1, hasMore: false });
      await expect(
        storageAccountStates(postgres, [account.userId, ...otherUserIds])
      ).resolves.toEqual({
        [account.userId]: {
          reservedBytes: 0,
          usedBytes: committed.bytes.length
        },
        [otherUserIds[0]!]: { reservedBytes: 0, usedBytes: 0 },
        [otherUserIds[1]!]: { reservedBytes: 0, usedBytes: 0 }
      });
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });
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

  it("publishes one manifest for concurrent content commits", async () => {
    const harness = await createPostgresHarness();
    const postgres = harness.database as PostgresApplicationDatabase;
    try {
      const agent = request.agent(
        createApp({ config: harness.config, db: harness.database })
      );
      const noteId = await registerAndCreateNote(agent, "concurrent_commit");
      const content = committableContent(noteId);
      await agent
        .post("/api/content/uploads")
        .set(csrfHeaders())
        .send(content.payload)
        .expect(201);
      await agent
        .put(`/api/content/uploads/${content.payload.uploadId}/chunks/0`)
        .set(csrfHeaders())
        .set("content-type", "application/octet-stream")
        .set("content-length", String(content.bytes.byteLength))
        .set("x-fortnote-cipher-hash", content.cipherHash)
        .set("x-fortnote-nonce", content.nonce.toString("base64"))
        .send(content.bytes)
        .expect(204);

      const responses = await Promise.all(
        [crypto.randomUUID(), crypto.randomUUID()].map((requestId) =>
          agent
            .post(`/api/content/uploads/${content.payload.uploadId}/commit`)
            .set(csrfHeaders())
            .send({
              requestId,
              updateId: content.payload.updateId,
              expectedKeyEpoch: 1
            })
        )
      );

      expect(responses.map(({ status }) => status)).toEqual([201, 201]);
      expect(new Set(responses.map(({ body }) => String(body.manifestId))).size).toBe(1);
      await expect(
        contentCommitState(postgres, content.payload.uploadId, noteId)
      ).resolves.toEqual({
        chunks: 1,
        currentSequence: 1,
        manifests: 1,
        objects: 1,
        reservedBytes: 0,
        sectionUpdates: 1,
        usedBytes: content.bytes.byteLength
      });
    } finally {
      await harness.database.close();
      await harness.cleanup();
    }
  });
});
