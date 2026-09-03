import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { getConfig, type ServerConfig } from "@server/config.js";
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
import { contentManifestHash } from "@server/content/manifests.js";
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
      expect(new Set(responses.map(({ body }) => body.manifestId)).size).toBe(1);
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

function sharingKeyPayload(version = 1) {
  return {
    sharingKeyVersion: version,
    publicKey: `contract_public_sharing_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    encryptedPrivateKey:
      `contract_encrypted_private_sharing_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    privateKeyNonce:
      `contract_private_key_nonce_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    formatVersion: 1
  };
}

function attachmentPayload(
  ciphertext = Buffer.from([4, 8, 15, 16, 23, 42])
) {
  return {
    id: crypto.randomUUID(),
    ciphertext
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

function committableContent(
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

async function uploadContent(
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
  return { ...content, manifestId: String(response.body.manifestId) };
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

async function attachmentObjectState(
  database: PostgresApplicationDatabase,
  attachmentId: string
) {
  const result = await database.pool.query<{
    byteLength: number;
    chunks: number;
    storedBytes: number;
    usedBytes: number;
  }>(`
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
  `, [attachmentId]);
  return requiredRow(result.rows[0], "attachment object state");
}

async function uploadLifecycleState(
  database: PostgresApplicationDatabase,
  uploadIds: string[],
  userId: string
) {
  const result = await database.pool.query<{
    expired: number;
    objects: number;
    reservedBytes: number;
    usedBytes: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::integer FROM content_uploads
        WHERE id = ANY($1::text[]) AND status = 'expired') AS expired,
      (SELECT COUNT(*)::integer FROM attachment_objects) AS objects,
      account.reserved_bytes::integer AS "reservedBytes",
      account.used_bytes::integer AS "usedBytes"
    FROM storage_accounts account
    WHERE account.user_id = $2
  `, [uploadIds, userId]);
  return requiredRow(result.rows[0], "upload lifecycle state");
}

async function storageAccountStates(
  database: PostgresApplicationDatabase,
  userIds: string[]
): Promise<Record<string, { reservedBytes: number; usedBytes: number }>> {
  const result = await database.pool.query<{
    reservedBytes: number;
    usedBytes: number;
    userId: string;
  }>(`
    SELECT
      user_id AS "userId",
      reserved_bytes::integer AS "reservedBytes",
      used_bytes::integer AS "usedBytes"
    FROM storage_accounts
    WHERE user_id = ANY($1::text[])
  `, [userIds]);
  return Object.fromEntries(
    result.rows.map(({ userId, reservedBytes, usedBytes }) => [
      userId,
      { reservedBytes, usedBytes }
    ])
  );
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

async function contentCommitState(
  database: PostgresApplicationDatabase,
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
  }>(`
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
  `, [uploadId, noteId]);
  return requiredRow(result.rows[0], "content commit state");
}

async function failingMigrationsDirectory(): Promise<string> {
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

async function activeConnectionCount(
  database: PostgresApplicationDatabase
): Promise<number> {
  const result = await database.pool.query<{ count: number }>(`
    SELECT COUNT(*)::integer AS count
    FROM pg_stat_activity
    WHERE datname = current_database()
  `);
  return requiredRow(result.rows[0], "active connection count").count;
}

async function migrationFailureState(database: PostgresApplicationDatabase) {
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

function requiredRow<T>(row: T | undefined, label: string): T {
  if (!row) {
    throw new Error(`PostgreSQL ${label} query returned no rows`);
  }
  return row;
}
