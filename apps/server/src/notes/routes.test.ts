import { Buffer } from "node:buffer";
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

  it("rolls back note updates when event writes fail", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "rollback_update_user");
    const created = await agent
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);

    failNoteEventWrites(app);

    await agent
      .put(`/api/notes/${noteId}`)
      .set(csrfHeaders())
      .send({
        title: "Should roll back",
        contentCipher: "rollback_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "rollback_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 512,
        version: 1
      })
      .expect(500);

    const note = app.locals.db.sqlite
      .prepare(
        `SELECT title,
                content_cipher AS contentCipher,
                content_length AS contentLength,
                version
         FROM notes
         WHERE id = ?`
      )
      .get(noteId) as {
      contentCipher: string;
      contentLength: number;
      title: string;
      version: number;
    };
    expect(note).toEqual({
      contentCipher: "content_cipher_abcdefghijklmnopqrstuvwxyz",
      contentLength: 128,
      title: "Encrypted note",
      version: 1
    });
  });

  it("rolls back note creates when event writes fail", async () => {
    const app = createTestApp();
    const agent = await registerAgent(app, "rollback_create_user");
    const payload = notePayload();

    failNoteEventWrites(app);

    await agent.post("/api/notes").set(csrfHeaders()).send(payload).expect(500);

    const note = app.locals.db.sqlite
      .prepare("SELECT id FROM notes WHERE id = ?")
      .get(payload.id);
    expect(note).toBeUndefined();
    const membership = app.locals.db.sqlite
      .prepare("SELECT note_id AS noteId FROM note_memberships WHERE note_id = ?")
      .get(payload.id);
    expect(membership).toBeUndefined();
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
      .send({
        title: "Shared edit",
        contentCipher: "shared_updated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "shared_updated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 512,
        version: 1
      })
      .expect(200);

    const aliceRead = await alice.get(`/api/notes/${noteId}`).expect(200);
    expect(aliceRead.body).toMatchObject({
      title: "Shared edit",
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
      .send({
        contentCipher: "viewer_updated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "viewer_updated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 1024,
        version: 2
      })
      .expect(404);

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
      "note.updated",
      "membership.role_updated",
      "membership.revoked"
    ]);
    expect(events.slice(1).every((event) => event.resourceType === "membership")).toBe(
      false
    );
    expect(events.filter((event) => event.resourceType === "membership")).toHaveLength(
      3
    );
    expect(events.slice(3).every((event) => event.resourceType === "membership")).toBe(
      true
    );
    expect(JSON.parse(events.at(-1)?.payloadMetadata ?? "{}")).toMatchObject({
      membershipUserId: bobUserId
    });
  });

  it("rotates note keys for all active members and attachments", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "rotate_alice");
    const bob = await registerAgent(app, "rotate_bob");
    const bobSession = await bob.get("/api/auth/me").expect(200);
    const bobUserId = String(bobSession.body.id);

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload(2))
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
        username: "rotate_bob",
        role: "editor",
        sharingKeyVersion: 2,
        encryptedNoteKey: "old_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(201);
    await alice
      .post(`/api/notes/${noteId}/attachments`)
      .set(csrfHeaders())
      .set({
        "content-type": "application/octet-stream",
        "x-fortnote-attachment-id": "00000000-0000-4000-8000-000000000001",
        "x-fortnote-filename": "rotate.txt",
        "x-fortnote-mime-type": "text/plain",
        "x-fortnote-size": "8",
        "x-fortnote-encrypted-attachment-key":
          "old_attachment_key_abcdefghijklmnopqrstuvwxyz",
        "x-fortnote-attachment-key-nonce":
          "old_attachment_nonce_abcdefghijklmnopqrstuvwxyz",
        "x-fortnote-file-nonce": "file_nonce_abcdefghijklmnopqrstuvwxyz"
      })
      .send(Buffer.from("ciphered"))
      .expect(201);

    const rotated = await alice
      .post(`/api/notes/${noteId}/key-rotation`)
      .set(csrfHeaders())
      .send({
        encryptedNoteKey: "rotated_owner_note_key_abcdefghijklmnopqrstuvwxyz",
        noteKeyNonce: "rotated_owner_nonce_abcdefghijklmnopqrstuvwxyz",
        contentCipher: "rotated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "rotated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 777,
        version: 1,
        shares: [
          {
            recipientUserId: bobUserId,
            sharingKeyVersion: 2,
            encryptedNoteKey: "rotated_share_for_bob_abcdefghijklmnopqrstuvwxyz",
            formatVersion: 1
          }
        ],
        attachmentKeys: [
          {
            attachmentId: "00000000-0000-4000-8000-000000000001",
            encryptedAttachmentKey: "rotated_attachment_key_abcdefghijklmnopqrstuvwxyz",
            attachmentKeyNonce: "rotated_attachment_nonce_abcdefghijklmnopqrstuvwxyz"
          }
        ]
      })
      .expect(200);
    expect(rotated.body).toMatchObject({ id: noteId, version: 2 });

    const note = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_note_key AS encryptedNoteKey,
                note_key_nonce AS noteKeyNonce,
                content_cipher AS contentCipher,
                content_length AS contentLength,
                version
         FROM notes
         WHERE id = ?`
      )
      .get(noteId) as {
      contentCipher: string;
      contentLength: number;
      encryptedNoteKey: string;
      noteKeyNonce: string;
      version: number;
    };
    expect(note).toEqual({
      contentCipher: "rotated_content_cipher_abcdefghijklmnopqrstuvwxyz",
      contentLength: 777,
      encryptedNoteKey: "rotated_owner_note_key_abcdefghijklmnopqrstuvwxyz",
      noteKeyNonce: "rotated_owner_nonce_abcdefghijklmnopqrstuvwxyz",
      version: 2
    });
    const share = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_note_key AS encryptedNoteKey,
                sharing_key_version AS sharingKeyVersion
         FROM note_key_shares
         WHERE note_id = ? AND recipient_user_id = ?`
      )
      .get(noteId, bobUserId) as {
      encryptedNoteKey: string;
      sharingKeyVersion: number;
    };
    expect(share).toEqual({
      encryptedNoteKey: "rotated_share_for_bob_abcdefghijklmnopqrstuvwxyz",
      sharingKeyVersion: 2
    });
    const attachment = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_attachment_key AS encryptedAttachmentKey,
                attachment_key_nonce AS attachmentKeyNonce
         FROM attachments
         WHERE id = ?`
      )
      .get("00000000-0000-4000-8000-000000000001") as {
      attachmentKeyNonce: string;
      encryptedAttachmentKey: string;
    };
    expect(attachment).toEqual({
      attachmentKeyNonce: "rotated_attachment_nonce_abcdefghijklmnopqrstuvwxyz",
      encryptedAttachmentKey: "rotated_attachment_key_abcdefghijklmnopqrstuvwxyz"
    });
  });

  it("rejects partial key rotations", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "partial_rotate_alice");
    const bob = await registerAgent(app, "partial_rotate_bob");

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
        username: "partial_rotate_bob",
        role: "viewer",
        sharingKeyVersion: 1,
        encryptedNoteKey: "old_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(201);

    await alice
      .post(`/api/notes/${noteId}/key-rotation`)
      .set(csrfHeaders())
      .send({
        encryptedNoteKey: "rotated_owner_note_key_abcdefghijklmnopqrstuvwxyz",
        noteKeyNonce: "rotated_owner_nonce_abcdefghijklmnopqrstuvwxyz",
        contentCipher: "rotated_content_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "rotated_content_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 777,
        version: 1,
        shares: [],
        attachmentKeys: []
      })
      .expect(400);
  });

  it("rolls back membership invites when event writes fail", async () => {
    const app = createTestApp();
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

    failNoteEventWrites(app);

    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        username: "rollback_member_bob",
        role: "editor",
        sharingKeyVersion: 1,
        encryptedNoteKey: "rollback_share_for_bob_abcdefghijklmnopqrstuvwxyz",
        formatVersion: 1
      })
      .expect(500);

    const membership = app.locals.db.sqlite
      .prepare(
        `SELECT role
         FROM note_memberships
         WHERE note_id = ? AND user_id = ?`
      )
      .get(noteId, bobUserId);
    expect(membership).toBeUndefined();

    const keyShare = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_note_key AS encryptedNoteKey
         FROM note_key_shares
         WHERE note_id = ? AND recipient_user_id = ?`
      )
      .get(noteId, bobUserId);
    expect(keyShare).toBeUndefined();
  });

  it("rolls back membership role updates when event writes fail", async () => {
    const app = createTestApp();
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
        formatVersion: 1
      })
      .expect(201);

    failNoteEventWrites(app);

    await alice
      .patch(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .send({ role: "viewer" })
      .expect(500);

    const membership = app.locals.db.sqlite
      .prepare(
        `SELECT role, status
         FROM note_memberships
         WHERE note_id = ? AND user_id = ?`
      )
      .get(noteId, bobUserId);
    expect(membership).toEqual({ role: "editor", status: "active" });
  });

  it("rolls back membership revokes when event writes fail", async () => {
    const app = createTestApp();
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
        formatVersion: 1
      })
      .expect(201);

    failNoteEventWrites(app);

    await alice
      .delete(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .expect(500);

    const membership = app.locals.db.sqlite
      .prepare(
        `SELECT role, status
         FROM note_memberships
         WHERE note_id = ? AND user_id = ?`
      )
      .get(noteId, bobUserId);
    expect(membership).toEqual({ role: "editor", status: "active" });
    const keyShare = app.locals.db.sqlite
      .prepare(
        `SELECT encrypted_note_key AS encryptedNoteKey
         FROM note_key_shares
         WHERE note_id = ? AND recipient_user_id = ?`
      )
      .get(noteId, bobUserId);
    expect(keyShare).toEqual({
      encryptedNoteKey: "rollback_revoke_share_for_bob_abcdefghijklmnopqrstuvwxyz"
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

function failNoteEventWrites(app: ReturnType<typeof createTestApp>): void {
  app.locals.db.sqlite.exec(`
    CREATE TRIGGER fail_note_events_insert
    BEFORE INSERT ON note_events
    BEGIN
      SELECT RAISE(ABORT, 'note event failure');
    END;
  `);
}
