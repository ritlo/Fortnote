import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer, request as sendHttpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@fortnote/shared";
import { createSession } from "@server/auth/session.js";
import type { ApplicationDatabase } from "@server/db/types.js";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../support/http.js";
import { failNoteEventWrites, testSql } from "../support/database.js";

function attachmentPayload(size = 8) {
  const bytes = Buffer.alloc(size, 7);
  return {
    id: crypto.randomUUID(),
    filename: "receipt.pdf",
    mimeType: "application/pdf",
    expectedKeyEpoch: 1,
    metadataCipher: "encrypted_attachment_metadata_abcdefghijklmnopqrstuvwxyz",
    metadataNonce: "attachment_metadata_nonce_abcdefghijklmnopqrstuvwxyz",
    metadataFormatVersion: 2,
    size,
    encryptedAttachmentKey: "encrypted_attachment_key_abcdefghijklmnopqrstuvwxyz",
    attachmentKeyNonce: "attachment_key_nonce_abcdefghijklmnopqrstuvwxyz",
    fileNonce: "attachment_file_nonce_abcdefghijklmnopqrstuvwxyz",
    encryptedBytes: bytes
  };
}

async function createNote(agent: Awaited<ReturnType<typeof registerAgent>>) {
  const note = await agent
    .post("/api/notes")
    .set(csrfHeaders())
    .send(notePayload())
    .expect(201);
  return String(note.body.id);
}

function attachmentHeaders(payload: ReturnType<typeof attachmentPayload>) {
  return {
    "content-type": "application/octet-stream",
    "x-fortnote-attachment-id": payload.id,
    "x-fortnote-size": String(payload.size),
    "x-fortnote-expected-key-epoch": String(payload.expectedKeyEpoch),
    "x-fortnote-metadata-cipher": payload.metadataCipher,
    "x-fortnote-metadata-nonce": payload.metadataNonce,
    "x-fortnote-metadata-format-version": String(payload.metadataFormatVersion),
    "x-fortnote-encrypted-attachment-key": payload.encryptedAttachmentKey,
    "x-fortnote-attachment-key-nonce": payload.attachmentKeyNonce,
    "x-fortnote-file-nonce": payload.fileNonce
  };
}

function uploadAttachment(
  agent: Awaited<ReturnType<typeof registerAgent>>,
  noteId: string,
  payload: ReturnType<typeof attachmentPayload>
) {
  return agent
    .post(`/api/notes/${noteId}/attachments`)
    .set(csrfHeaders())
    .set(attachmentHeaders(payload))
    .send(payload.encryptedBytes);
}

