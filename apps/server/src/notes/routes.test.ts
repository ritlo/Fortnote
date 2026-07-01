import { describe, expect, it } from "vitest";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../test/http.js";

function sharingKeyPayload(version = 1) {
  return {
    sharingKeyVersion: version,
    publicKey: `public_sharing_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    encryptedPrivateKey: `encrypted_private_key_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    privateKeyNonce: `private_key_nonce_${String(version)}_abcdefghijklmnopqrstuvwxyz`,
    formatVersion: 1
  };
}

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

    const events = app.locals.db.sqlite
      .prepare(
        `SELECT event_type AS eventType, note_version AS noteVersion
         FROM note_events
         WHERE note_id = ?
         ORDER BY cursor`
      )
      .all(note.body.id) as { eventType: string; noteVersion: number }[];
    expect(events).toEqual([
      { eventType: "note.created", noteVersion: 1 },
      { eventType: "note.updated", noteVersion: 2 }
    ]);
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

  it("invites, updates, and revokes note collaborators with key shares", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "member_alice");
    const bob = await registerAgent(app, "member_bob");
    await registerAgent(app, "member_carol");

    const bobSession = await bob.get("/api/auth/me").expect(200);
    const bobUserId = String(bobSession.body.id);

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload())
      .expect(201);

    const created = await alice
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);

    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "member_carol",
        role: "viewer",
        sharingKeyVersion: 1,
        encryptedNoteKey: "encrypted_share_for_carol_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(404);

    const invited = await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "member_bob",
        role: "editor",
        sharingKeyVersion: 1,
        encryptedNoteKey: "encrypted_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(201);
    expect(invited.body).toMatchObject({
      userId: bobUserId,
      username: "member_bob",
      role: "editor",
      status: "active"
    });

    const keyShare = await bob.get(`/api/notes/${noteId}/key-share`).expect(200);
    expect(keyShare.body).toMatchObject({
      noteId,
      recipientUserId: bobUserId,
      senderUserId: expect.any(String),
      sharingKeyVersion: 1,
      encryptedNoteKey: "encrypted_share_for_bob_abcdefghijklmnopqrstuvwxyz",
      formatVersion: 1
    });

    const memberships = await bob.get(`/api/notes/${noteId}/memberships`).expect(200);
    expect(memberships.body.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username: "member_alice", role: "owner" }),
        expect.objectContaining({ username: "member_bob", role: "editor" })
      ])
    );

    await alice
      .patch(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .send({ role: "viewer" })
      .expect(200);

    await alice
      .delete(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .expect(204);

    await bob.get(`/api/notes/${noteId}/key-share`).expect(404);
    await bob.get(`/api/notes/${noteId}/memberships`).expect(404);

    const events = app.locals.db.sqlite
      .prepare(
        `SELECT event_type AS eventType,
                resource_type AS resourceType,
                payload_metadata AS payloadMetadata
         FROM note_events
         WHERE note_id = ?
         ORDER BY cursor`
      )
      .all(noteId) as {
      eventType: string;
      resourceType: string;
      payloadMetadata: string | null;
    }[];

    expect(events.map((event) => event.eventType)).toEqual([
      "note.created",
      "membership.added",
      "membership.role_updated",
      "membership.revoked"
    ]);
    expect(events.slice(1).every((event) => event.resourceType === "membership")).toBe(
      true
    );
    expect(JSON.parse(events.at(-1)?.payloadMetadata ?? "{}")).toMatchObject({
      membershipUserId: bobUserId
    });
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

    const events = app.locals.db.sqlite
      .prepare(
        `SELECT event_type AS eventType,
                note_version AS noteVersion,
                payload_metadata AS payloadMetadata
         FROM note_events
         WHERE note_id = ?
         ORDER BY cursor`
      )
      .all(created.body.id) as {
      eventType: string;
      noteVersion: number;
      payloadMetadata: string | null;
    }[];
    expect(events.map((event) => event.eventType)).toEqual([
      "note.created",
      "note.deleted",
      "note.restored",
      "note.permanently_deleted"
    ]);
    expect(events.at(-1)?.noteVersion).toBe(1);
    expect(JSON.parse(events.at(-1)?.payloadMetadata ?? "{}")).toMatchObject({
      visibleUserIds: [expect.any(String)]
    });
  });
});
