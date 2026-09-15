import { afterEach, describe, expect, it } from "vitest";
import type { RawData } from "ws";
import {
  csrfHeaders,
  folderPayload,
  noteMetadataUpdate,
  notePayload
} from "../support/http.js";
import {
  authed,
  cleanupRealtimeTests,
  connect,
  connectRejected,
  createRealtimeTestServer,
  expectNoMessage,
  invitePayload,
  parseSocketMessage,
  register,
  sharingKeyPayload,
  waitForClose
} from "./realtime.fixtures.js";
import { testSql } from "../support/database.js";

afterEach(cleanupRealtimeTests);

describe("realtime server", () => {
  it("rejects unauthenticated websocket connections", async () => {
    const server = await createRealtimeTestServer();

    await expect(connectRejected(`${server.url}/api/realtime`)).resolves.toMatch(/401/);
  });

  it("rejects authenticated websocket connections from other origins", async () => {
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "ws_origin_alice");

    await expect(
      connectRejected(`${server.url}/api/realtime`, {
        Cookie: alice.cookie,
        Origin: "http://evil.test"
      })
    ).resolves.toMatch(/403/);
  });

  it("closes an established websocket on logout", async () => {
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "ws_logout_alice");
    const aliceSocket = await connect(server.url, alice.cookie, 0);
    await aliceSocket.next("alice connected");
    await aliceSocket.next("alice replay");

    const closed = waitForClose(aliceSocket.socket);
    await authed(server.url, alice.cookie)
      .post("/api/auth/logout")
      .set(csrfHeaders())
      .expect(204);

    await expect(closed).resolves.toBe(1008);
  });

  it.each(["idle_expires_at", "absolute_expires_at"])(
    "closes an established websocket after %s",
    async (expiryColumn) => {
      const server = await createRealtimeTestServer({ sessionSweepIntervalMs: 10 });
      const alice = await register(server.url, `ws_expiry_${expiryColumn}`);
      const aliceSocket = await connect(server.url, alice.cookie, 0);
      await aliceSocket.next("alice connected");
      await aliceSocket.next("alice replay");

      const closed = waitForClose(aliceSocket.socket);
      await testSql(server.db).run(
        `UPDATE sessions SET ${expiryColumn} = ?`,
        new Date(0).toISOString()
      );

      await expect(closed).resolves.toBe(1008);
    }
  );

  it("pushes live events and replays missed events", async () => {
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "ws_alice");
    const bob = await register(server.url, "ws_bob");
    const carol = await register(server.url, "ws_carol");

    await authed(server.url, bob.cookie)
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("ws_bob"))
      .expect(201);
    await authed(server.url, carol.cookie)
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("ws_carol"))
      .expect(201);

    const created = await authed(server.url, alice.cookie)
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);

    await authed(server.url, alice.cookie)
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send(invitePayload("ws_bob", "editor"))
      .expect(201);
    await authed(server.url, alice.cookie)
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send(invitePayload("ws_carol", "viewer"))
      .expect(201);

    const currentCursor = (await testSql(server.db).get<{ cursor: number }>(
      "SELECT MAX(cursor) AS cursor FROM note_events"
    ))!.cursor;

    const bobSocket = await connect(server.url, bob.cookie, currentCursor);
    expect(await bobSocket.next("bob connected")).toMatchObject({ type: "connected" });
    expect(await bobSocket.next("bob replay")).toMatchObject({
      type: "replay",
      events: []
    });

    const bobLiveEvent = bobSocket.next("bob live event");
    await authed(server.url, alice.cookie)
      .put(`/api/notes/${noteId}`)
      .set(csrfHeaders())
      .send(noteMetadataUpdate(1, "realtime"))
      .expect(200);

    expect(await bobLiveEvent).toMatchObject({
      type: "event",
      event: {
        type: "note.updated",
        noteId,
        version: 2
      }
    });

    const carolSocket = await connect(server.url, carol.cookie, 0);
    expect(await carolSocket.next("carol connected")).toMatchObject({
      type: "connected"
    });
    const carolReplay = await carolSocket.next("carol replay");
    expect(carolReplay).toMatchObject({ type: "replay" });
    expect(
      (carolReplay.events as { type: string; noteId: string | null }[]).some(
        (event) => event.type === "note.updated" && event.noteId === noteId
      )
    ).toBe(true);

    bobSocket.socket.close();
    carolSocket.socket.close();
  });

  it("closes revoked sockets before activating a linked epoch", async () => {
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "linked_ws_alice");
    const bob = await register(server.url, "linked_ws_bob");
    const carol = await register(server.url, "linked_ws_carol");
    const carolUser = await authed(server.url, carol.cookie)
      .get("/api/auth/me")
      .expect(200);

    for (const [account, username] of [
      [bob, "linked_ws_bob"],
      [carol, "linked_ws_carol"]
    ] as const) {
      await authed(server.url, account.cookie)
        .put("/api/sharing-keys/current")
        .set(csrfHeaders())
        .send({
          ...sharingKeyPayload(username),
          sharingKeyVersion: 2,
          formatVersion: 2
        })
        .expect(201);
    }

    const created = await authed(server.url, alice.cookie)
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);
    const bobMembership = await authed(server.url, alice.cookie)
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        ...invitePayload("linked_ws_bob", "editor"),
        sharingKeyVersion: 2,
        formatVersion: 2
      })
      .expect(201);
    await authed(server.url, alice.cookie)
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send({
        ...invitePayload("linked_ws_carol", "editor"),
        sharingKeyVersion: 2,
        formatVersion: 2
      })
      .expect(201);

    const currentCursor = (await testSql(server.db).get<{ cursor: number }>(
      "SELECT MAX(cursor) AS cursor FROM note_events"
    ))!.cursor;
    const aliceSocket = await connect(server.url, alice.cookie, currentCursor);
    const bobSocket = await connect(server.url, bob.cookie, currentCursor);
    const bobSecondSocket = await connect(server.url, bob.cookie, currentCursor);
    for (const [socket, label] of [
      [aliceSocket, "alice"],
      [bobSocket, "bob"],
      [bobSecondSocket, "bob second"]
    ] as const) {
      await socket.next(`${label} connected`);
      await socket.next(`${label} replay`);
    }

    bobSocket.socket.send(JSON.stringify({ type: "presence", noteId, state: "editing" }));
    await aliceSocket.next("alice sees bob presence");
    await bobSocket.next("bob sees own presence");
    await bobSecondSocket.next("bob second sees presence");

    const bobMessagesAfterActivation: Record<string, unknown>[] = [];
    const recordBobMessage = (data: RawData) => {
      bobMessagesAfterActivation.push(parseSocketMessage(data));
    };
    bobSocket.socket.on("message", recordBobMessage);
    bobSecondSocket.socket.on("message", recordBobMessage);
    const bobClosed = waitForClose(bobSocket.socket);
    const bobSecondClosed = waitForClose(bobSecondSocket.socket);

    await authed(server.url, alice.cookie)
      .post(`/api/notes/${noteId}/key-rotation`)
      .set(csrfHeaders())
      .send({
        mode: "linked",
        revokedUserId: bobMembership.body.userId,
        rootVersion: 1,
        sourceEpoch: 1,
        targetEpoch: 2,
        encryptedNoteKey: "linked_ws_owner_note_key_abcdefghijklmnopqrstuvwxyz",
        noteKeyNonce: "linked_ws_owner_note_nonce_abcdefghijklmnopqrstuvwxyz",
        noteKeyFormatVersion: 2,
        titleCipher: "linked_ws_title_cipher_abcdefghijklmnopqrstuvwxyz",
        titleNonce: "linked_ws_title_nonce_abcdefghijklmnopqrstuvwxyz",
        titleFormatVersion: 2,
        previousKeyCipher: "linked_ws_previous_key_cipher_abcdefghijklmnopqrstuvwxyz",
        previousKeyNonce: "linked_ws_previous_key_nonce_abcdefghijklmnopqrstuvwxyz",
        linkFormatVersion: 2,
        shares: [
          {
            recipientUserId: carolUser.body.id,
            sharingKeyVersion: 2,
            encryptedNoteKey: "linked_ws_carol_note_share_abcdefghijklmnopqrstuvwxyz",
            formatVersion: 2
          }
        ]
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ keyEpoch: 2, rootVersion: 2 });
      });

    await expect(bobClosed).resolves.toBe(1008);
    await expect(bobSecondClosed).resolves.toBe(1008);
    expect(bobMessagesAfterActivation).toEqual([]);
    expect(await aliceSocket.next("revoked presence removed")).toMatchObject({
      type: "presence",
      noteId,
      users: []
    });
    expect(await aliceSocket.next("linked epoch event")).toMatchObject({
      type: "event",
      event: {
        noteId,
        type: "membership.revoked",
        metadata: { targetEpoch: 2 }
      }
    });

    await authed(server.url, bob.cookie)
      .get(`/api/notes/${noteId}/key-share`)
      .expect(404);
    await authed(server.url, bob.cookie)
      .get(`/api/notes/${noteId}/epoch-links`)
      .expect(404);

    const reconnectedBob = await connect(server.url, bob.cookie, currentCursor);
    await reconnectedBob.next("reconnected bob connected");
    await reconnectedBob.next("reconnected bob replay");
    reconnectedBob.socket.send(
      JSON.stringify({ type: "presence", noteId, state: "editing" })
    );
    await expectNoMessage(reconnectedBob, "revoked target-epoch presence");
  });

  it("pushes actor-scoped folder events only to the actor", async () => {
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "ws_folder_alice");
    const bob = await register(server.url, "ws_folder_bob");

    const aliceSocket = await connect(server.url, alice.cookie, 0);
    const bobSocket = await connect(server.url, bob.cookie, 0);
    expect(await aliceSocket.next("alice connected")).toMatchObject({
      type: "connected"
    });
    expect(await aliceSocket.next("alice replay")).toMatchObject({
      type: "replay",
      events: []
    });
    expect(await bobSocket.next("bob connected")).toMatchObject({ type: "connected" });
    expect(await bobSocket.next("bob replay")).toMatchObject({
      type: "replay",
      events: []
    });

    const aliceFolderEvent = aliceSocket.next("alice folder event");
    await authed(server.url, alice.cookie)
      .post("/api/folders")
      .set(csrfHeaders())
      .send(folderPayload())
      .expect(201);

    expect(await aliceFolderEvent).toMatchObject({
      type: "event",
      event: {
        noteId: null,
        resourceType: "folder",
        type: "folder.created"
      }
    });
    await expectNoMessage(bobSocket, "bob forbidden folder event");
  });

  it("pushes permanent-delete tombstones after membership removal", async () => {
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "ws_delete_alice");
    const bob = await register(server.url, "ws_delete_bob");

    await authed(server.url, bob.cookie)
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("ws_delete_bob"))
      .expect(201);
    const created = await authed(server.url, alice.cookie)
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);
    await authed(server.url, alice.cookie)
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send(invitePayload("ws_delete_bob", "editor"))
      .expect(201);

    const currentCursor = (await testSql(server.db).get<{ cursor: number }>(
      "SELECT MAX(cursor) AS cursor FROM note_events"
    ))!.cursor;
    const bobSocket = await connect(server.url, bob.cookie, currentCursor);
    await bobSocket.next("bob connected");
    await bobSocket.next("bob replay");

    const deleteEvent = bobSocket.next("bob permanent delete");
    await authed(server.url, alice.cookie)
      .delete(`/api/notes/${noteId}/permanent`)
      .set(csrfHeaders())
      .expect(204);

    expect(await deleteEvent).toMatchObject({
      type: "event",
      event: {
        noteId,
        type: "note.permanently_deleted"
      }
    });
    bobSocket.socket.close();
  });

  it("broadcasts note presence only to active members", async () => {
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "presence_alice");
    const bob = await register(server.url, "presence_bob");
    const mallory = await register(server.url, "presence_mallory");
    const created = await authed(server.url, alice.cookie)
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);
    await authed(server.url, bob.cookie)
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("presence_bob"))
      .expect(201);
    await authed(server.url, alice.cookie)
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send(invitePayload("presence_bob", "editor"))
      .expect(201);

    const aliceSocket = await connect(server.url, alice.cookie, 0);
    const bobSocket = await connect(server.url, bob.cookie, 0);
    const mallorySocket = await connect(server.url, mallory.cookie, 0);
    await aliceSocket.next("alice connected");
    await aliceSocket.next("alice replay");
    await bobSocket.next("bob connected");
    await bobSocket.next("bob replay");
    await mallorySocket.next("mallory connected");
    await mallorySocket.next("mallory replay");

    bobSocket.socket.send(JSON.stringify({ type: "presence", noteId, state: "editing" }));

    expect(await aliceSocket.next("alice presence")).toMatchObject({
      type: "presence",
      noteId,
      users: [
        {
          username: "presence_bob",
          state: "editing"
        }
      ]
    });
    expect(await bobSocket.next("bob own presence")).toMatchObject({
      type: "presence",
      noteId
    });

    bobSocket.socket.send(JSON.stringify({ type: "presence", noteId, state: "left" }));

    expect(await aliceSocket.next("alice presence left")).toMatchObject({
      type: "presence",
      noteId,
      users: []
    });

    mallorySocket.socket.send(
      JSON.stringify({ type: "presence", noteId, state: "editing" })
    );
    await expectNoMessage(mallorySocket, "mallory forbidden presence");
  });

  it("expires stale note presence", async () => {
    const server = await createRealtimeTestServer({
      presenceSweepIntervalMs: 10,
      presenceTtlMs: 30
    });
    const alice = await register(server.url, "presence_expiry_alice");
    const bob = await register(server.url, "presence_expiry_bob");
    const created = await authed(server.url, alice.cookie)
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);
    await authed(server.url, bob.cookie)
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("presence_expiry_bob"))
      .expect(201);
    await authed(server.url, alice.cookie)
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send(invitePayload("presence_expiry_bob", "editor"))
      .expect(201);

    const aliceSocket = await connect(server.url, alice.cookie, 0);
    const bobSocket = await connect(server.url, bob.cookie, 0);
    await aliceSocket.next("alice connected");
    await aliceSocket.next("alice replay");
    await bobSocket.next("bob connected");
    await bobSocket.next("bob replay");

    bobSocket.socket.send(JSON.stringify({ type: "presence", noteId, state: "idle" }));

    expect(await aliceSocket.next("alice presence")).toMatchObject({
      type: "presence",
      noteId,
      users: [
        {
          username: "presence_expiry_bob",
          state: "idle"
        }
      ]
    });
    expect(await aliceSocket.next("alice expired presence")).toMatchObject({
      type: "presence",
      noteId,
      users: []
    });
  });
});
