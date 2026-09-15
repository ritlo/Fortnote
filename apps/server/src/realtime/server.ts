import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { z } from "zod";
import {
  CRDT_REALTIME_CAPABILITY_V2,
  decodeCrdtBinaryFrame,
  parseCrdtControlMessage
} from "@fortnote/shared";
import { readSessionToken, type SessionRecord } from "../auth/session.js";
import { allowedOriginAliases } from "../http/csrf.js";
import type { AppContext } from "../http/app.js";
import { RealtimeHub, sendJson, type RealtimeClient } from "./hub.js";

const MAX_REALTIME_MESSAGE_BYTES = 2 * 1024 * 1024;

const realtimeQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  capabilities: z.string().default(""),
  clientId: z.uuid().optional()
});

const presenceMessageSchema = z.object({
  type: z.literal("presence"),
  noteId: z.uuid(),
  state: z.enum(["idle", "editing", "left"])
});

export function attachRealtimeServer(
  context: AppContext,
  server: Server,
  hub: RealtimeHub
): WebSocketServer {
  hub.attachContext(context);
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(
      MAX_REALTIME_MESSAGE_BYTES,
      context.config.realtimeFrameMaxBytes * 2
    )
  });
  const allowedOrigins = allowedOriginAliases(context.config.allowedOrigin);

  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head).catch((error: unknown) => {
      console.error("Unable to authenticate realtime connection", error);
      rejectUpgrade(socket, 500, "Internal Server Error");
    });
  });

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/realtime") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const session = await context.db.sessions.find(
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
    const crdtV2Enabled =
      parsed.success &&
      parsed.data.capabilities.split(",").includes(CRDT_REALTIME_CAPABILITY_V2);

    webSocketServer.handleUpgrade(request, socket, head, (socket) => {
      connectClient(
        context,
        hub,
        socket,
        session,
        after,
        crdtV2Enabled,
        parsed.success ? parsed.data.clientId : undefined
      );
    });
  }

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
  crdtV2Enabled: boolean,
  clientInstanceId?: string
): void {
  const client = hub.addClient({
    sessionId: session.id,
    userId: session.userId,
    username: session.username,
    socket,
    crdtV2Enabled,
    ...(clientInstanceId === undefined ? {} : { clientInstanceId })
  });
  let messageQueue = Promise.resolve();
  socket.on("message", (message, isBinary) => {
    messageQueue = messageQueue
      .then(() => handleClientMessage(context, hub, client, socket, message, isBinary))
      .catch((error: unknown) => {
        console.error("Unable to process realtime message", error);
        socket.close(1011, "Unable to process realtime message");
      });
  });

  sendJson(socket, {
    type: "connected",
    userId: session.userId,
    username: session.username,
    capabilities: crdtV2Enabled ? [CRDT_REALTIME_CAPABILITY_V2] : []
  });
  void context.db.events
    .listVisible(session.userId, after, 500)
    .then((events) => {
      sendJson(socket, { type: "replay", events });
    })
    .catch((error: unknown) => {
      console.error("Unable to replay collaboration events", error);
      socket.close(1011, "Unable to replay events");
    });
}

async function handleClientMessage(
  context: AppContext,
  hub: RealtimeHub,
  client: RealtimeClient,
  socket: WebSocket,
  message: RawData,
  isBinary: boolean
): Promise<void> {
  if (isBinary) {
    await handleBinaryMessage(context, hub, client, socket, message);
    return;
  }
  const raw = rawDataToString(message);
  if (raw === "ping") {
    sendJson(socket, { type: "pong" });
    return;
  }

  const control = parseCrdtControl(raw);
  if (control) {
    if (control.type === "crdt-subscribe") {
      await hub.subscribeCrdtV2(client, control);
    } else {
      hub.unsubscribeCrdtV2(client, control);
    }
    return;
  }
  const presence = parsePresenceMessage(raw);
  if (presence) {
    await hub.updatePresence(client, presence.noteId, presence.state);
  }
}

async function handleBinaryMessage(
  context: AppContext,
  hub: RealtimeHub,
  client: RealtimeClient,
  socket: WebSocket,
  message: RawData
): Promise<void> {
  let decoded: ReturnType<typeof decodeCrdtBinaryFrame>;
  try {
    decoded = decodeCrdtBinaryFrame(
      rawDataToBytes(message),
      Math.max(context.config.jsonControlMaxBytes, context.config.realtimeFrameMaxBytes)
    );
  } catch {
    return;
  }
  if (rawDataByteLength(message) > context.config.realtimeFrameMaxBytes) {
    sendJson(socket, {
      type: "crdt-reject",
      updateId: decoded.header.updateId,
      sectionId: decoded.header.sectionId,
      code: "frame-too-large"
    });
    return;
  }
  const outcome = await hub.publishCrdtBinary(client, decoded.header, decoded.cipher);
  if (outcome.status === "rejected") {
    sendJson(socket, {
      type: "crdt-reject",
      updateId: decoded.header.updateId,
      sectionId: decoded.header.sectionId,
      code: outcome.code
    });
    return;
  }
  sendJson(socket, {
    type: "crdt-ack",
    updateId: decoded.header.updateId,
    sectionId: decoded.header.sectionId,
    result: outcome.status,
    keyEpoch: decoded.header.expectedKeyEpoch,
    serverSequence: outcome.serverSequence
  });
}

function parseCrdtControl(raw: string) {
  try {
    const parsed = parseCrdtControlMessage(JSON.parse(raw) as unknown);
    return parsed.type === "crdt-subscribe" || parsed.type === "crdt-unsubscribe"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parsePresenceMessage(raw: string): z.infer<typeof presenceMessageSchema> | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const parsed = presenceMessageSchema.safeParse(parsedJson);
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

function rawDataToBytes(message: RawData): Uint8Array {
  if (message instanceof Buffer) {
    return new Uint8Array(message);
  }
  if (Array.isArray(message)) {
    return new Uint8Array(Buffer.concat(message));
  }
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

function rawDataByteLength(message: RawData): number {
  if (typeof message === "string") {
    return Buffer.byteLength(message);
  }
  if (Array.isArray(message)) {
    return message.reduce((total, part) => total + part.byteLength, 0);
  }
  return message.byteLength;
}

function rejectUpgrade(socket: Duplex, status = 401, reason = "Unauthorized"): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
