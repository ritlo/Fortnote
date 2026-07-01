import { describe, expect, it } from "vitest";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../test/http.js";

describe("notes and folders routes", () => {
	  it("creates folder and note, then updates with optimistic version", async () => {
	    const app = createTestApp();
	    const agent = await registerAgent(app, "notes_user");

    const folder = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Work" })
      .expect(201);

    const note = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload(folder.body.id as string))
      .expect(201);

	    const updated = await agent
      .put(`/api/notes/${String(note.body.id)}`)
      .set(csrfHeaders())
      .send({
        title: "Updated",
        contentCipher: "updated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "updated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 256,
        version: 1
      })
      .expect(200);

	    expect(updated.body).toMatchObject({ version: 2 });
	    const membership = app.locals.db.sqlite
	      .prepare(
	        `SELECT role, status
	         FROM note_memberships
	         WHERE note_id = ?`
	      )
	      .get(note.body.id) as { role: string; status: string } | undefined;
	    expect(membership).toEqual({ role: "owner", status: "active" });
	  });

  it("rejects stale note versions", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "stale_user");
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);

    await agent
      .put(`/api/notes/${String(created.body.id)}`)
      .set(csrfHeaders())
      .send({
        contentCipher: "updated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "updated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 256,
        version: 2
      })
      .expect(409);
  });

  it("prevents cross-user note reads and folder assignment", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "alice_notes");
    const bob = await registerAgent(app, "bob_notes");

    const folder = await alice
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Alice" })
      .expect(201);

    const created = await alice
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload(folder.body.id as string))
      .expect(201);

    await bob.get(`/api/notes/${String(created.body.id)}`).expect(404);

    await bob
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload(folder.body.id as string))
      .expect(400);
  });

  it("requires an active owner membership to read notes", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "membership_user");
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);

    await agent.get(`/api/notes/${String(created.body.id)}`).expect(200);
    app.locals.db.sqlite
      .prepare(
        `UPDATE note_memberships
         SET status = 'revoked'
         WHERE note_id = ?`
      )
      .run(created.body.id);

    await agent.get(`/api/notes/${String(created.body.id)}`).expect(404);
    const listed = await agent.get("/api/notes").expect(200);
    expect(listed.body.notes).toHaveLength(0);
  });

  it("enforces one-level folder nesting", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "folder_user");

    const parent = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Parent" })
      .expect(201);

    const child = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Child", parentFolderId: parent.body.id })
      .expect(201);

    await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Too deep", parentFolderId: child.body.id })
      .expect(400);
  });

  it("soft deletes, restores, and permanently deletes notes", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "trash_user");
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);

    await agent
      .delete(`/api/notes/${String(created.body.id)}`)
      .set(csrfHeaders())
      .expect(204);

    const deleted = await agent.get("/api/notes").query({ deleted: "true" }).expect(200);
    expect(deleted.body.notes).toHaveLength(1);

    await agent
      .post(`/api/notes/${String(created.body.id)}/restore`)
      .set(csrfHeaders())
      .expect(200);

    await agent
      .delete(`/api/notes/${String(created.body.id)}/permanent`)
      .set(csrfHeaders())
      .expect(204);

    await agent.get(`/api/notes/${String(created.body.id)}`).expect(404);
  });
});
