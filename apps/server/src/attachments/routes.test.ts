import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
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
    encryptedBytes: bytes.toString("base64")
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

describe("attachments routes", () => {
  it("uploads, lists, downloads, and deletes encrypted attachments", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "attachment_user");
    const noteId = await createNote(agent);
    const payload = attachmentPayload();

    await agent
      .post(`/api/notes/${noteId}/attachments`)
      .set(csrfHeaders())
      .send(payload)
      .expect(201);

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
      encryptedBytes: payload.encryptedBytes
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

    await agent
      .post(`/api/notes/${noteId}/attachments`)
      .set(csrfHeaders())
      .send({ ...attachmentPayload(), filename: "../secret.txt" })
      .expect(400);

    await agent
      .post(`/api/notes/${noteId}/attachments`)
      .set(csrfHeaders())
      .send({ ...attachmentPayload(), size: 99 })
      .expect(400);
  });

  it("rejects attachments on deleted notes", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "deleted_attachment_user");
    const noteId = await createNote(agent);

    await agent.delete(`/api/notes/${noteId}`).set(csrfHeaders()).expect(204);

    await agent
      .post(`/api/notes/${noteId}/attachments`)
      .set(csrfHeaders())
      .send(attachmentPayload())
      .expect(409);
  });

  it("prevents cross-user attachment access", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "alice_attachments");
    const bob = await registerAgent(app, "bob_attachments");
    const noteId = await createNote(alice);
    const payload = attachmentPayload();

    await alice
      .post(`/api/notes/${noteId}/attachments`)
      .set(csrfHeaders())
      .send(payload)
      .expect(201);

    await bob.get(`/api/attachments/${payload.id}`).expect(404);
  });

  it("removes attachment files on permanent note delete", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "delete_attachment_user");
    const noteId = await createNote(agent);
    const payload = attachmentPayload();

    await agent
      .post(`/api/notes/${noteId}/attachments`)
      .set(csrfHeaders())
      .send(payload)
      .expect(201);

    await agent
      .delete(`/api/notes/${noteId}/permanent`)
      .set(csrfHeaders())
      .expect(204);

    await agent.get(`/api/attachments/${payload.id}`).expect(404);
  });
});
