import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer, request as sendHttpRequest } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@server/auth/session.js";
import type { AppDb } from "@server/db/client.js";
import type { RealtimePublisher } from "@server/realtime/types.js";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../support/http.js";
import { contentManifestHash, type ContentKind } from "@server/content/manifests.js";
import { testSql } from "../support/database.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type TestAgent = Awaited<ReturnType<typeof registerAgent>>;

interface TestChunk {
  bytes: Buffer;
  cipherHash: string;
  nonce: Buffer;
}

const apps: TestApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await (app.locals.db as AppDb).close();
    fs.rmSync(String(app.locals.config.dataDir), { recursive: true, force: true });
  }
});

function usesLocalUploads(app: TestApp): boolean {
  return (app.locals.db as AppDb).contentStorage.usesLocalUploadDirectories;
}

describe("resumable encrypted content routes", () => {
  it("begins idempotently, reports progress, reserves quota, and aborts cleanly", async () => {
    const { app, agent, noteId } = await setup({ storageQuotaBytes: 15 });
    const chunk = testChunk("reserved");
    const payload = beginPayload(noteId, [chunk]);

    const created = await begin(agent, payload).expect(201);
    expect(created.body).toMatchObject({
      uploadId: payload.uploadId,
      status: "receiving",
      receivedChunkIndexes: [],
      reservedBytes: chunk.bytes.length
    });
    await begin(agent, payload).expect(200);
    await begin(agent, { ...payload, updateId: crypto.randomUUID() }).expect(409);

    const quota = await agent.get("/api/content/quota").expect(200);
    expect(quota.body).toMatchObject({ usedBytes: 0, reservedBytes: chunk.bytes.length });
    await begin(agent, beginPayload(noteId, [testChunk("another reservation")])).expect(
      413
    );

    await putChunk(agent, payload.uploadId, 0, chunk).expect(204);
    const status = await agent
      .get(`/api/content/uploads/${payload.uploadId}`)
      .expect(200);
    expect(status.body).toMatchObject({ status: "complete", receivedChunkIndexes: [0] });
    if (usesLocalUploads(app)) {
      expect(
        fs.existsSync(
          path.join(
            String(app.locals.config.dataDir),
            "content",
            payload.uploadId,
            "0.bin"
          )
        )
      ).toBe(true);
    }

    await agent
      .delete(`/api/content/uploads/${payload.uploadId}`)
      .set(csrfHeaders())
      .expect(204);
    expect((await agent.get("/api/content/quota").expect(200)).body).toMatchObject({
      usedBytes: 0,
      reservedBytes: 0
    });
    expect(
      fs.existsSync(
        path.join(String(app.locals.config.dataDir), "content", payload.uploadId)
      )
    ).toBe(false);

    const restarted = await begin(agent, payload).expect(200);
    expect(restarted.body).toMatchObject({
      status: "receiving",
      receivedChunkIndexes: [],
      reservedBytes: chunk.bytes.length
    });
    await agent
      .delete(`/api/content/uploads/${payload.uploadId}`)
      .set(csrfHeaders())
      .expect(204);
  });

  it("accepts reordered and identical chunks, rejects conflicts, and publishes atomically", async () => {
    const publishContentManifest = vi.fn();
    const realtime = {
      closeNoteAccess: vi.fn(),
      closeSession: vi.fn(),
      publishEvents: vi.fn(),
      publishContentManifest
    } satisfies RealtimePublisher;
    const { app, agent, noteId } = await setup({}, realtime);
    const chunks = [
      testChunk("first encrypted chunk"),
      testChunk("second encrypted chunk")
    ];
    const payload = beginPayload(noteId, chunks);
    await begin(agent, payload).expect(201);

    await putChunk(agent, payload.uploadId, 1, chunks[1]!).expect(204);
    await putChunk(agent, payload.uploadId, 1, chunks[1]!).expect(204);
    await putChunk(
      agent,
      payload.uploadId,
      1,
      testChunk("different encrypted data")
    ).expect(409);
    expect(await manifestCount(app)).toBe(0);

    await putChunk(agent, payload.uploadId, 0, chunks[0]!).expect(204);
    const requestId = crypto.randomUUID();
    const committed = await commit(agent, payload, requestId).expect(201);
    expect(committed.body).toMatchObject({
      manifestId: requestId,
      uploadId: payload.uploadId,
      updateId: payload.updateId,
      sectionId: "root",
      firstSequence: 1,
      lastSequence: 1,
      totalCipherBytes: chunks.reduce((total, chunk) => total + chunk.bytes.length, 0)
    });
    expect(await manifestCount(app)).toBe(1);
    expect(publishContentManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "crdt-manifest",
        manifestId: requestId,
        uploadId: payload.uploadId,
        updateId: payload.updateId,
        serverSequence: 1
      })
    );
    const history = await app.locals.db.sectionHistory.list({
      noteId,
      sectionId: "root",
      keyEpoch: 1,
      afterSequence: 0,
      maxItems: app.locals.config.historyPageMaxItems,
      maxBytes: app.locals.config.historyPageMaxBytes
    });
    expect(history?.entries).toEqual([
      expect.objectContaining({
        storage: "manifest",
        manifestId: requestId,
        uploadId: payload.uploadId,
        serverSequence: 1
      })
    ]);

    const retried = await commit(agent, payload, crypto.randomUUID()).expect(201);
    expect(retried.body.manifestId).toBe(requestId);
    await agent
      .delete(`/api/content/uploads/${payload.uploadId}`)
      .set(csrfHeaders())
      .expect(409);
    expect((await agent.get("/api/content/quota").expect(200)).body).toMatchObject({
      usedBytes: chunks.reduce((total, chunk) => total + chunk.bytes.length, 0),
      reservedBytes: 0
    });

    const downloaded = await agent
      .get(`/api/content/manifests/${requestId}/chunks/1`)
      .buffer(true)
      .parse((response, callback) => {
        const values: Buffer[] = [];
        response.on("data", (value: Buffer) => values.push(value));
        response.on("end", () => {
          callback(null, Buffer.concat(values));
        });
      })
      .expect(200);
    expect(downloaded.body).toEqual(chunks[1]!.bytes);
    expect(downloaded.headers["x-fortnote-cipher-hash"]).toBe(chunks[1]!.cipherHash);
    expect(downloaded.headers["x-fortnote-nonce"]).toBe(
      chunks[1]!.nonce.toString("base64")
    );
  });

  it("rejects missing and corrupted manifests without partial publication", async () => {
    const { app, agent, noteId } = await setup();
    const chunks = [testChunk("left"), testChunk("right")];
    const missing = beginPayload(noteId, chunks);
    await begin(agent, missing).expect(201);
    await putChunk(agent, missing.uploadId, 0, chunks[0]!).expect(204);
    const missingCommit = await commit(agent, missing).expect(409);
    expect(missingCommit.body.error.code).toBe("chunk_missing");
    expect(await manifestCount(app)).toBe(0);

    const corrupted = {
      ...beginPayload(noteId, chunks),
      manifestHash: "0".repeat(64)
    };
    await begin(agent, corrupted).expect(201);
    await putChunk(agent, corrupted.uploadId, 1, chunks[1]!).expect(204);
    await putChunk(agent, corrupted.uploadId, 0, chunks[0]!).expect(204);
    const corruptCommit = await commit(agent, corrupted).expect(409);
    expect(corruptCommit.body.error.code).toBe("manifest_mismatch");
    expect(await manifestCount(app)).toBe(0);
  });

  it("rechecks the note epoch at commit and retains the reservation until abort", async () => {
    const { app, agent, noteId } = await setup();
    const chunk = testChunk("epoch fenced content");
    const payload = beginPayload(noteId, [chunk]);
    await begin(agent, payload).expect(201);
    await putChunk(agent, payload.uploadId, 0, chunk).expect(204);

    const db = app.locals.db as AppDb;
    await testSql(db).run("UPDATE notes SET key_epoch = 2 WHERE id = ?", noteId);
    const response = await commit(agent, payload).expect(409);
    expect(response.body.error.code).toBe("stale_epoch");
    expect((await agent.get("/api/content/quota").expect(200)).body.reservedBytes).toBe(
      chunk.bytes.length
    );

    await agent
      .delete(`/api/content/uploads/${payload.uploadId}`)
      .set(csrfHeaders())
      .expect(204);
    expect((await agent.get("/api/content/quota").expect(200)).body.reservedBytes).toBe(
      0
    );
  });

  it("rechecks authorization and epoch after the streamed chunk body is read", async () => {
    const { app, agent, noteId } = await setup();
    const chunk = testChunk("slow encrypted content body");
    const payload = beginPayload(noteId, [chunk]);
    await begin(agent, payload).expect(201);

    const response = await putChunkDuringMutation(
      app,
      "content-owner",
      payload.uploadId,
      chunk,
      async (db) => {
        await testSql(db).run("UPDATE notes SET key_epoch = 2 WHERE id = ?", noteId);
      }
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "stale_epoch" } });
    const db = app.locals.db as AppDb;
    expect(
      (await testSql(db).get(
        "SELECT COUNT(*) AS count FROM content_chunks WHERE upload_id = ?",
        payload.uploadId
      ))!.count
    ).toBe(0);
    expect(
      fs.existsSync(
        path.join(String(app.locals.config.dataDir), "content", payload.uploadId, "0.bin")
      )
    ).toBe(false);

    await testSql(db).run("UPDATE notes SET key_epoch = 1 WHERE id = ?", noteId);
    await agent
      .delete(`/api/content/uploads/${payload.uploadId}`)
      .set(csrfHeaders())
      .expect(204);
  });

  it("compacts only acknowledged same-section and same-epoch updates", async () => {
    const { app, agent, noteId } = await setup();
    const first = await uploadAndCommit(agent, noteId, [testChunk("sequence one")]);
    const second = await uploadAndCommit(agent, noteId, [testChunk("sequence two")]);
    const checkpoint = await uploadAndCommit(
      agent,
      noteId,
      [testChunk("checkpoint through sequence one")],
      "checkpoint",
      1
    );
    expect(checkpoint.firstSequence).toBe(3);

    const db = app.locals.db as AppDb;
    const updates = await testSql(db).all(
      `
        SELECT update_id AS updateId, server_sequence AS serverSequence, kind
        FROM section_updates WHERE note_id = ? ORDER BY server_sequence
      `,
      noteId
    );
    expect(updates).toEqual([
      { updateId: second.updateId, serverSequence: 2, kind: "update" },
      { updateId: checkpoint.updateId, serverSequence: 3, kind: "checkpoint" }
    ]);
    expect(updates.some(({ updateId }) => updateId === first.updateId)).toBe(false);
  });

  it("conceals notes, uploads, and committed chunks from nonmembers", async () => {
    const { app, agent: owner, noteId } = await setup();
    const stranger = await registerAgent(app, "stranger");
    const payload = beginPayload(noteId, [testChunk("private")]);

    await begin(stranger, payload).expect(404);
    await begin(owner, payload).expect(201);
    await stranger.get(`/api/content/uploads/${payload.uploadId}`).expect(404);
    await putChunk(owner, payload.uploadId, 0, testChunk("private")).expect(204);
    const manifest = await commit(owner, payload).expect(201);
    await stranger
      .get(`/api/content/manifests/${String(manifest.body.manifestId)}/chunks/0`)
      .expect(404);
  });
});

