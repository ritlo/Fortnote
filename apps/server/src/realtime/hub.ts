import { WebSocket } from "ws";
import type { AppContext } from "../http/app.js";
import { listVisibleEvents } from "../events/replay.js";
import type { RealtimePublisher } from "./types.js";

interface RealtimeClient {
  userId: string;
  socket: WebSocket;
}

export class RealtimeHub implements RealtimePublisher {
  private readonly clients = new Set<RealtimeClient>();
  private context: AppContext | null = null;

  attachContext(context: AppContext): void {
    this.context = context;
  }

  addClient(userId: string, socket: WebSocket): void {
    const client = { userId, socket };
    this.clients.add(client);
    socket.on("close", () => {
      this.clients.delete(client);
    });
  }

  publishEvents(cursors: number[]): void {
    if (!this.context || cursors.length === 0) {
      return;
    }

    for (const cursor of cursors) {
      for (const client of this.clients) {
        const [event] = listVisibleEvents(this.context, client.userId, cursor - 1, 1);
        if (event?.cursor !== cursor) {
          continue;
        }
        sendJson(client.socket, { type: "event", event });
      }
    }
  }
}

export function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(value));
}
