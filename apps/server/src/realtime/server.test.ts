import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import WebSocket, { type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  CRDT_BINARY_FORMAT_VERSION,
  cryptoReady,
  decodeCrdtBinaryFrame,
  encodeCrdtBinaryFrame,
  toBase64,
  type CrdtBinaryHeader
} from "@fortnote/shared";
import { getConfig } from "../config.js";
import { createDb, type AppDb } from "../db/client.js";
import { createApp, type AppContext } from "../http/app.js";
import { compareAndSetSectionInitialization } from "../notes/sections.js";
import {
  csrfHeaders,
  notePayload,
  registerPayload
} from "../test/http.js";
import { RealtimeHub } from "./hub.js";
import { attachRealtimeServer } from "./server.js";

interface TestServer {
  context: AppContext;
  db: AppDb;
  httpServer: Server;
  realtime: RealtimeHub;
  url: string;
}

interface TestServerOptions {
  databasePath?: string;
  historyPageMaxItems?: number;
  presenceSweepIntervalMs?: number;
  presenceTtlMs?: number;
  sessionSweepIntervalMs?: number;
}

interface SocketClient {
  socket: WebSocket;
  next: (label: string) => Promise<Record<string, unknown>>;
}

interface BinarySocketClient {
  socket: WebSocket;
  nextBinary: (label: string) => Promise<Uint8Array>;
  nextJson: (label: string) => Promise<Record<string, unknown>>;
}