async function setup(
  overrides: Parameters<typeof createTestApp>[0] = {},
  realtime?: RealtimePublisher
) {
  const app = await createTestApp(overrides, realtime);
  apps.push(app);
  const agent = await registerAgent(app, "content-owner");
  const note = await agent
    .post("/api/notes")
    .set(csrfHeaders())
    .send(notePayload())
    .expect(201);
  return { app, agent, noteId: String(note.body.id) };
}

function testChunk(value: string): TestChunk {
  const bytes = Buffer.from(value);
  return {
    bytes,
    cipherHash: createHash("sha256").update(bytes).digest("hex"),
    nonce: Buffer.alloc(24, value.length % 251)
  };
}

function beginPayload(
  noteId: string,
  chunks: TestChunk[],
  kind: ContentKind = "update",
  checkpointSequenceCutoff?: number
) {
  return {
    uploadId: crypto.randomUUID(),
    updateId: crypto.randomUUID(),
    noteId,
    sectionId: "root" as const,
    expectedKeyEpoch: 1,
    kind,
    formatVersion: 2 as const,
    totalCipherBytes: chunks.reduce((total, chunk) => total + chunk.bytes.length, 0),
    chunkCount: chunks.length,
    manifestHash: contentManifestHash(
      chunks.map((chunk, chunkIndex) => ({
        chunkIndex,
        cipherLength: chunk.bytes.length,
        cipherHash: chunk.cipherHash,
        nonce: chunk.nonce
      }))
    ),
    ...(checkpointSequenceCutoff === undefined ? {} : { checkpointSequenceCutoff })
  };
}

