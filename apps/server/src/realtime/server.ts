import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { z } from "zod";
import { CRDT_REALTIME_CAPABILITY } from "@fortnote/shared";
import {
  findSession,
  readSessionToken,
  type SessionRecord
} from "../auth/session.js";
import { listVisibleEvents } from "../events/replay.js";
import { allowedOriginAliases } from "../http/csrf.js";
import type { AppContext } from "../http/app.js";
import { RealtimeHub, sendJson, type RealtimeClient } from "./hub.js";

const realtimeQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  capabilities: z.string().default("")
});

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("presence"),
    noteId: z.uuid(),
    state: z.enum(["idle", "editing", "left"])
  }),
  z.object({
    type: z.literal("crdt-subscribe"),
    noteId: z.uuid()
  }),
  z.object({
    type: z.literal("crdt-update"),
    formatVersion: z.literal(1),
    updateId: z.uuid(),
    noteId: z.uuid(),
    cryptoOwnerId: z.uuid(),
    keyEpoch: z.number().int().positive(),
    cipher: z.string().min(1).max(400_000),
    nonce: z.string().min(16).max(128)
  }),
  z.object({
    type: z.literal("crdt-checkpoint"),
    formatVersion: z.literal(1),
    updateId: z.uuid(),
    noteId: z.uuid(),
    cryptoOwnerId: z.uuid(),
    keyEpoch: z.number().int().positive(),
    cipher: z.string().min(1).max(400_000),
    nonce: z.string().min(16).max(128),
    compactedUpdateIds: z.array(z.uuid()).max(100)
      .refine((ids) => new Set(ids).size === ids.length)
  }).refine((message) => !message.compactedUpdateIds.includes(message.updateId))
]);

const MAX_REALTIME_MESSAGE_BYTES = 512 * 1024;

export function attachRealtimeServer(
  context: AppContext,
  server: Server,
  hub: RealtimeHub
): WebSocketServer {
  hub.attachContext(context);
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_REALTIME_MESSAGE_BYTES
  });
  const allowedOrigins = allowedOriginAliases(context.config.allowedOrigin);

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/realtime") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const session = findSession(
      context.db,
      readSessionToken(request.headers.cookie)
    );
    if (!session) {
      rejectUpgrade(socket);
      return;
    }
    if (!originAllowed(request.headers.origin, allowedOrigins)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    const parsed = realtimeQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries())
    );
    const after = parsed.success ? parsed.data.after : 0;
    const capabilities = new Set(
      parsed.success
        ? parsed.data.capabilities
            .split(",")
            .filter((capability) => capability === CRDT_REALTIME_CAPABILITY)
        : []
    );

    webSocketServer.handleUpgrade(request, socket, head, (socket) => {
      connectClient(context, hub, socket, session, after, capabilities);
    });
  });

  return webSocketServer;
}

function originAllowed(origin: string | undefined, allowedOrigins: Set<string>): boolean {
  return Boolean(origin && allowedOrigins.has(origin));
}

function connectClient(
  context: AppContext,
  hub: RealtimeHub,
  socket: WebSocket,
  session: SessionRecord,
  after: number,
  capabilities: Set<string>
): void {
  const client = hub.addClient({
    sessionId: session.id,
    userId: session.userId,
    username: session.username,
    socket,
    capabilities
  });
  socket.on("message", (message) => {
    handleClientMessage(hub, client, socket, message);
  });

  sendJson(socket, {
    type: "connected",
    userId: session.userId,
    username: session.username,
    protocolVersion: 2,
    capabilities: [CRDT_REALTIME_CAPABILITY]
  });
  sendJson(socket, {
    type: "replay",
    events: listVisibleEvents(context, session.userId, after, 500)
  });
}

function handleClientMessage(
  hub: RealtimeHub,
  client: RealtimeClient,
  socket: WebSocket,
  message: RawData
): void {
  const raw = rawDataToString(message);
  if (raw === "ping") {
    sendJson(socket, { type: "pong" });
    return;
  }

  const parsed = parseClientMessage(raw);
  if (!parsed) {
    return;
  }
  if (parsed.type === "presence") {
    hub.updatePresence(client, parsed.noteId, parsed.state);
  } else if (parsed.type === "crdt-subscribe") {
    hub.subscribeCrdt(client, parsed.noteId);
  } else {
    const outcome = hub.publishCrdtUpdate(client, parsed);
    if (outcome === "accepted") {
      sendJson(socket, { type: "crdt-ack", updateId: parsed.updateId });
    } else if (outcome === "storage-limit") {
      sendJson(socket, {
        type: "crdt-reject",
        noteId: parsed.noteId,
        updateId: parsed.updateId,
        reason: "storage-limit"
      });
    } else {
      sendJson(socket, {
        type: "crdt-reject",
        noteId: parsed.noteId,
        updateId: parsed.updateId,
        reason: "forbidden"
      });
    }
  }
}

function parseClientMessage(raw: string): z.infer<typeof clientMessageSchema> | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const parsed = clientMessageSchema.safeParse(parsedJson);
  return parsed.success ? parsed.data : null;
}

function rawDataToString(message: RawData): string {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof Buffer) {
    return message.toString("utf8");
  }
  if (Array.isArray(message)) {
    return Buffer.concat(message).toString("utf8");
  }
  if (message instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(message)).toString("utf8");
  }
  return Buffer.from(message).toString("utf8");
}

function rejectUpgrade(socket: Duplex, status = 401, reason = "Unauthorized"): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