const openServers: Server[] = [];
const openSockets: WebSocket[] = [];
const openHubs: RealtimeHub[] = [];
const openDatabases: AppDb[] = [];
const temporaryDirectories: string[] = [];
const TEST_ALLOWED_ORIGIN = "http://localhost:5173";

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    socket.close();
  }
  for (const hub of openHubs.splice(0)) {
    hub.close();
  }
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
    )
  );
  for (const db of openDatabases.splice(0)) {
    db.sqlite.close();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("realtime server", () => {
  it("persists, deduplicates, pages, and epoch-fences binary section updates", async () => {
    await cryptoReady();
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "binary_alice");
    const noteId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    await authed(server.url, alice.cookie)
      .post("/api/notes")
      .set(csrfHeaders())
      .send(protectedNotePayload(noteId, sectionId))
      .expect(201);
    const cryptoOwnerId = (
      server.db.sqlite
        .prepare("SELECT crypto_owner_id AS cryptoOwnerId FROM notes WHERE id = ?")
        .get(noteId) as { cryptoOwnerId: string }
    ).cryptoOwnerId;
    const socket = await connectBinary(server.url, alice.cookie);
    expect(await socket.nextJson("binary connected")).toMatchObject({
      type: "connected",
      capabilities: expect.arrayContaining(["crdt-binary-v2"])
    });
    await socket.nextJson("binary replay");

    socket.socket.send(JSON.stringify({
      type: "crdt-subscribe",
      requestId: crypto.randomUUID(),
      noteId,
      sectionId,
      expectedKeyEpoch: 1,
      afterSequence: 0
    }));
    expect(await socket.nextJson("empty binary history")).toMatchObject({
      type: "crdt-history-page",
      sectionId,
      entries: [],
      nextSequence: 0
    });

    const cipher = Uint8Array.from([4, 8, 15, 16, 23, 42]);
    const header = binaryHeader({ noteId, sectionId, cryptoOwnerId });
    const frame = encodeCrdtBinaryFrame(header, cipher, 256 * 1024);
    socket.socket.send(frame);
    expect(await socket.nextJson("binary inserted ack")).toEqual({
      type: "crdt-ack",
      updateId: header.updateId,
      sectionId,
      result: "inserted",
      keyEpoch: 1,
      serverSequence: 1
    });
    expect(
      server.db.sqlite
        .prepare(`
          SELECT server_sequence AS serverSequence, inline_cipher AS inlineCipher
          FROM section_updates WHERE update_id = ?
        `)
        .get(header.updateId)
    ).toEqual({ serverSequence: 1, inlineCipher: Buffer.from(cipher) });

    socket.socket.send(frame);
    expect(await socket.nextJson("binary duplicate ack")).toMatchObject({
      type: "crdt-ack",
      updateId: header.updateId,
      result: "already-present",
      serverSequence: 1
    });
    expect(
      server.db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM section_updates WHERE update_id = ?")
        .get(header.updateId)
    ).toEqual({ count: 1 });

    const staleHeader = binaryHeader({
      noteId,
      sectionId,
      cryptoOwnerId,
      expectedKeyEpoch: 2
    });
    socket.socket.send(encodeCrdtBinaryFrame(staleHeader, cipher, 256 * 1024));
    expect(await socket.nextJson("stale binary reject")).toEqual({
      type: "crdt-reject",
      updateId: staleHeader.updateId,
      sectionId,
      code: "stale-epoch"
    });

    server.db.sqlite
      .prepare("UPDATE notes SET rotation_fenced = 1 WHERE id = ?")
      .run(noteId);
    const fencedHeader = binaryHeader({ noteId, sectionId, cryptoOwnerId });
    socket.socket.send(encodeCrdtBinaryFrame(fencedHeader, cipher, 256 * 1024));
    expect(await socket.nextJson("rotation fence reject")).toEqual({
      type: "crdt-reject",
      updateId: fencedHeader.updateId,
      sectionId,
      code: "rotation-pending"
    });
    server.db.sqlite
      .prepare("UPDATE notes SET rotation_fenced = 0 WHERE id = ?")
      .run(noteId);

    const oversizedCipher = new Uint8Array(256 * 1024);
    const oversizedHeader = {
      ...binaryHeader({ noteId, sectionId, cryptoOwnerId }),
      cipherLength: oversizedCipher.length
    };
    socket.socket.send(
      encodeCrdtBinaryFrame(oversizedHeader, oversizedCipher, 1024 * 1024)
    );
    expect(await socket.nextJson("oversized binary reject")).toEqual({
      type: "crdt-reject",
      updateId: oversizedHeader.updateId,
      sectionId,
      code: "frame-too-large"
    });

    const invalidSectionId = crypto.randomUUID();
    const invalidRequestId = crypto.randomUUID();
    socket.socket.send(JSON.stringify({
      type: "crdt-subscribe",
      requestId: invalidRequestId,
      noteId,
      sectionId: invalidSectionId,
      expectedKeyEpoch: 1,
      afterSequence: 0
    }));
    expect(await socket.nextJson("invalid section reject")).toEqual({
      type: "crdt-reject",
      updateId: invalidRequestId,
      sectionId: invalidSectionId,
      code: "forbidden"
    });

    const replay = await connectBinary(server.url, alice.cookie);
    await replay.nextJson("replay connected");
    await replay.nextJson("replay events");
    replay.socket.send(JSON.stringify({
      type: "crdt-subscribe",
      requestId: crypto.randomUUID(),
      noteId,
      sectionId,
      expectedKeyEpoch: 1,
      afterSequence: 0
    }));
    const replayedFrame = await replay.nextBinary("persisted binary frame");
    expect(decodeCrdtBinaryFrame(replayedFrame, 256 * 1024)).toEqual({
      header: { ...header, serverSequence: 1 },
      cipher
    });
    expect(await replay.nextJson("persisted history page")).toMatchObject({
      type: "crdt-history-page",
      sectionId,
      nextSequence: 1,
      entries: [{ kind: "inline", updateId: header.updateId, serverSequence: 1 }]
    });
  });

  it("replays paged binary history after a file-backed database restart", async () => {
    await cryptoReady();
    const directory = await mkdtemp(join(tmpdir(), "fortnote-realtime-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "fortnote.sqlite");
    const firstServer = await createRealtimeTestServer({
      databasePath,
      historyPageMaxItems: 2
    });
    const alice = await register(firstServer.url, "restart_alice");
    const noteId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    await authed(firstServer.url, alice.cookie)
      .post("/api/notes")
      .set(csrfHeaders())
      .send(protectedNotePayload(noteId, sectionId))
      .expect(201);
    const cryptoOwnerId = (
      firstServer.db.sqlite
        .prepare("SELECT crypto_owner_id AS cryptoOwnerId FROM notes WHERE id = ?")
        .get(noteId) as { cryptoOwnerId: string }
    ).cryptoOwnerId;
    const writer = await connectBinary(firstServer.url, alice.cookie);
    await writer.nextJson("restart writer connected");
    await writer.nextJson("restart writer replay");
    const updates = [1, 2, 3].map((value) => ({
      cipher: Uint8Array.from([value, 0, 0, 0, 0, 0]),
      header: binaryHeader({ noteId, sectionId, cryptoOwnerId })
    }));
    for (const [index, update] of updates.entries()) {
      writer.socket.send(
        encodeCrdtBinaryFrame(update.header, update.cipher, 256 * 1024)
      );
      expect(await writer.nextJson(`restart update ${String(index + 1)} ack`)).toMatchObject({
        type: "crdt-ack",
        updateId: update.header.updateId,
        result: "inserted",
        serverSequence: index + 1
      });
      expect(
        firstServer.db.sqlite
          .prepare("SELECT server_sequence AS serverSequence FROM section_updates WHERE update_id = ?")
          .get(update.header.updateId)
      ).toEqual({ serverSequence: index + 1 });
    }

    await closeSocket(writer.socket);
    await stopRealtimeTestServer(firstServer);

    const restarted = await createRealtimeTestServer({
      databasePath,
      historyPageMaxItems: 2
    });
    const reader = await connectBinary(restarted.url, alice.cookie);
    await reader.nextJson("restart reader connected");
    await reader.nextJson("restart reader replay");
    reader.socket.send(JSON.stringify({
      type: "crdt-subscribe",
      requestId: crypto.randomUUID(),
      noteId,
      sectionId,
      expectedKeyEpoch: 1,
      afterSequence: 0
    }));
    const firstPageFrames = await Promise.all([
      reader.nextBinary("restart first page frame one"),
      reader.nextBinary("restart first page frame two")
    ]);
    expect(
      firstPageFrames.map((frame) =>
        decodeCrdtBinaryFrame(frame, 256 * 1024).header.serverSequence
      )
    ).toEqual([1, 2]);
    expect(await reader.nextJson("restart first page outcome")).toMatchObject({
      type: "crdt-history-page",
      afterSequence: 0,
      nextSequence: 2,
      hasMore: true,
      entries: [
        { updateId: updates[0]!.header.updateId, serverSequence: 1 },
        { updateId: updates[1]!.header.updateId, serverSequence: 2 }
      ]
    });

    reader.socket.send(JSON.stringify({
      type: "crdt-subscribe",
      requestId: crypto.randomUUID(),
      noteId,
      sectionId,
      expectedKeyEpoch: 1,
      afterSequence: 2
    }));
    expect(
      decodeCrdtBinaryFrame(
        await reader.nextBinary("restart second page frame"),
        256 * 1024
      )
    ).toEqual({
      header: { ...updates[2]!.header, serverSequence: 3 },
      cipher: updates[2]!.cipher
    });
    expect(await reader.nextJson("restart second page outcome")).toMatchObject({
      type: "crdt-history-page",
      afterSequence: 2,
      nextSequence: 3,
      hasMore: false,
      entries: [{ updateId: updates[2]!.header.updateId, serverSequence: 3 }]
    });
  });

  it("commits checkpoints before compacting only through their observed cutoff", async () => {
    await cryptoReady();
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "checkpoint_alice");
    const noteId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    await authed(server.url, alice.cookie)
      .post("/api/notes")
      .set(csrfHeaders())
      .send(protectedNotePayload(noteId, sectionId))
      .expect(201);
    const cryptoOwnerId = (
      server.db.sqlite
        .prepare("SELECT crypto_owner_id AS cryptoOwnerId FROM notes WHERE id = ?")
        .get(noteId) as { cryptoOwnerId: string }
    ).cryptoOwnerId;
    const socket = await connectBinary(server.url, alice.cookie);
    await socket.nextJson("checkpoint connected");
    await socket.nextJson("checkpoint replay");
    const cipher = Uint8Array.from([4, 8, 15, 16, 23, 42]);

    const rootUpdate = {
      ...binaryHeader({ noteId, sectionId: "root", cryptoOwnerId }),
      kind: "root-update" as const
    };
    socket.socket.send(encodeCrdtBinaryFrame(rootUpdate, cipher, 256 * 1024));
    expect(await socket.nextJson("root update ack")).toMatchObject({
      type: "crdt-ack",
      updateId: rootUpdate.updateId,
      serverSequence: 1
    });

    const first = binaryHeader({ noteId, sectionId, cryptoOwnerId });
    const concurrentLater = binaryHeader({ noteId, sectionId, cryptoOwnerId });
    socket.socket.send(encodeCrdtBinaryFrame(first, cipher, 256 * 1024));
    expect(await socket.nextJson("first section ack")).toMatchObject({
      updateId: first.updateId,
      serverSequence: 1
    });
    socket.socket.send(encodeCrdtBinaryFrame(concurrentLater, cipher, 256 * 1024));
    expect(await socket.nextJson("later section ack")).toMatchObject({
      updateId: concurrentLater.updateId,
      serverSequence: 2
    });

    const checkpoint = {
      ...binaryHeader({ noteId, sectionId, cryptoOwnerId }),
      kind: "checkpoint" as const,
      checkpointSequenceCutoff: 1
    };
    socket.socket.send(encodeCrdtBinaryFrame(checkpoint, cipher, 256 * 1024));
    expect(await socket.nextJson("checkpoint ack")).toEqual({
      type: "crdt-ack",
      updateId: checkpoint.updateId,
      sectionId,
      result: "inserted",
      keyEpoch: 1,
      serverSequence: 3
    });

    expect(
      server.db.sqlite
        .prepare(`
          SELECT
            update_id AS updateId,
            server_sequence AS serverSequence,
            checkpoint_sequence_cutoff AS checkpointSequenceCutoff
          FROM section_updates
          WHERE note_id = ? AND section_id = ?
          ORDER BY server_sequence
        `)
        .all(noteId, sectionId)
    ).toEqual([
      {
        updateId: concurrentLater.updateId,
        serverSequence: 2,
        checkpointSequenceCutoff: null
      },
      {
        updateId: checkpoint.updateId,
        serverSequence: 3,
        checkpointSequenceCutoff: 1
      }
    ]);
    expect(
      server.db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM section_updates WHERE update_id = ?")
        .get(rootUpdate.updateId)
    ).toEqual({ count: 1 });

    const futureCutoff = {
      ...binaryHeader({ noteId, sectionId, cryptoOwnerId }),
      kind: "checkpoint" as const,
      checkpointSequenceCutoff: 99
    };
    socket.socket.send(encodeCrdtBinaryFrame(futureCutoff, cipher, 256 * 1024));
    expect(await socket.nextJson("future cutoff reject")).toEqual({
      type: "crdt-reject",
      updateId: futureCutoff.updateId,
      sectionId,
      code: "forbidden"
    });
  });

  it("installs exactly one current authorized section initialization", async () => {
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "initializer_alice");
    const noteId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    await authed(server.url, alice.cookie)
      .post("/api/notes")
      .set(csrfHeaders())
      .send(protectedNotePayload(noteId, sectionId))
      .expect(201);
    const identity = server.db.sqlite
      .prepare(`
        SELECT s.id AS sessionId, s.user_id AS userId, n.crypto_owner_id AS cryptoOwnerId
        FROM sessions s
        INNER JOIN users u ON u.id = s.user_id
        INNER JOIN notes n ON n.user_id = u.id
        WHERE n.id = ?
        ORDER BY s.created_at DESC
        LIMIT 1
      `)
      .get(noteId) as { sessionId: string; userId: string; cryptoOwnerId: string };
    const winnerManifestId = seedCheckpointManifest(server.db, {
      noteId,
      sectionId,
      cryptoOwnerId: identity.cryptoOwnerId
    });
    const losingManifestId = seedCheckpointManifest(server.db, {
      noteId,
      sectionId,
      cryptoOwnerId: identity.cryptoOwnerId
    });
    const initialization = {
      sessionId: identity.sessionId,
      userId: identity.userId,
      noteId,
      sectionId,
      expectedKeyEpoch: 1,
      expectedRootVersion: 1,
      manifestId: winnerManifestId
    };

    expect(compareAndSetSectionInitialization(server.context, {
      ...initialization,
      expectedRootVersion: 2
    })).toEqual({ status: "rejected", code: "stale-version" });
    expect(compareAndSetSectionInitialization(server.context, initialization)).toEqual({
      status: "installed",
      manifestId: winnerManifestId
    });
    expect(compareAndSetSectionInitialization(server.context, {
      ...initialization,
      manifestId: losingManifestId
    })).toEqual({
      status: "already-initialized",
      manifestId: winnerManifestId
    });
    expect(
      server.db.sqlite
        .prepare(`
          SELECT
            i.manifest_id AS manifestId,
            i.legacy_root_version AS legacyRootVersion,
            s.initialization_manifest_id AS sectionManifestId
          FROM crdt_initializations i
          INNER JOIN note_sections s ON s.id = i.section_id
          WHERE i.note_id = ? AND i.section_id = ? AND i.key_epoch = 1
        `)
        .get(noteId, sectionId)
    ).toEqual({
      manifestId: winnerManifestId,
      legacyRootVersion: 1,
      sectionManifestId: winnerManifestId
    });
  });

  it("rejects unauthenticated websocket connections", async () => {
    const server = await createRealtimeTestServer();

    await expect(connectRejected(`${server.url}/api/realtime`)).resolves.toMatch(
      /401/
    );
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
      server.db.sqlite
        .prepare(`UPDATE sessions SET ${expiryColumn} = ?`)
        .run(new Date(0).toISOString());

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

    const currentCursor = (
      server.db.sqlite
        .prepare("SELECT MAX(cursor) AS cursor FROM note_events")
        .get() as { cursor: number }
    ).cursor;

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
      .send({
        title: "Realtime edit",
        contentCipher: "realtime_update_cipher_abcdefghijklmnopqrstuvwxyz",
        contentNonce: "realtime_update_nonce_abcdefghijklmnopqrstuvwxyz",
        contentLength: 600,
        version: 1
      })
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
    expect(await carolSocket.next("carol connected")).toMatchObject({ type: "connected" });
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

    const currentCursor = (
      server.db.sqlite
        .prepare("SELECT MAX(cursor) AS cursor FROM note_events")
        .get() as { cursor: number }
    ).cursor;
    const cryptoOwnerId = (
      server.db.sqlite
        .prepare("SELECT crypto_owner_id AS cryptoOwnerId FROM notes WHERE id = ?")
        .get(noteId) as { cryptoOwnerId: string }
    ).cryptoOwnerId;
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

    bobSocket.socket.send(
      JSON.stringify({ type: "presence", noteId, state: "editing" })
    );
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
    reconnectedBob.socket.send(JSON.stringify({ type: "crdt-subscribe", noteId }));
    await expectNoMessage(reconnectedBob, "revoked target-epoch subscription");
    reconnectedBob.socket.send(
      JSON.stringify({ type: "presence", noteId, state: "editing" })
    );
    await expectNoMessage(reconnectedBob, "revoked target-epoch presence");

    aliceSocket.socket.send(JSON.stringify({ type: "crdt-subscribe", noteId }));
    expect(await aliceSocket.next("alice target-epoch sync")).toMatchObject({
      type: "crdt-sync",
      noteId,
      keyEpoch: 2
    });
    const targetEpochUpdate = {
      type: "crdt-update",
      formatVersion: 1,
      updateId: crypto.randomUUID(),
      noteId,
      cryptoOwnerId,
      keyEpoch: 2,
      cipher: "linked_ws_target_epoch_cipher_abcdefghijklmnopqrstuvwxyz",
      nonce: "linked_ws_target_epoch_nonce_abcdefghijklmnopqrstuvwxyz"
    };
    aliceSocket.socket.send(JSON.stringify(targetEpochUpdate));
    expect(await aliceSocket.next("alice target-epoch ack")).toEqual({
      type: "crdt-ack",
      updateId: targetEpochUpdate.updateId
    });
    await expectNoMessage(reconnectedBob, "revoked target-epoch update");

    const forbiddenUpdate = { ...targetEpochUpdate, updateId: crypto.randomUUID() };
    reconnectedBob.socket.send(JSON.stringify(forbiddenUpdate));
    expect(await reconnectedBob.next("revoked target-epoch rejection")).toEqual({
      type: "crdt-reject",
      noteId,
      updateId: forbiddenUpdate.updateId,
      reason: "forbidden"
    });
  });

  it("stores encrypted CRDT updates and enforces realtime access", async () => {
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "crdt_alice");
    const bob = await register(server.url, "crdt_bob");
    await authed(server.url, bob.cookie)
      .put("/api/sharing-keys/current")
      .set(csrfHeaders())
      .send(sharingKeyPayload("crdt_bob"))
      .expect(201);
    const created = await authed(server.url, alice.cookie)
      .post("/api/notes")
      .set(csrfHeaders())
      .send(notePayload())
      .expect(201);
    const noteId = String(created.body.id);
    const invited = await authed(server.url, alice.cookie)
      .post(`/api/notes/${noteId}/memberships`)
      .set(csrfHeaders())
      .send(invitePayload("crdt_bob", "editor"))
      .expect(201);
    const bobUserId = String(invited.body.userId);
    const cryptoOwnerId = (
      server.db.sqlite
        .prepare("SELECT crypto_owner_id AS cryptoOwnerId FROM notes WHERE id = ?")
        .get(noteId) as { cryptoOwnerId: string }
    ).cryptoOwnerId;
    const aliceSocket = await connect(server.url, alice.cookie, 0);
    const bobSocket = await connect(server.url, bob.cookie, 0);
    const legacyBobSocket = await connect(server.url, bob.cookie, 0, false);
    await aliceSocket.next("alice connected");
    await aliceSocket.next("alice replay");
    await bobSocket.next("bob connected");
    await bobSocket.next("bob replay");
    await legacyBobSocket.next("legacy bob connected");
    await legacyBobSocket.next("legacy bob replay");
    aliceSocket.socket.send(JSON.stringify({ type: "crdt-subscribe", noteId }));
    bobSocket.socket.send(JSON.stringify({ type: "crdt-subscribe", noteId }));
    expect(await aliceSocket.next("alice CRDT sync")).toEqual({
      type: "crdt-sync",
      noteId,
      keyEpoch: 1,
      hasUpdates: false
    });
    expect(await bobSocket.next("bob CRDT sync")).toEqual({
      type: "crdt-sync",
      noteId,
      keyEpoch: 1,
      hasUpdates: false
    });

    const update = {
      type: "crdt-update",
      formatVersion: 1,
      updateId: crypto.randomUUID(),
      noteId,
      cryptoOwnerId,
      keyEpoch: 1,
      cipher: "encrypted_crdt_update_abcdefghijklmnopqrstuvwxyz",
      nonce: "crdt_update_nonce_abcdefghijklmnopqrstuvwxyz"
    };
    aliceSocket.socket.send(JSON.stringify(update));

    expect(await aliceSocket.next("alice CRDT ack")).toEqual({
      type: "crdt-ack",
      updateId: update.updateId
    });
    expect(await bobSocket.next("bob CRDT update")).toEqual(update);
    await expectNoMessage(legacyBobSocket, "legacy client CRDT update");
    expect(
      server.db.sqlite
        .prepare("SELECT cipher FROM note_updates WHERE update_id = ?")
        .get(update.updateId)
    ).toEqual({ cipher: update.cipher });

    const largeUpdate = {
      ...update,
      updateId: crypto.randomUUID(),
      cipher: "x".repeat(400_001)
    };
    aliceSocket.socket.send(JSON.stringify(largeUpdate));
    expect(await aliceSocket.next("large CRDT ack")).toEqual({
      type: "crdt-ack",
      updateId: largeUpdate.updateId
    });
    expect(await bobSocket.next("large CRDT update")).toEqual(largeUpdate);

    const oversizedUpdate = {
      ...update,
      updateId: crypto.randomUUID(),
      cipher: "x".repeat(1024 * 1024 + 1)
    };
    aliceSocket.socket.send(JSON.stringify(oversizedUpdate));
    expect(await aliceSocket.next("oversized CRDT rejection")).toEqual({
      type: "crdt-reject",
      noteId,
      updateId: oversizedUpdate.updateId,
      reason: "payload-too-large"
    });
    await expectNoMessage(bobSocket, "oversized CRDT broadcast");

    const checkpoint = {
      ...update,
      type: "crdt-checkpoint",
      updateId: crypto.randomUUID(),
      cipher: "encrypted_crdt_checkpoint_abcdefghijklmnopqrstuvwxyz",
      compactedUpdateIds: [update.updateId, largeUpdate.updateId]
    };
    aliceSocket.socket.send(JSON.stringify(checkpoint));

    expect(await aliceSocket.next("alice checkpoint ack")).toEqual({
      type: "crdt-ack",
      updateId: checkpoint.updateId
    });
    expect(await bobSocket.next("bob CRDT checkpoint")).toEqual(checkpoint);
    expect(
      server.db.sqlite
        .prepare("SELECT update_id AS updateId, kind FROM note_updates WHERE note_id = ?")
        .all(noteId)
    ).toEqual([{ updateId: checkpoint.updateId, kind: "checkpoint" }]);
    expect(
      server.db.sqlite.prepare("SELECT COUNT(*) AS count FROM note_events").get()
    ).toEqual({ count: 2 });

    aliceSocket.socket.send(JSON.stringify(checkpoint));
    expect(await aliceSocket.next("alice retry ack")).toEqual({
      type: "crdt-ack",
      updateId: checkpoint.updateId
    });
    await expectNoMessage(bobSocket, "duplicate CRDT checkpoint");

    const epochCheckpoint = {
      ...checkpoint,
      updateId: crypto.randomUUID(),
      compactedUpdateIds: []
    };
    aliceSocket.socket.send(JSON.stringify(epochCheckpoint));
    expect(await aliceSocket.next("alice epoch checkpoint ack")).toEqual({
      type: "crdt-ack",
      updateId: epochCheckpoint.updateId
    });
    expect(await bobSocket.next("bob epoch checkpoint")).toEqual(epochCheckpoint);

    const storedBytes = (
      server.db.sqlite
        .prepare("SELECT COALESCE(SUM(LENGTH(cipher)), 0) AS bytes FROM note_updates WHERE note_id = ?")
        .get(noteId) as { bytes: number }
    ).bytes;
    const byteFillerId = crypto.randomUUID();
    server.db.sqlite.prepare(`
      INSERT INTO note_updates (
        update_id, note_id, crypto_owner_id, key_epoch, format_version,
        cipher, nonce, kind
      ) VALUES (?, ?, ?, 1, 1, ?, 'nonce', 'update')
    `).run(byteFillerId, noteId, cryptoOwnerId, "x".repeat(4 * 1024 * 1024 - storedBytes));
    const byteBlockedUpdate = { ...update, updateId: crypto.randomUUID() };
    aliceSocket.socket.send(JSON.stringify(byteBlockedUpdate));
    expect(await aliceSocket.next("byte-limit CRDT rejection")).toEqual({
      type: "crdt-reject",
      noteId,
      updateId: byteBlockedUpdate.updateId,
      reason: "storage-limit"
    });
    server.db.sqlite.prepare("DELETE FROM note_updates WHERE update_id = ?").run(byteFillerId);

    const fillerIds = Array.from({ length: 126 }, () => crypto.randomUUID());
    const insertFiller = server.db.sqlite.prepare(`
      INSERT INTO note_updates (
        update_id, note_id, crypto_owner_id, key_epoch, format_version,
        cipher, nonce, kind
      ) VALUES (?, ?, ?, 1, 1, 'cipher', 'nonce', 'update')
    `);
    for (const fillerId of fillerIds) {
      insertFiller.run(fillerId, noteId, cryptoOwnerId);
    }
    const blockedUpdate = {
      ...update,
      updateId: crypto.randomUUID(),
      cipher: "storage_limit_update_abcdefghijklmnopqrstuvwxyz"
    };
    aliceSocket.socket.send(JSON.stringify(blockedUpdate));
    expect(await aliceSocket.next("over-limit CRDT rejection")).toEqual({
      type: "crdt-reject",
      noteId,
      updateId: blockedUpdate.updateId,
      reason: "storage-limit"
    });
    await expectNoMessage(bobSocket, "over-limit CRDT broadcast");

    const boundedCheckpoint = {
      ...checkpoint,
      updateId: crypto.randomUUID(),
      compactedUpdateIds: [fillerIds[0]!]
    };
    aliceSocket.socket.send(JSON.stringify(boundedCheckpoint));
    expect(await aliceSocket.next("bounded checkpoint ack")).toEqual({
      type: "crdt-ack",
      updateId: boundedCheckpoint.updateId
    });
    expect(await bobSocket.next("bounded checkpoint broadcast"))
      .toEqual(boundedCheckpoint);
    expect(
      server.db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM note_updates WHERE note_id = ?")
        .get(noteId)
    ).toEqual({ count: 128 });

    const bobClosed = waitForClose(bobSocket.socket);
    const legacyBobClosed = waitForClose(legacyBobSocket.socket);
    await authed(server.url, alice.cookie)
      .delete(`/api/notes/${noteId}/memberships/${bobUserId}`)
      .set(csrfHeaders())
      .expect(204);
    await aliceSocket.next("alice revoke event");
    await expect(bobClosed).resolves.toBe(1008);
    await expect(legacyBobClosed).resolves.toBe(1008);
    server.db.sqlite
      .prepare("UPDATE notes SET key_epoch = 2 WHERE id = ?")
      .run(noteId);

    const postRevokeCheckpoint = {
      type: "crdt-checkpoint",
      formatVersion: 1,
      updateId: crypto.randomUUID(),
      noteId,
      cryptoOwnerId,
      keyEpoch: 2,
      cipher: "encrypted_post_revoke_checkpoint_abcdefghijklmnopqrstuvwxyz",
      nonce: "post_revoke_nonce_abcdefghijklmnopqrstuvwxyz",
      compactedUpdateIds: []
    };
    aliceSocket.socket.send(JSON.stringify(postRevokeCheckpoint));
    expect(await aliceSocket.next("post-revoke CRDT ack")).toEqual({
      type: "crdt-ack",
      updateId: postRevokeCheckpoint.updateId
    });
    expect(
      server.db.sqlite
        .prepare("SELECT key_epoch AS keyEpoch FROM note_updates WHERE note_id = ?")
        .all(noteId)
    ).toEqual([{ keyEpoch: 2 }]);
  });

  it("pushes actor-scoped folder events only to the actor", async () => {
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "ws_folder_alice");
    const bob = await register(server.url, "ws_folder_bob");

    const aliceSocket = await connect(server.url, alice.cookie, 0);
    const bobSocket = await connect(server.url, bob.cookie, 0);
    expect(await aliceSocket.next("alice connected")).toMatchObject({ type: "connected" });
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
      .send({ name: "Realtime folders" })
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

    const currentCursor = (
      server.db.sqlite
        .prepare("SELECT MAX(cursor) AS cursor FROM note_events")
        .get() as { cursor: number }
    ).cursor;
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

    bobSocket.socket.send(
      JSON.stringify({ type: "presence", noteId, state: "editing" })
    );

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

    bobSocket.socket.send(
      JSON.stringify({ type: "presence", noteId, state: "idle" })
    );

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

async function createRealtimeTestServer(
  options: TestServerOptions = {}
): Promise<TestServer> {
  const {
    databasePath = ":memory:",
    historyPageMaxItems,
    ...realtimeOptions
  } = options;
  const config = {
    ...getConfig(),
    port: 0,
    databasePath,
    ...(historyPageMaxItems === undefined ? {} : { historyPageMaxItems })
  };
  const db = createDb(config);
  openDatabases.push(db);
  const realtime = new RealtimeHub(realtimeOptions);
  const context = { config, db, realtime };
  const app = createApp(context);
  const httpServer = createServer(app);
  attachRealtimeServer(context, httpServer, realtime);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, resolve);
  });
  openServers.push(httpServer);
  openHubs.push(realtime);
  const address = httpServer.address() as AddressInfo;
  return {
    context,
    db,
    httpServer,
    realtime,
    url: `http://127.0.0.1:${String(address.port)}`
  };
}

