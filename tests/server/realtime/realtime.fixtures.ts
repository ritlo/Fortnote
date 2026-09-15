import { createServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import request from "supertest";
import WebSocket, { type RawData } from "ws";
import { expect } from "vitest";
import {
  CRDT_BINARY_FORMAT_VERSION,
  toBase64,
  type CrdtBinaryHeader
} from "@fortnote/shared";
import { getConfig, type ServerConfig } from "@server/config.js";
import { createApplicationDatabase } from "@server/db/client.js";
import type { ApplicationDatabase } from "@server/db/types.js";
import { createApp, type AppContext } from "@server/http/app.js";
import { RealtimeHub } from "@server/realtime/hub.js";
import { attachRealtimeServer } from "@server/realtime/server.js";
import { csrfHeaders, registerPayload } from "../support/http.js";
import {
  createTestDatabaseConfig,
  testSql,
  trackTestDatabase,
  type TestDatabaseConfig
} from "../support/database.js";

interface TestServer {
  context: AppContext;
  db: ApplicationDatabase;
  httpServer: Server;
  realtime: RealtimeHub;
  url: string;
}

interface TestServerOptions {
  /** A shared database to reopen; the caller disposes it. */
  database?: TestDatabaseConfig;
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
const openDatabases: ApplicationDatabase[] = [];
export const temporaryDirectories: string[] = [];
const TEST_ALLOWED_ORIGIN = "http://localhost:5173";

export async function cleanupRealtimeTests(): Promise<void> {
  for (const socket of openSockets.splice(0)) {
    socket.close();
  }
  await Promise.all(openHubs.splice(0).map((hub) => hub.close()));
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
  await Promise.all(openDatabases.splice(0).map((db) => db.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
}

export async function createRealtimeTestServer(
  options: TestServerOptions = {}
): Promise<TestServer> {
  const { database, historyPageMaxItems, ...realtimeOptions } = options;
  const testDatabase = database ?? (await createTestDatabaseConfig());
  const config: ServerConfig = {
    ...getConfig(),
    port: 0,
    database: testDatabase.database,
    ...(historyPageMaxItems === undefined ? {} : { historyPageMaxItems })
  };
  const db = trackTestDatabase(
    await createApplicationDatabase(config),
    database ? null : testDatabase
  );
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

export async function stopRealtimeTestServer(server: TestServer): Promise<void> {
  await server.realtime.close();
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
  await server.db.close();
  removeTracked(openDatabases, server.db);
}

export function closeSocket(socket: WebSocket): Promise<void> {
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

export async function seedCheckpointManifest(
  db: ApplicationDatabase,
  input: { noteId: string; sectionId: string; cryptoOwnerId: string }
): Promise<string> {
  const uploadId = crypto.randomUUID();
  const updateId = crypto.randomUUID();
  const manifestId = crypto.randomUUID();
  await testSql(db).run(
    `
      INSERT INTO content_uploads (
        id, update_id, note_id, section_id, crypto_owner_id, key_epoch,
        kind, format_version, total_cipher_bytes, chunk_count, manifest_hash,
        status, expires_at
      ) VALUES (?, ?, ?, ?, ?, 1, 'checkpoint', 2, 6, 1, ?, 'committed', ?)
    `,
    uploadId,
    updateId,
    input.noteId,
    input.sectionId,
    input.cryptoOwnerId,
    `hash-${manifestId}`,
    "2099-01-01T00:00:00.000Z"
  );
  await testSql(db).run(
    `
      INSERT INTO content_manifests (
        id, upload_id, update_id, note_id, section_id, key_epoch, kind,
        format_version, first_sequence, last_sequence, total_cipher_bytes,
        chunk_count, manifest_hash
      ) VALUES (?, ?, ?, ?, ?, 1, 'checkpoint', 2, 1, 1, 6, 1, ?)
    `,
    manifestId,
    uploadId,
    updateId,
    input.noteId,
    input.sectionId,
    `hash-${manifestId}`
  );
  return manifestId;
}

export async function register(
  baseUrl: string,
  username: string
): Promise<{ cookie: string }> {
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

export function authed(baseUrl: string, cookie: string) {
  return {
    delete: (path: string) => request(baseUrl).delete(path).set("Cookie", cookie),
    get: (path: string) => request(baseUrl).get(path).set("Cookie", cookie),
    patch: (path: string) => request(baseUrl).patch(path).set("Cookie", cookie),
    post: (path: string) => request(baseUrl).post(path).set("Cookie", cookie),
    put: (path: string) => request(baseUrl).put(path).set("Cookie", cookie)
  };
}

export function sharingKeyPayload(username: string) {
  return {
    sharingKeyVersion: 1,
    publicKey: `public_sharing_key_${username}_abcdefghijklmnopqrstuvwxyz`,
    encryptedPrivateKey: `encrypted_private_key_${username}_abcdefghijklmnopqrstuvwxyz`,
    privateKeyNonce: `private_key_nonce_${username}_abcdefghijklmnopqrstuvwxyz`,
    formatVersion: 1
  };
}

export function invitePayload(username: string, role: "editor" | "viewer") {
  return {
    username,
    role,
    sharingKeyVersion: 1,
    encryptedNoteKey: `encrypted_share_for_${username}_abcdefghijklmnopqrstuvwxyz`,
    formatVersion: 1
  };
}

export function protectedNotePayload(noteId: string, rootSectionId: string) {
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

export function binaryHeader(input: {
  noteId: string;
  sectionId: string;
  cryptoOwnerId: string;
  expectedKeyEpoch?: number;
  originClientId?: string;
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
    cipherLength: 6,
    ...(input.originClientId === undefined
      ? {}
      : { originClientId: input.originClientId })
  };
}

export async function connectBinary(
  baseUrl: string,
  cookie: string,
  clientId?: string
): Promise<BinarySocketClient> {
  const clientQuery =
    clientId === undefined ? "" : `&clientId=${encodeURIComponent(clientId)}`;
  const socket = new WebSocket(
    `${baseUrl.replace(/^http/, "ws")}/api/realtime?after=0&capabilities=crdt-binary-v2${clientQuery}`,
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

export async function connect(
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

export async function connectRejected(
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

export async function expectNoMessage(
  socket: Pick<SocketClient, "socket">,
  label: string
): Promise<void> {
  await expect(
    new Promise<void>((resolve, reject) => {
      const onMessage = (data: RawData, isBinary: boolean) => {
        clearTimeout(timeout);
        const message = isBinary
          ? "binary websocket frame"
          : JSON.stringify(parseSocketMessage(data));
        reject(new Error(`Unexpected websocket message: ${message}`));
      };
      const timeout = setTimeout(() => {
        socket.socket.off("message", onMessage);
        resolve();
      }, 100);
      socket.socket.once("message", onMessage);
    }).catch((error: unknown) => {
      throw error instanceof Error
        ? new Error(`${label}: ${error.message}`)
        : new Error(label);
    })
  ).resolves.toBeUndefined();
}

export function parseSocketMessage(data: RawData): Record<string, unknown> {
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

export function waitForClose(socket: WebSocket): Promise<number> {
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
