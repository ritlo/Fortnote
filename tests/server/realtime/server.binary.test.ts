import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cryptoReady,
  decodeCrdtBinaryFrame,
  encodeCrdtBinaryFrame
} from "@fortnote/shared";
import { csrfHeaders } from "../support/http.js";
import {
  authed,
  binaryHeader,
  cleanupRealtimeTests,
  closeSocket,
  connectBinary,
  createRealtimeTestServer,
  expectNoMessage,
  protectedNotePayload,
  register,
  seedCheckpointManifest,
  stopRealtimeTestServer,
  temporaryDirectories
} from "./realtime.fixtures.js";

afterEach(cleanupRealtimeTests);

describe("realtime binary sections", () => {
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
    server.db.sqlite
      .prepare(`
        UPDATE notes
        SET content_cipher = 'legacy-cipher', content_nonce = 'legacy-nonce',
            content_length = 42
        WHERE id = ?
      `)
      .run(noteId);
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

  it("broadcasts a relayed binary update back to its originating tab", async () => {
    await cryptoReady();
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "relay_alice");
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
    const tabA = crypto.randomUUID();
    const tabB = crypto.randomUUID();
    const origin = await connectBinary(server.url, alice.cookie, tabA);
    const relay = await connectBinary(server.url, alice.cookie, tabB);
    await origin.nextJson("origin connected");
    await origin.nextJson("origin replay");
    await relay.nextJson("relay connected");
    await relay.nextJson("relay replay");
    for (const [socket, label] of [
      [origin, "origin"],
      [relay, "relay"]
    ] as const) {
      socket.socket.send(JSON.stringify({
        type: "crdt-subscribe",
        requestId: crypto.randomUUID(),
        noteId,
        sectionId,
        expectedKeyEpoch: 1,
        afterSequence: 0
      }));
      await socket.nextJson(`${label} history`);
    }

    const cipher = Uint8Array.from([9, 8, 7, 6, 5, 4]);
    const header = binaryHeader({
      noteId,
      sectionId,
      cryptoOwnerId,
      originClientId: tabA
    });
    relay.socket.send(encodeCrdtBinaryFrame(header, cipher, 256 * 1024));
    expect(decodeCrdtBinaryFrame(await origin.nextBinary("origin relay"), 256 * 1024))
      .toEqual({ header: { ...header, serverSequence: 1 }, cipher });
    expect(decodeCrdtBinaryFrame(await relay.nextBinary("relay echo"), 256 * 1024))
      .toEqual({ header: { ...header, serverSequence: 1 }, cipher });
    expect(await relay.nextJson("relay ack")).toMatchObject({
      type: "crdt-ack",
      updateId: header.updateId,
      result: "inserted"
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

  it("stops section broadcasts after unsubscribe and permits a fresh resubscribe", async () => {
    await cryptoReady();
    const server = await createRealtimeTestServer();
    const alice = await register(server.url, "unsubscribe_alice");
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
    const writer = await connectBinary(server.url, alice.cookie);
    const reader = await connectBinary(server.url, alice.cookie);
    await writer.nextJson("unsubscribe writer connected");
    await writer.nextJson("unsubscribe writer replay");
    await reader.nextJson("unsubscribe reader connected");
    await reader.nextJson("unsubscribe reader replay");

    reader.socket.send(JSON.stringify({
      type: "crdt-subscribe",
      requestId: crypto.randomUUID(),
      noteId,
      sectionId,
      expectedKeyEpoch: 1,
      afterSequence: 0
    }));
    await reader.nextJson("unsubscribe initial history");
    reader.socket.send(JSON.stringify({
      type: "crdt-unsubscribe",
      noteId,
      sectionId,
      expectedKeyEpoch: 1
    }));
    expect(await reader.nextJson("unsubscribe confirmation")).toEqual({
      type: "crdt-unsubscribed",
      noteId,
      sectionId,
      keyEpoch: 1
    });

    const cipher = Uint8Array.from([1, 3, 3, 7, 0, 0]);
    const header = binaryHeader({ noteId, sectionId, cryptoOwnerId });
    writer.socket.send(encodeCrdtBinaryFrame(header, cipher, 256 * 1024));
    await writer.nextJson("unsubscribe writer ack");
    await expectNoMessage(reader, "unsubscribed section broadcast");

    reader.socket.send(JSON.stringify({
      type: "crdt-subscribe",
      requestId: crypto.randomUUID(),
      noteId,
      sectionId,
      expectedKeyEpoch: 1,
      afterSequence: 0
    }));
    expect(
      decodeCrdtBinaryFrame(
        await reader.nextBinary("resubscribed section update"),
        256 * 1024
      )
    ).toEqual({ header: { ...header, serverSequence: 1 }, cipher });
    expect(await reader.nextJson("resubscribed section history")).toMatchObject({
      type: "crdt-history-page",
      nextSequence: 1
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

    expect(await server.context.db.noteSections.initialize({
      ...initialization,
      expectedRootVersion: 2
    })).toEqual({ status: "rejected", code: "stale-version" });
    expect(await server.context.db.noteSections.initialize(initialization)).toMatchObject({
      status: "installed",
      manifestId: winnerManifestId
    });
    expect(await server.context.db.noteSections.initialize({
      ...initialization,
      manifestId: losingManifestId
    })).toMatchObject({
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
    expect(
      server.db.sqlite
        .prepare(`
          SELECT content_cipher AS contentCipher, content_nonce AS contentNonce,
                 content_length AS contentLength
          FROM notes WHERE id = ?
        `)
        .get(noteId)
    ).toEqual({ contentCipher: "", contentNonce: "", contentLength: 0 });
  });
});
