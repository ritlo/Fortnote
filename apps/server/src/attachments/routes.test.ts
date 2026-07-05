import { Buffer } from "node:buffer";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@fortnote/shared";
import type { AppDb } from "../db/client.js";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../test/http.js";

function attachmentPayload(size = 8) {
  const bytes = Buffer.alloc(size, 7);
  return {
    id: crypto.randomUUID(),
    filename: "receipt.pdf",
    mimeType: "application/pdf",
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
    "x-fortnote-filename": encodeURIComponent(payload.filename),
    "x-fortnote-mime-type": encodeURIComponent(payload.mimeType),
    "x-fortnote-size": String(payload.size),
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

describe("attachments routes", () => {
  it("uploads, lists, downloads, and deletes encrypted attachments", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "attachment_user");
    const noteId = await createNote(agent);
    const payload = attachmentPayload();

    await uploadAttachment(agent, noteId, payload).expect(201);

    const list = await agent
      .get(`/api/notes/${noteId}/attachments`)
      .expect(200);
    expect(list.body.attachments).toHaveLength(1);
    expect(list.body.attachments[0]).toMatchObject({
      id: payload.id,
      filename: "receipt.pdf",
      size: 8
    });

    const download = await agent.get(`/api/attachments/${payload.id}`).expect(200);
    expect(download.body).toMatchObject({
      id: payload.id,
      encryptedBytes: payload.encryptedBytes.toString("base64")
    });

    await agent
      .delete(`/api/attachments/${payload.id}`)
      .set(csrfHeaders())
      .expect(204);
    await agent.get(`/api/attachments/${payload.id}`).expect(404);
  });

  it("rejects unsafe filenames and size mismatches", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "bad_attachment_user");
    const noteId = await createNote(agent);

    await uploadAttachment(agent, noteId, {
      ...attachmentPayload(),
      filename: "../secret.txt"
    }).expect(400);

    await uploadAttachment(agent, noteId, { ...attachmentPayload(), size: 99 }).expect(
      400
    );
  });

  it("rejects oversized attachments before writing bytes", async () => {
    const app = createTestApp();
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
    const app = createTestApp();
    const agent = await registerAgent(app, "quota_attachment_user");
    const noteId = await createNote(agent);
    const db = app.locals.db as AppDb;
    const user = db.sqlite
      .prepare("SELECT id FROM users WHERE username = ?")
      .get("quota_attachment_user") as { id: string };
    db.sqlite
      .prepare(
        `INSERT INTO attachments (
          id,
          note_id,
          user_id,
          filename,
          mime_type,
          size,
          encrypted_attachment_key,
          attachment_key_nonce,
          file_cipher_path,
          file_nonce
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        noteId,
        user.id,
        "seed.bin",
        "application/octet-stream",
        LIMITS.maxUserStorageBytes,
        "seed_attachment_key_abcdefghijklmnopqrstuvwxyz",
        "seed_attachment_nonce_abcdefghijklmnopqrstuvwxyz",
        "seed-storage-id",
        "seed_file_nonce_abcdefghijklmnopqrstuvwxyz"
      );
    const payload = attachmentPayload();

    await uploadAttachment(agent, noteId, payload).expect(413);
    await agent.get(`/api/attachments/${payload.id}`).expect(404);
  });

  it("rejects attachments on deleted notes", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "deleted_attachment_user");
    const noteId = await createNote(agent);

    await agent.delete(`/api/notes/${noteId}`).set(csrfHeaders()).expect(204);

    await uploadAttachment(agent, noteId, attachmentPayload()).expect(409);
  });

  it("prevents cross-user attachment access", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "alice_attachments");
    const bob = await registerAgent(app, "bob_attachments");
    const noteId = await createNote(alice);
    const payload = attachmentPayload();

    await uploadAttachment(alice, noteId, payload).expect(201);

    await bob.get(`/api/attachments/${payload.id}`).expect(404);
  });

  it("allows editors and viewers through note memberships", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "alice_shared_attachments");
    const bob = await registerAgent(app, "bob_shared_attachments");
    const carol = await registerAgent(app, "carol_shared_attachments");
    const db = app.locals.db as AppDb;
    const noteId = await createNote(alice);
    const payload = attachmentPayload();
    const owner = db.sqlite
      .prepare("SELECT user_id AS userId FROM notes WHERE id = ?")
      .get(noteId) as { userId: string };
    const bobUser = db.sqlite
      .prepare("SELECT id FROM users WHERE username = ?")
      .get("bob_shared_attachments") as { id: string };
    const carolUser = db.sqlite
      .prepare("SELECT id FROM users WHERE username = ?")
      .get("carol_shared_attachments") as { id: string };
    db.sqlite
      .prepare(
        `INSERT INTO note_memberships (note_id, user_id, role, status)
         VALUES (?, ?, ?, 'active')`
      )
      .run(noteId, bobUser.id, "editor");
    db.sqlite
      .prepare(
        `INSERT INTO note_memberships (note_id, user_id, role, status)
         VALUES (?, ?, ?, 'active')`
      )
      .run(noteId, carolUser.id, "viewer");

    await uploadAttachment(bob, noteId, payload).expect(201);

    const stored = db.sqlite
      .prepare("SELECT user_id AS userId FROM attachments WHERE id = ?")
      .get(payload.id) as { userId: string };
    expect(stored.userId).toBe(owner.userId);

    const carolList = await carol.get(`/api/notes/${noteId}/attachments`).expect(200);
    expect(carolList.body.attachments).toHaveLength(1);
    await carol.get(`/api/attachments/${payload.id}`).expect(200);
    await uploadAttachment(carol, noteId, attachmentPayload()).expect(404);
    await carol.delete(`/api/attachments/${payload.id}`).set(csrfHeaders()).expect(404);

    await bob.delete(`/api/attachments/${payload.id}`).set(csrfHeaders()).expect(204);
    const events = db.sqlite
      .prepare(
        `SELECT event_type AS eventType, resource_type AS resourceType
         FROM note_events
         WHERE note_id = ?
         ORDER BY cursor`
      )
      .all(noteId) as { eventType: string; resourceType: string }[];
    expect(events).toEqual(
      expect.arrayContaining([
        { eventType: "attachment.created", resourceType: "attachment" },
        { eventType: "attachment.deleted", resourceType: "attachment" }
      ])
    );
  });

  it("rolls back attachment uploads and removes stored bytes when event writes fail", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "rollback_attachment_upload_user");
    const db = app.locals.db as AppDb;
    const noteId = await createNote(agent);
    const payload = attachmentPayload();

    failNoteEventWrites(app);

    await uploadAttachment(agent, noteId, payload).expect(500);

    const attachment = db.sqlite
      .prepare("SELECT id FROM attachments WHERE id = ?")
      .get(payload.id);
    expect(attachment).toBeUndefined();
    expect(fs.readdirSync(app.locals.config.dataDir)).toHaveLength(0);
  });

  it("rolls back attachment deletes and keeps stored bytes when event writes fail", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "rollback_attachment_delete_user");
    const db = app.locals.db as AppDb;
    const noteId = await createNote(agent);
    const payload = attachmentPayload();

    await uploadAttachment(agent, noteId, payload).expect(201);
    failNoteEventWrites(app);

    await agent.delete(`/api/attachments/${payload.id}`).set(csrfHeaders()).expect(500);

    const attachment = db.sqlite
      .prepare("SELECT id FROM attachments WHERE id = ?")
      .get(payload.id);
    expect(attachment).toEqual({ id: payload.id });
    const download = await agent.get(`/api/attachments/${payload.id}`).expect(200);
    expect(download.body.encryptedBytes).toBe(payload.encryptedBytes.toString("base64"));
  });

  it("removes attachment files on permanent note delete", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "delete_attachment_user");
    const noteId = await createNote(agent);
    const payload = attachmentPayload();

    await uploadAttachment(agent, noteId, payload).expect(201);

    await agent
      .delete(`/api/notes/${noteId}/permanent`)
      .set(csrfHeaders())
      .expect(204);

    await agent.get(`/api/attachments/${payload.id}`).expect(404);
  });
});

function failNoteEventWrites(app: ReturnType<typeof createTestApp>): void {
  app.locals.db.sqlite.exec(`
    CREATE TRIGGER fail_note_events_insert
    BEFORE INSERT ON note_events
    BEGIN
      SELECT RAISE(ABORT, 'note event failure');
    END;
  `);
}
