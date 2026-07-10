import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  createTestApp,
  csrfHeaders,
  notePayload,
  registerAgent
} from "../test/http.js";

function sharingKeyPayload(username: string) {
  return {
    sharingKeyVersion: 1,
    publicKey: `public_sharing_key_${username}_abcdefghijklmnopqrstuvwxyz`,
    encryptedPrivateKey: `encrypted_private_key_${username}_abcdefghijklmnopqrstuvwxyz`,
    privateKeyNonce: `private_key_nonce_${username}_abcdefghijklmnopqrstuvwxyz`,
    formatVersion: 1
  };
}

function invitePayload(username: string, role: "editor" | "viewer") {
  return {
    username,
    role,
    sharingKeyVersion: 1,
    encryptedNoteKey: `encrypted_share_for_${username}_abcdefghijklmnopqrstuvwxyz`,
    formatVersion: 1
  };
}

describe("event replay routes", () => {
  it("replays visible events for online and offline collaborators", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "events_alice");
    const bob = await registerAgent(app, "events_bob");
    const carol = await registerAgent(app, "events_carol");

    const carolSession = await carol.get("/api/auth/me").expect(200);
    const carolUserId = String(carolSession.body.id);
    await carol.get("/api/events/cursor").expect(200, { cursor: 0 });

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("events_bob"))
      .expect(201);
    await carol
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("events_carol"))
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
      .send(invitePayload("events_bob", "editor"))
      .expect(201);
    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send(invitePayload("events_carol", "viewer"))
      .expect(201);

    const bobInitial = await bob.get("/api/events").query({ after: 0 }).expect(200);
    expect(bobInitial.body.events.map((event: { type: string }) => event.type)).toEqual([
      "note.created",
      "membership.added",
      "membership.added"
    ]);
    const bobCursor = Number(bobInitial.body.events.at(-1).cursor);
    const clientInstanceId = crypto.randomUUID();

    await alice
      .put(`/api/notes/${noteId}`)
      .set({
        ...csrfHeaders(),
        "x-fortnote-client-id": clientInstanceId
      })
      .send({
        title: "Alice offline replay edit",
        contentCipher: "alice_event_update_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "alice_event_update_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 400,
        version: 1
      })
      .expect(200);

    const bobReplay = await bob.get("/api/events").query({ after: bobCursor }).expect(200);
    expect(bobReplay.body.events).toHaveLength(1);
    expect(bobReplay.body.events[0]).toMatchObject({
      type: "note.updated",
      noteId,
      version: 2,
      metadata: { clientInstanceId }
    });

    const carolReplay = await carol.get("/api/events").query({ after: 0 }).expect(200);
    expect(carolReplay.body.events.map((event: { type: string }) => event.type)).toEqual([
      "note.created",
      "membership.added",
      "membership.added",
      "note.updated"
    ]);

    await alice
      .delete(`/api/notes/${noteId}/memberships/${carolUserId}`)
      .set(csrfHeaders())
      .expect(204);

    const carolRevoked = await carol.get("/api/events").query({ after: 0 }).expect(200);
    expect(carolRevoked.body.events.map((event: { type: string }) => event.type)).toEqual([
      "membership.revoked"
    ]);
    expect(carolRevoked.body.events[0].metadata).toMatchObject({
      membershipUserId: carolUserId
    });
    const revokeCursor = Number(carolRevoked.body.events[0].cursor);

    await carol
      .post("/api/events/ack")
      .set(csrfHeaders())
      .send({ cursor: revokeCursor })
      .expect(204);
    await carol.get("/api/events/cursor").expect(200, { cursor: revokeCursor });

    await carol
      .post("/api/events/ack")
      .set(csrfHeaders())
      .send({ cursor: revokeCursor - 1 })
      .expect(204);
    await carol.get("/api/events/cursor").expect(200, { cursor: revokeCursor });

    const carolAfterAckFromStart = await carol
      .get("/api/events")
      .query({ after: 0 })
      .expect(200);
    expect(carolAfterAckFromStart.body.events).toEqual([]);

    await bob
      .put(`/api/notes/${noteId}`)
      .set(csrfHeaders())
      .send({
        title: "Bob event edit",
        contentCipher: "bob_event_update_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "bob_event_update_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 500,
        version: 2
      })
      .expect(200);

    const carolAfterRevoke = await carol
      .get("/api/events")
      .query({ after: revokeCursor })
      .expect(200);
    expect(carolAfterRevoke.body.events).toEqual([]);
  });

  it("prunes only events acknowledged by every user", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "retention_alice");
    const bob = await registerAgent(app, "retention_bob");

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("retention_bob"))
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
      .send(invitePayload("retention_bob", "editor"))
      .expect(201);

    const latest = app.locals.db.sqlite
      .prepare("SELECT MAX(cursor) AS cursor FROM note_events")
      .get() as { cursor: number };
    expect(latest.cursor).toBeGreaterThan(0);

    await alice
      .post("/api/events/ack")
      .set(csrfHeaders())
      .send({ cursor: latest.cursor })
      .expect(204);
    const remainingAfterAliceAck = app.locals.db.sqlite
      .prepare("SELECT COUNT(*) AS count FROM note_events WHERE cursor <= ?")
      .get(latest.cursor) as { count: number };
    expect(remainingAfterAliceAck.count).toBeGreaterThan(0);

    await bob
      .post("/api/events/ack")
      .set(csrfHeaders())
      .send({ cursor: latest.cursor })
      .expect(204);

    const remaining = app.locals.db.sqlite
      .prepare("SELECT COUNT(*) AS count FROM note_events WHERE cursor <= ?")
      .get(latest.cursor) as { count: number };
    expect(remaining.count).toBe(0);
  });

  it("prunes actor-scoped folder events without unrelated user acknowledgements", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "retention_folder_alice");
    await registerAgent(app, "retention_folder_bob");

    await alice
      .post("/api/folders")
      .set(csrfHeaders())
      .send({ name: "Private folder" })
      .expect(201);

    const latest = app.locals.db.sqlite
      .prepare("SELECT MAX(cursor) AS cursor FROM note_events")
      .get() as { cursor: number };

    await alice
      .post("/api/events/ack")
      .set(csrfHeaders())
      .send({ cursor: latest.cursor })
      .expect(204);

    const remaining = app.locals.db.sqlite
      .prepare("SELECT COUNT(*) AS count FROM note_events WHERE cursor <= ?")
      .get(latest.cursor) as { count: number };
    expect(remaining.count).toBe(0);
  });

  it("retains revoke tombstones until the revoked user acknowledges them", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "retention_revoke_alice");
    const bob = await registerAgent(app, "retention_revoke_bob");
    const carol = await registerAgent(app, "retention_revoke_carol");
    const carolSession = await carol.get("/api/auth/me").expect(200);
    const carolUserId = String(carolSession.body.id);

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("retention_revoke_bob"))
      .expect(201);
    await carol
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("retention_revoke_carol"))
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
      .send(invitePayload("retention_revoke_bob", "editor"))
      .expect(201);
    await alice
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send(invitePayload("retention_revoke_carol", "viewer"))
      .expect(201);
    await alice
      .delete(`/api/notes/${noteId}/memberships/${carolUserId}`)
      .set(csrfHeaders())
      .expect(204);

    const revoke = app.locals.db.sqlite
      .prepare(
        `SELECT cursor
         FROM note_events
         WHERE note_id = ? AND event_type = 'membership.revoked'`
      )
      .get(noteId) as { cursor: number };

    await alice
      .post("/api/events/ack")
      .set(csrfHeaders())
      .send({ cursor: revoke.cursor })
      .expect(204);
    await bob
      .post("/api/events/ack")
      .set(csrfHeaders())
      .send({ cursor: revoke.cursor })
      .expect(204);

    const remainingBeforeCarolAck = app.locals.db.sqlite
      .prepare("SELECT COUNT(*) AS count FROM note_events WHERE cursor = ?")
      .get(revoke.cursor) as { count: number };
    expect(remainingBeforeCarolAck.count).toBe(1);

    await carol
      .post("/api/events/ack")
      .set(csrfHeaders())
      .send({ cursor: revoke.cursor })
      .expect(204);

    const remainingAfterCarolAck = app.locals.db.sqlite
      .prepare("SELECT COUNT(*) AS count FROM note_events WHERE cursor = ?")
      .get(revoke.cursor) as { count: number };
    expect(remainingAfterCarolAck.count).toBe(0);
  });

  it("replays and retains permanent-delete tombstones for former members", async () => {
    const app = createTestApp();
    const alice = await registerAgent(app, "delete_replay_alice");
    const bob = await registerAgent(app, "delete_replay_bob");

    await bob
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("delete_replay_bob"))
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
      .send(invitePayload("delete_replay_bob", "editor"))
      .expect(201);

    await alice
      .delete(`/api/notes/${noteId}/permanent`)
      .set(csrfHeaders())
      .expect(204);

    const bobReplay = await bob.get("/api/events").query({ after: 0 }).expect(200);
    expect(bobReplay.body.events).toHaveLength(1);
    expect(bobReplay.body.events[0]).toMatchObject({
      noteId,
      type: "note.permanently_deleted"
    });
    const deleteCursor = Number(bobReplay.body.events[0].cursor);

    await alice
      .post("/api/events/ack")
      .set(csrfHeaders())
      .send({ cursor: deleteCursor })
      .expect(204);
    const retainedBeforeBobAck = app.locals.db.sqlite
      .prepare("SELECT COUNT(*) AS count FROM note_events WHERE cursor = ?")
      .get(deleteCursor) as { count: number };
    expect(retainedBeforeBobAck.count).toBe(1);

    await bob
      .post("/api/events/ack")
      .set(csrfHeaders())
      .send({ cursor: deleteCursor })
      .expect(204);
    const bobAfterAck = await bob.get("/api/events").query({ after: 0 }).expect(200);
    expect(bobAfterAck.body.events).toEqual([]);

    const retainedAfterBobAck = app.locals.db.sqlite
      .prepare("SELECT COUNT(*) AS count FROM note_events WHERE cursor = ?")
      .get(deleteCursor) as { count: number };
    expect(retainedAfterBobAck.count).toBe(0);
  });

  it("rejects unauthenticated replay requests", async () => {
    const app = createTestApp();
    await request(app).get("/api/events").expect(401);
    await request(app).get("/api/events/cursor").expect(401);
  });

  it("rejects unauthenticated acknowledgement requests", async () => {
    const app = createTestApp();
    await request(app)
      .post("/api/events/ack")
      .set(csrfHeaders())
      .send({ cursor: 1 })
      .expect(401);
  });
});