async function stopRealtimeTestServer(server: TestServer): Promise<void> {
  server.realtime.close();
  removeTracked(openHubs, server.realtime);
  await new Promise<void>((resolve, reject) => {
    server.httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  removeTracked(openServers, server.httpServer);
  server.db.sqlite.close();
  removeTracked(openDatabases, server.db);
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
}

function removeTracked<T>(values: T[], value: T): void {
  const index = values.indexOf(value);
  if (index >= 0) {
    values.splice(index, 1);
  }
}

function seedCheckpointManifest(
  db: AppDb,
  input: { noteId: string; sectionId: string; cryptoOwnerId: string }
): string {
  const uploadId = crypto.randomUUID();
  const updateId = crypto.randomUUID();
  const manifestId = crypto.randomUUID();
  db.sqlite
    .prepare(`
      INSERT INTO content_uploads (
        id, update_id, note_id, section_id, crypto_owner_id, key_epoch,
        kind, format_version, total_cipher_bytes, chunk_count, manifest_hash,
        status, expires_at
      ) VALUES (?, ?, ?, ?, ?, 1, 'checkpoint', 2, 6, 1, ?, 'committed', ?)
    `)
    .run(
      uploadId,
      updateId,
      input.noteId,
      input.sectionId,
      input.cryptoOwnerId,
      `hash-${manifestId}`,
      "2099-01-01T00:00:00.000Z"
    );
  db.sqlite
    .prepare(`
      INSERT INTO content_manifests (
        id, upload_id, update_id, note_id, section_id, key_epoch, kind,
        format_version, first_sequence, last_sequence, total_cipher_bytes,
        chunk_count, manifest_hash
      ) VALUES (?, ?, ?, ?, ?, 1, 'checkpoint', 2, 1, 1, 6, 1, ?)
    `)
    .run(
      manifestId,
      uploadId,
      updateId,
      input.noteId,
      input.sectionId,
      `hash-${manifestId}`
    );
  return manifestId;
}

async function register(baseUrl: string, username: string): Promise<{ cookie: string }> {
  const response = await request(baseUrl)
    .post("/api/auth/register")
    .set(csrfHeaders())
    .send(registerPayload(username))
    .expect(201);
  const setCookie = response.headers["set-cookie"] as string[] | undefined;
  return {
    cookie: setCookie?.map((cookie) => cookie.split(";")[0]).join("; ") ?? ""
  };
}

function authed(baseUrl: string, cookie: string) {
  return {
    delete: (path: string) => request(baseUrl).delete(path).set("Cookie", cookie),
    get: (path: string) => request(baseUrl).get(path).set("Cookie", cookie),
    patch: (path: string) => request(baseUrl).patch(path).set("Cookie", cookie),
    post: (path: string) => request(baseUrl).post(path).set("Cookie", cookie),
    put: (path: string) => request(baseUrl).put(path).set("Cookie", cookie)
  };
}

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

function protectedNotePayload(noteId: string, rootSectionId: string) {
  return {
    id: noteId,
    rootSectionId,
    titleCipher: "protected_title_cipher_abcdefghijklmnopqrstuvwxyz",
    titleNonce: "protected_title_nonce_abcdefghijklmnopqrstuvwxyz",
    titleFormatVersion: 2,
    encryptedNoteKey: "protected_note_key_abcdefghijklmnopqrstuvwxyz",
    noteKeyNonce: "protected_note_nonce_abcdefghijklmnopqrstuvwxyz",
    noteKeyFormatVersion: 2
  };
}

function binaryHeader(input: {
  noteId: string;
  sectionId: string;
  cryptoOwnerId: string;
  expectedKeyEpoch?: number;
}): CrdtBinaryHeader {
  return {
    type: "crdt-binary",
    kind: "update",
    formatVersion: CRDT_BINARY_FORMAT_VERSION,
    updateId: crypto.randomUUID(),
    noteId: input.noteId,
    sectionId: input.sectionId,
    cryptoOwnerId: input.cryptoOwnerId,
    expectedKeyEpoch: input.expectedKeyEpoch ?? 1,
    nonce: toBase64(crypto.getRandomValues(new Uint8Array(24))),
    cipherLength: 6
  };
}

async function connectBinary(baseUrl: string, cookie: string): Promise<BinarySocketClient> {
  const socket = new WebSocket(
    `${baseUrl.replace(/^http/, "ws")}/api/realtime?after=0&capabilities=crdt-binary-v2`,
    { headers: { Cookie: cookie, Origin: TEST_ALLOWED_ORIGIN } }
  );
  const messages: { data: RawData; isBinary: boolean }[] = [];
  const waiters: ((message: { data: RawData; isBinary: boolean }) => void)[] = [];
  socket.on("message", (data, isBinary) => {
    const message = { data, isBinary };
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      messages.push(message);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  openSockets.push(socket);

  async function nextPayload(label: string) {
    const queued = messages.shift();
    if (queued) {
      return queued;
    }
    return new Promise<{ data: RawData; isBinary: boolean }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for websocket message: ${label}`));
      }, 2_000);
      waiters.push((message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
  }

  return {
    socket,
    nextBinary: async (label) => {
      const payload = await nextPayload(label);
      if (!payload.isBinary) {
        throw new Error(`Expected binary websocket message: ${label}`);
      }
      return rawDataToBytes(payload.data);
    },
    nextJson: async (label) => {
      const payload = await nextPayload(label);
      if (payload.isBinary) {
        throw new Error(`Expected JSON websocket message: ${label}`);
      }
      return parseSocketMessage(payload.data);
    }
  };
}

async function connect(
  baseUrl: string,
  cookie: string,
  after: number,
  crdt = true
): Promise<SocketClient> {
  const capabilities = crdt ? "&capabilities=crdt-v1" : "";
  const socket = new WebSocket(
    `${baseUrl.replace(/^http/, "ws")}/api/realtime?after=${String(after)}${capabilities}`,
    { headers: { Cookie: cookie, Origin: TEST_ALLOWED_ORIGIN } }
  );
  const messages: Record<string, unknown>[] = [];
  const waiters: ((message: Record<string, unknown>) => void)[] = [];
  socket.on("message", (data) => {
    const message = parseSocketMessage(data);
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    messages.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  openSockets.push(socket);
  return {
    socket,
    next: (label) => nextMessage(messages, waiters, label)
  };
}

async function connectRejected(
  url: string,
  headers: Record<string, string> = {}
): Promise<string> {
  const socket = new WebSocket(url.replace(/^http/, "ws"), { headers });
  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      reject(new Error("Expected connection to be rejected"));
    });
    socket.once("error", (error) => {
      resolve(error.message);
    });
  });
}

async function nextMessage(
  messages: Record<string, unknown>[],
  waiters: ((message: Record<string, unknown>) => void)[],
  label: string
): Promise<Record<string, unknown>> {
  const message = messages.shift();
  if (message) {
    return message;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for websocket message: ${label}`));
    }, 2000);
    waiters.push((message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
}

async function expectNoMessage(socket: SocketClient, label: string): Promise<void> {
  await expect(
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, 100);
      socket.socket.once("message", (data) => {
        clearTimeout(timeout);
        const message = parseSocketMessage(data);
        reject(new Error(`Unexpected websocket message: ${JSON.stringify(message)}`));
      });
    }).catch((error: unknown) => {
      throw error instanceof Error
        ? new Error(`${label}: ${error.message}`)
        : new Error(label);
    })
  ).resolves.toBeUndefined();
}

function parseSocketMessage(data: RawData): Record<string, unknown> {
  const raw =
    typeof data === "string"
      ? data
      : data instanceof Buffer
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : data instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(data)).toString("utf8")
            : Buffer.from(data).toString("utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function rawDataToBytes(data: RawData): Uint8Array {
  if (data instanceof Buffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for websocket close"));
    }, 2000);
    socket.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}