function begin(agent: TestAgent, payload: ReturnType<typeof beginPayload>) {
  return agent.post("/api/content/uploads").set(csrfHeaders()).send(payload);
}

function putChunk(agent: TestAgent, uploadId: string, index: number, chunk: TestChunk) {
  return agent
    .put(`/api/content/uploads/${uploadId}/chunks/${String(index)}`)
    .set(csrfHeaders())
    .set("content-type", "application/octet-stream")
    .set("content-length", String(chunk.bytes.length))
    .set("x-fortnote-cipher-hash", chunk.cipherHash)
    .set("x-fortnote-nonce", chunk.nonce.toString("base64"))
    .send(chunk.bytes);
}

function commit(
  agent: TestAgent,
  payload: ReturnType<typeof beginPayload>,
  requestId = crypto.randomUUID()
) {
  return agent
    .post(`/api/content/uploads/${payload.uploadId}/commit`)
    .set(csrfHeaders())
    .send({
      requestId,
      updateId: payload.updateId,
      expectedKeyEpoch: payload.expectedKeyEpoch
    });
}

async function uploadAndCommit(
  agent: TestAgent,
  noteId: string,
  chunks: TestChunk[],
  kind: ContentKind = "update",
  checkpointSequenceCutoff?: number
) {
  const payload = beginPayload(noteId, chunks, kind, checkpointSequenceCutoff);
  await begin(agent, payload).expect(201);
  for (const [index, chunk] of chunks.entries()) {
    await putChunk(agent, payload.uploadId, index, chunk).expect(204);
  }
  const response = await commit(agent, payload).expect(201);
  return response.body as {
    updateId: string;
    firstSequence: number;
  };
}

