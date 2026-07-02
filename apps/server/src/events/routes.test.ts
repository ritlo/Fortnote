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

    await alice
      .put(`/api/notes/${noteId}`)
      .set(csrfHeaders())
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
      version: 2
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

  it("rejects unauthenticated replay requests", async () => {
    const app = createTestApp();
    await request(app).get("/api/events").expect(401);
  });
});