async function uploadDuringMutation(
  app: Awaited<ReturnType<typeof createTestApp>>,
  username: string,
  noteId: string,
  payload: ReturnType<typeof attachmentPayload>,
  mutate: (db: ApplicationDatabase, userId: string) => Promise<void>
): Promise<{ body: unknown; status: number }> {
  const db = app.locals.db as ApplicationDatabase;
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

  const headers = {
    ...csrfHeaders(),
    ...attachmentHeaders(payload),
    cookie: `fortnote_session=${encodeURIComponent(token)}`,
    "content-length": String(payload.size)
  };
  const responsePromise = new Promise<{ body: unknown; status: number }>(
    (resolve, reject) => {
      const upload = sendHttpRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          path: `/api/notes/${noteId}/attachments`,
          method: "POST",
          headers
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              body: text ? (JSON.parse(text) as unknown) : null,
              status: response.statusCode ?? 0
            });
          });
        }
      );
      upload.on("error", reject);
      upload.write(payload.encryptedBytes.subarray(0, payload.size / 2));
      void waitForReservation(db, payload.size)
        .then(async () => {
          await mutate(db, user.id);
          upload.end(payload.encryptedBytes.subarray(payload.size / 2));
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

async function waitForReservation(db: ApplicationDatabase, size: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const account = await testSql(db).get(
      "SELECT reserved_bytes AS reservedBytes FROM storage_accounts"
    );
    if (account?.reservedBytes === size) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Attachment reservation was not observed");
}

describe("attachments routes", () => {
  it("uploads, lists, downloads, and deletes encrypted attachments", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "attachment_user");
    const noteId = await createNote(agent);
    const payload = attachmentPayload();

    await uploadAttachment(agent, noteId, payload).expect(201);

    const stored = await testSql(app.locals.db as ApplicationDatabase).get(
      "SELECT filename, mime_type AS mimeType, metadata_cipher AS metadataCipher FROM attachments WHERE id = ?",
      payload.id
    );
    expect(stored).toEqual({
      filename: "",
      mimeType: "",
      metadataCipher: payload.metadataCipher
    });

    const list = await agent.get(`/api/notes/${noteId}/attachments`).expect(200);
    expect(list.body.attachments).toHaveLength(1);
    expect(list.body.attachments[0]).toMatchObject({
      id: payload.id,
      metadataCipher: payload.metadataCipher,
      metadataNonce: payload.metadataNonce,
      metadataFormatVersion: 2,
      keyEpoch: 1,
      size: 8
    });
    expect(list.body.attachments[0]).not.toHaveProperty("filename");
    expect(list.body.attachments[0]).not.toHaveProperty("mimeType");

    const download = await agent.get(`/api/attachments/${payload.id}`).expect(200);
    expect(download.body).toEqual(payload.encryptedBytes);
    expect(download.headers["content-type"]).toMatch(/^application\/octet-stream/u);
    expect(download.headers["x-fortnote-attachment-id"]).toBe(payload.id);

    await agent.delete(`/api/attachments/${payload.id}`).set(csrfHeaders()).expect(204);
    await agent.get(`/api/attachments/${payload.id}`).expect(404);
    expect(
      await testSql(app.locals.db as ApplicationDatabase).get(
        "SELECT used_bytes AS usedBytes, reserved_bytes AS reservedBytes FROM storage_accounts"
      )
    ).toEqual({ usedBytes: 0, reservedBytes: 0 });
  });

  it("rejects malformed legacy filenames and ciphertext size mismatches", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "bad_attachment_user");
    const noteId = await createNote(agent);

    const unsafe = attachmentPayload();
    await agent
      .post(`/api/notes/${noteId}/attachments`)
      .set(csrfHeaders())
      .set({
        "content-type": "application/octet-stream",
        "x-fortnote-attachment-id": unsafe.id,
        "x-fortnote-filename": "../secret.txt",
        "x-fortnote-mime-type": unsafe.mimeType,
        "x-fortnote-size": String(unsafe.size),
        "x-fortnote-encrypted-attachment-key": unsafe.encryptedAttachmentKey,
        "x-fortnote-attachment-key-nonce": unsafe.attachmentKeyNonce,
        "x-fortnote-file-nonce": unsafe.fileNonce
      })
      .send(unsafe.encryptedBytes)
      .expect(400);

    await uploadAttachment(agent, noteId, { ...attachmentPayload(), size: 99 }).expect(
      400
    );
  });

  it("rejects oversized attachments before writing bytes", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "oversized_attachment_user");
    const noteId = await createNote(agent);
    const payload = {
      ...attachmentPayload(),
      size: LIMITS.maxAttachmentBytes + 1
    };

    await uploadAttachment(agent, noteId, payload).expect(413);
    await agent.get(`/api/attachments/${payload.id}`).expect(404);
  });

  it("enforces per-user storage quota", async () => {
    const app = await createTestApp({ storageQuotaBytes: 8 });
    const agent = await registerAgent(app, "quota_attachment_user");
    const noteId = await createNote(agent);
    const db = app.locals.db as ApplicationDatabase;
    await uploadAttachment(agent, noteId, attachmentPayload()).expect(201);
    const payload = attachmentPayload(1);

    await uploadAttachment(agent, noteId, payload).expect(413);
    await agent.get(`/api/attachments/${payload.id}`).expect(404);
    expect(
      await testSql(db).get(
        "SELECT used_bytes AS usedBytes, reserved_bytes AS reservedBytes FROM storage_accounts"
      )
    ).toEqual({ usedBytes: 8, reservedBytes: 0 });
  });

  it("rejects attachments on deleted notes", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "deleted_attachment_user");
    const noteId = await createNote(agent);

    await agent.delete(`/api/notes/${noteId}`).set(csrfHeaders()).expect(204);

    await uploadAttachment(agent, noteId, attachmentPayload()).expect(409);
  });

  it("prevents cross-user attachment access", async () => {
    const app = await createTestApp();
    const alice = await registerAgent(app, "alice_attachments");
    const bob = await registerAgent(app, "bob_attachments");
    const noteId = await createNote(alice);
    const payload = attachmentPayload();

    await uploadAttachment(alice, noteId, payload).expect(201);

    await bob.get(`/api/attachments/${payload.id}`).expect(404);
  });

  it("rejects a stale epoch after asynchronously receiving ciphertext", async () => {
    const app = await createTestApp();
    const owner = await registerAgent(app, "attachment_epoch_owner");
    const noteId = await createNote(owner);
    const payload = attachmentPayload();

    const outcome = await uploadDuringMutation(
      app,
      "attachment_epoch_owner",
      noteId,
      payload,
      async (db) => {
        await testSql(db).run("UPDATE notes SET key_epoch = 2 WHERE id = ?", noteId);
      }
    );

    expect(outcome).toMatchObject({
      status: 409,
      body: { error: { code: "stale_epoch" } }
    });
    expect(
      await testSql(app.locals.db as ApplicationDatabase).get(
        "SELECT used_bytes AS usedBytes, reserved_bytes AS reservedBytes FROM storage_accounts"
      )
    ).toEqual({ usedBytes: 0, reservedBytes: 0 });
  });

  it("rechecks editor authorization after asynchronously receiving ciphertext", async () => {
    const app = await createTestApp();
    const owner = await registerAgent(app, "attachment_auth_owner");
    await registerAgent(app, "attachment_auth_editor");
    const noteId = await createNote(owner);
    const db = app.locals.db as ApplicationDatabase;
    const editor = (await testSql(db).get(
      "SELECT id FROM users WHERE username = ?",
      "attachment_auth_editor"
    ))!;
    await testSql(db).run(
      "INSERT INTO note_memberships (note_id, user_id, role, status) VALUES (?, ?, 'editor', 'active')",
      noteId,
      editor.id
    );

    const outcome = await uploadDuringMutation(
      app,
      "attachment_auth_editor",
      noteId,
      attachmentPayload(),
      async (liveDb, userId) => {
        await testSql(liveDb).run(
          "UPDATE note_memberships SET status = 'revoked' WHERE note_id = ? AND user_id = ?",
          noteId,
          userId
        );
      }
    );

    expect(outcome).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } }
    });
    expect(
      await testSql(db).get(
        "SELECT used_bytes AS usedBytes, reserved_bytes AS reservedBytes FROM storage_accounts"
      )
    ).toEqual({ usedBytes: 0, reservedBytes: 0 });
  });

  it("allows editors and viewers through note memberships", async () => {
    const app = await createTestApp();
    const alice = await registerAgent(app, "alice_shared_attachments");
    const bob = await registerAgent(app, "bob_shared_attachments");
    const carol = await registerAgent(app, "carol_shared_attachments");
    const db = app.locals.db as ApplicationDatabase;
    const noteId = await createNote(alice);
    const payload = attachmentPayload();
    const owner = (await testSql(db).get(
      "SELECT user_id AS userId FROM notes WHERE id = ?",
      noteId
    ))!;
    const bobUser = (await testSql(db).get(
      "SELECT id FROM users WHERE username = ?",
      "bob_shared_attachments"
    ))!;
    const carolUser = (await testSql(db).get(
      "SELECT id FROM users WHERE username = ?",
      "carol_shared_attachments"
    ))!;
    await testSql(db).run(
      `INSERT INTO note_memberships (note_id, user_id, role, status)
         VALUES (?, ?, ?, 'active')`,
      noteId,
      bobUser.id,
      "editor"
    );
    await testSql(db).run(
      `INSERT INTO note_memberships (note_id, user_id, role, status)
         VALUES (?, ?, ?, 'active')`,
      noteId,
      carolUser.id,
      "viewer"
    );

    await uploadAttachment(bob, noteId, payload).expect(201);

    const stored = (await testSql(db).get(
      "SELECT user_id AS userId FROM attachments WHERE id = ?",
      payload.id
    ))!;
    expect(stored.userId).toBe(owner.userId);

    const carolList = await carol.get(`/api/notes/${noteId}/attachments`).expect(200);
    expect(carolList.body.attachments).toHaveLength(1);
    await carol.get(`/api/attachments/${payload.id}`).expect(200);
    await uploadAttachment(carol, noteId, attachmentPayload()).expect(404);
    await carol.delete(`/api/attachments/${payload.id}`).set(csrfHeaders()).expect(404);

    await bob.delete(`/api/attachments/${payload.id}`).set(csrfHeaders()).expect(204);
    const events = await testSql(db).all(
      `SELECT event_type AS eventType, resource_type AS resourceType
         FROM note_events
         WHERE note_id = ?
         ORDER BY cursor`,
      noteId
    );
    expect(events).toEqual(
      expect.arrayContaining([
        { eventType: "attachment.created", resourceType: "attachment" },
        { eventType: "attachment.deleted", resourceType: "attachment" }
      ])
    );
  });

  it("rolls back attachment uploads and removes stored bytes when event writes fail", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "rollback_attachment_upload_user");
    const db = app.locals.db as ApplicationDatabase;
    const noteId = await createNote(agent);
    const payload = attachmentPayload();

    await failNoteEventWrites(app.locals.db);

    await uploadAttachment(agent, noteId, payload).expect(500);

    const attachment = await testSql(db).get(
      "SELECT id FROM attachments WHERE id = ?",
      payload.id
    );
    expect(attachment).toBeUndefined();
    expect(
      await testSql(db).get(
        "SELECT used_bytes AS usedBytes, reserved_bytes AS reservedBytes FROM storage_accounts"
      )
    ).toEqual({ usedBytes: 0, reservedBytes: 0 });
  });

  it("rolls back attachment deletes and keeps stored bytes when event writes fail", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "rollback_attachment_delete_user");
    const db = app.locals.db as ApplicationDatabase;
    const noteId = await createNote(agent);
    const payload = attachmentPayload();

    await uploadAttachment(agent, noteId, payload).expect(201);
    await failNoteEventWrites(app.locals.db);

    await agent.delete(`/api/attachments/${payload.id}`).set(csrfHeaders()).expect(500);

    const attachment = await testSql(db).get(
      "SELECT id FROM attachments WHERE id = ?",
      payload.id
    );
    expect(attachment).toEqual({ id: payload.id });
    const download = await agent.get(`/api/attachments/${payload.id}`).expect(200);
    expect(download.body).toEqual(payload.encryptedBytes);
  });

  it("removes attachment files on permanent note delete", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "delete_attachment_user");
    const noteId = await createNote(agent);
    const payload = attachmentPayload();

    await uploadAttachment(agent, noteId, payload).expect(201);

    await agent.delete(`/api/notes/${noteId}/permanent`).set(csrfHeaders()).expect(204);

    await agent.get(`/api/attachments/${payload.id}`).expect(404);
    expect(
      await testSql(app.locals.db as ApplicationDatabase).get(
        "SELECT used_bytes AS usedBytes, reserved_bytes AS reservedBytes FROM storage_accounts"
      )
    ).toEqual({ usedBytes: 0, reservedBytes: 0 });
  });
});