async function manifestCount(app: TestApp): Promise<number> {
  const db = app.locals.db as AppDb;
  return (await testSql(db).get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM content_manifests"
  ))!.count;
}

async function putChunkDuringMutation(
  app: TestApp,
  username: string,
  uploadId: string,
  chunk: TestChunk,
  mutate: (db: AppDb) => Promise<void>
): Promise<{ body: unknown; status: number }> {
  const db = app.locals.db as AppDb;
  const user = (await testSql(db).get<{ id: string }>(
    "SELECT id FROM users WHERE username = ?",
    username
  ))!;
  const token = await createSession(db, user.id);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port");
  }

  const responsePromise = new Promise<{ body: unknown; status: number }>(
    (resolve, reject) => {
      const upload = sendHttpRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          path: `/api/content/uploads/${uploadId}/chunks/0`,
          method: "PUT",
          headers: {
            ...csrfHeaders(),
            cookie: `fortnote_session=${encodeURIComponent(token)}`,
            "content-type": "application/octet-stream",
            "content-length": String(chunk.bytes.length),
            "x-fortnote-cipher-hash": chunk.cipherHash,
            "x-fortnote-nonce": chunk.nonce.toString("base64")
          }
        },
        (response) => {
          const values: Buffer[] = [];
          response.on("data", (value: Buffer) => values.push(value));
          response.on("end", () => {
            const text = Buffer.concat(values).toString("utf8");
            resolve({
              body: text ? (JSON.parse(text) as unknown) : null,
              status: response.statusCode ?? 0
            });
          });
        }
      );
      upload.on("error", reject);
      const midpoint = Math.floor(chunk.bytes.length / 2);
      upload.write(chunk.bytes.subarray(0, midpoint));
      void waitForPartialChunk(app, uploadId)
        .then(async () => {
          await mutate(db);
          upload.end(chunk.bytes.subarray(midpoint));
        })
        .catch(reject);
    }
  );

  try {
    return await responsePromise;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

// Local storage writes a .part file; object storage inserts its object row first.
async function waitForPartialChunk(app: TestApp, uploadId: string): Promise<void> {
  const directory = path.join(String(app.locals.config.dataDir), "content", uploadId);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const started = usesLocalUploads(app)
      ? (await fs.promises.readdir(directory).catch(() => [])).some((entry) =>
          entry.endsWith(".part")
        )
      : Boolean(
          (
            await testSql(app.locals.db).get<{ count: number }>(
              "SELECT COUNT(*) AS count FROM attachment_objects"
            )
          )?.count
        );
    if (started) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Partial content chunk was not observed");
}
