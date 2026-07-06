import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { z } from "zod";
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
  after: z.coerce.number().int().nonnegative().default(0)
});

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("presence"),
    noteId: z.uuid(),
    state: z.enum(["idle", "editing", "left"])
  })
]);

export function attachRealtimeServer(
  context: AppContext,
  server: Server,
  hub: RealtimeHub
): WebSocketServer {
  hub.attachContext(context);
  const webSocketServer = new WebSocketServer({ noServer: true });
  const allowedOrigins = allowedOriginAliases(context.config.allowedOrigin);

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/realtime") {
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

    webSocketServer.handleUpgrade(request, socket, head, (socket) => {
      connectClient(context, hub, socket, session, after);
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
  after: number
): void {
  const client = hub.addClient({
    userId: session.userId,
    username: session.username,
    socket
  });
  socket.on("message", (message) => {
    handleClientMessage(hub, client, socket, message);
  });

  sendJson(socket, {
    type: "connected",
    userId: session.userId,
    username: session.username
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
  hub.updatePresence(client, parsed.noteId, parsed.state);
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
