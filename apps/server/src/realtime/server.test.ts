import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import WebSocket, { type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig } from "../config.js";
import { createDb, type AppDb } from "../db/client.js";
import { createApp } from "../http/app.js";
import {
  csrfHeaders,
  notePayload,
  registerPayload
} from "../test/http.js";
import { RealtimeHub } from "./hub.js";
import { attachRealtimeServer } from "./server.js";

interface TestServer {
  db: AppDb;
  url: string;
}

interface TestServerOptions {
  presenceSweepIntervalMs?: number;
  presenceTtlMs?: number;
}

interface SocketClient {
  socket: WebSocket;
  next: (label: string) => Promise<Record<string, unknown>>;
}

const openServers: Server[] = [];
const openSockets: WebSocket[] = [];
const openHubs: RealtimeHub[] = [];

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
});

describe("realtime server", () => {
  it("rejects unauthenticated websocket connections", async () => {
    const server = await createRealtimeTestServer();

    await expect(connectRejected(`${server.url}/api/realtime`)).resolves.toMatch(
      /401/
    );
  });

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
  const config = { ...getConfig(), port: 0, databasePath: ":memory:" };
  const db = createDb(config);
  const realtime = new RealtimeHub(options);
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
    db,
    url: `http://127.0.0.1:${String(address.port)}`
  };
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

async function connect(
  baseUrl: string,
  cookie: string,
  after: number
): Promise<SocketClient> {
  const socket = new WebSocket(
    `${baseUrl.replace(/^http/, "ws")}/api/realtime?after=${String(after)}`,
    { headers: { Cookie: cookie } }
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

async function connectRejected(url: string): Promise<string> {
  const socket = new WebSocket(url.replace(/^http/, "ws"));
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
