import { describe, expect, it } from "vitest";
import {
  createTestApp,
  csrfHeaders,
  folderPayload,
  noteMetadataUpdate,
  notePayload,
  registerAgent
} from "../support/http.js";
import {
  failNoteEventWrites,
  protectedNotePayload,
  sharingKeyPayload
} from "./routes.fixtures.js";
import { testSql } from "../support/database.js";

describe("note CRUD and collaboration routes", () => {
  it("rejects stale note versions", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "stale_user");
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);

    await agent
      .put(`/api/notes/${String(created.body.id)}`)
      .set(csrfHeaders())
      .send(noteMetadataUpdate(2))
      .expect(409);
  });

  it("rolls back note updates when event writes fail", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "rollback_update_user");
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);

    await failNoteEventWrites(app);

    await agent
      .put(`/api/notes/${noteId}`)
      .set(csrfHeaders())
      .send(noteMetadataUpdate(1, "rollback"))
      .expect(500);

    const note = (await testSql(app.locals.db).get(
      `SELECT title_cipher AS titleCipher,
                root_version AS rootVersion,
                version
         FROM notes
         WHERE id = ?`,
      noteId
    ))!;
    expect(note).toEqual({
      titleCipher: notePayload().titleCipher,
      rootVersion: 1,
      version: 1
    });
  });

  it("rolls back note creates when event writes fail", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "rollback_create_user");
    const payload = notePayload();

    await failNoteEventWrites(app);

    await agent.post("/api/notes").set(csrfHeaders()).send(payload).expect(500);

    const note = await testSql(app.locals.db).get(
      "SELECT id FROM notes WHERE id = ?",
      payload.id
    );
    expect(note).toBeUndefined();
    const membership = await testSql(app.locals.db).get(
      "SELECT note_id AS noteId FROM note_memberships WHERE note_id = ?",
      payload.id
    );
    expect(membership).toBeUndefined();
  });

  it("prevents cross-user note reads and folder assignment", async () => {
    const app = await createTestApp();
    const alice = await registerAgent(app, "alice_notes");
    const bob = await registerAgent(app, "bob_notes");

    const folder = await alice
      .post("/api/folders")
      .set(csrfHeaders())
      .send(folderPayload())
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

  it("rejects invalid and deleted folder targets for note metadata", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "folder_target_validation_user");
    const invalidFolderId = crypto.randomUUID();

    await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send({ ...protectedNotePayload(), folderId: invalidFolderId })
      .expect(400);

    const folder = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send(folderPayload())
      .expect(201);
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(protectedNotePayload())
      .expect(201);

    await agent
      .delete(`/api/folders/${String(folder.body.id)}`)
      .set(csrfHeaders())
      .expect(204);
    await agent
      .put(`/api/notes/${String(created.body.id)}`)
      .set(csrfHeaders())
      .send({ folderId: folder.body.id, rootVersion: 1, keyEpoch: 1 })
      .expect(400);
  });

  it("requires an active owner membership to read notes", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "membership_user");
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);

    await agent.get(`/api/notes/${String(created.body.id)}`).expect(200);
    await testSql(app.locals.db).run(
      `UPDATE note_memberships
         SET status = 'revoked'
         WHERE note_id = ?`,
      created.body.id
    );

    await agent.get(`/api/notes/${String(created.body.id)}`).expect(404);
    const listed = await agent.get("/api/notes").expect(200);
    expect(listed.body.notes).toHaveLength(0);
  });

  it("invites, updates, and revokes note collaborators with key shares", async () => {
    const app = await createTestApp();
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
        formatVersion: 2
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
        formatVersion: 2
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
      formatVersion: 2
    });

    const bobList = await bob.get("/api/notes").expect(200);
    expect(bobList.body.notes).toHaveLength(1);
    expect(bobList.body.notes[0]).toMatchObject({
      id: noteId,
      role: "editor",
      encryptedNoteKey: null,
      noteKeyNonce: null,
      cryptoOwnerId: expect.any(String),
      ownerUserId: expect.any(String)
    });

    const bobRead = await bob.get(`/api/notes/${noteId}`).expect(200);
    expect(bobRead.body).toMatchObject({
      id: noteId,
      role: "editor",
      encryptedNoteKey: null,
      noteKeyNonce: null
    });

    await bob
      .put(`/api/notes/${noteId}`)
      .set(csrfHeaders())
      .send(noteMetadataUpdate(1, "shared"))
      .expect(200);

    const aliceRead = await alice.get(`/api/notes/${noteId}`).expect(200);
    expect(aliceRead.body).toMatchObject({
      titleCipher: noteMetadataUpdate(1, "shared").titleCipher,
      rootVersion: 2,
      version: 2,
      encryptedNoteKey: expect.any(String),
      noteKeyNonce: expect.any(String),
      role: "owner"
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

    await bob
      .put(`/api/notes/${noteId}`)
      .set(csrfHeaders())
      .send(noteMetadataUpdate(2, "viewer"))
      .expect(404);

    await alice
      .delete(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .expect(204);

    await bob.get(`/api/notes/${noteId}/key-share`).expect(404);
    await bob.get(`/api/notes/${noteId}/memberships`).expect(404);

    const events = await testSql(app.locals.db).all<{
      eventType: string;
      resourceType: string;
      payloadMetadata: string;
    }>(
      `SELECT event_type AS eventType,
                resource_type AS resourceType,
                payload_metadata AS payloadMetadata
         FROM note_events
         WHERE note_id = ?
         ORDER BY cursor`,
      noteId
    );

    expect(events.map((event) => event.eventType)).toEqual([
      "note.created",
      "membership.added",
      "note.updated",
      "membership.role_updated",
      "membership.revoked"
    ]);
    expect(events.slice(1).every((event) => event.resourceType === "membership")).toBe(
      false
    );
    expect(events.filter((event) => event.resourceType === "membership")).toHaveLength(3);
    expect(events.slice(3).every((event) => event.resourceType === "membership")).toBe(
      true
    );
    expect(JSON.parse(events.at(-1)?.payloadMetadata ?? "{}")).toMatchObject({
      membershipUserId: bobUserId
    });
  });

  it("rolls back membership invites when event writes fail", async () => {
    const app = await createTestApp();
    const alice = await registerAgent(app, "rollback_member_alice");
    const bob = await registerAgent(app, "rollback_member_bob");
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

    await failNoteEventWrites(app);

    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "rollback_member_bob",
        role: "editor",
        sharingKeyVersion: 1,
        encryptedNoteKey: "rollback_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 2
      })
      .expect(500);

    const membership = await testSql(app.locals.db).get(
      `SELECT role
         FROM note_memberships
         WHERE note_id = ? AND user_id = ?`,
      noteId,
      bobUserId
    );
    expect(membership).toBeUndefined();

    const keyShare = await testSql(app.locals.db).get(
      `SELECT encrypted_note_key AS encryptedNoteKey
         FROM note_key_shares
         WHERE note_id = ? AND recipient_user_id = ?`,
      noteId,
      bobUserId
    );
    expect(keyShare).toBeUndefined();
  });

  it("rolls back membership role updates when event writes fail", async () => {
    const app = await createTestApp();
    const alice = await registerAgent(app, "rollback_role_alice");
    const bob = await registerAgent(app, "rollback_role_bob");
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
        username: "rollback_role_bob",
        role: "editor",
        sharingKeyVersion: 1,
        encryptedNoteKey: "rollback_role_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 2
      })
      .expect(201);

    await failNoteEventWrites(app);

    await alice
      .patch(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .send({ role: "viewer" })
      .expect(500);

    const membership = await testSql(app.locals.db).get(
      `SELECT role, status
         FROM note_memberships
         WHERE note_id = ? AND user_id = ?`,
      noteId,
      bobUserId
    );
    expect(membership).toEqual({ role: "editor", status: "active" });
  });

  it("rolls back membership revokes when event writes fail", async () => {
    const app = await createTestApp();
    const alice = await registerAgent(app, "rollback_revoke_alice");
    const bob = await registerAgent(app, "rollback_revoke_bob");
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
        username: "rollback_revoke_bob",
        role: "editor",
        sharingKeyVersion: 1,
        encryptedNoteKey: "rollback_revoke_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 2
      })
      .expect(201);

    await failNoteEventWrites(app);

    await alice
      .delete(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .expect(500);

    const membership = await testSql(app.locals.db).get(
      `SELECT role, status
         FROM note_memberships
         WHERE note_id = ? AND user_id = ?`,
      noteId,
      bobUserId
    );
    expect(membership).toEqual({ role: "editor", status: "active" });
    const keyShare = await testSql(app.locals.db).get(
      `SELECT encrypted_note_key AS encryptedNoteKey
         FROM note_key_shares
         WHERE note_id = ? AND recipient_user_id = ?`,
      noteId,
      bobUserId
    );
    expect(keyShare).toEqual({
      encryptedNoteKey: "rollback_revoke_share_for_bob_abcdefghijklmnopqrstuvwxyz"
    });
  });

  it("enforces one-level folder nesting", async () => {
    const app = await createTestApp();
    const agent = await registerAgent(app, "folder_user");

    const parent = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send(folderPayload())
      .expect(201);

    const child = await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send(folderPayload(String(parent.body.id)))
      .expect(201);

    await agent
      .post("/api/folders")
      .set(csrfHeaders())
      .send(folderPayload(String(child.body.id)))
      .expect(400);
  });

  it("soft deletes, restores, and permanently deletes notes", async () => {
    const app = await createTestApp();
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

    const events = await testSql(app.locals.db).all<{
      eventType: string;
      noteVersion: number;
      payloadMetadata: string;
    }>(
      `SELECT event_type AS eventType,
                note_version AS noteVersion,
                payload_metadata AS payloadMetadata
         FROM note_events
         WHERE note_id = ?
         ORDER BY cursor`,
      created.body.id
    );
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
