import { createServer, type Server } from "node:http";
import type { WebSocketServer } from "ws";
import { getConfig } from "./config.js";
import {
  runContentStartupMaintenance,
  startContentMaintenance,
  type ContentMaintenanceHandle
} from "./content/maintenance.js";
import { createApplicationDatabase } from "./db/application.js";
import type { ApplicationDatabase } from "./db/types.js";
import { createApp } from "./http/app.js";
import { logError, logInfo } from "./observability/log.js";
import { RealtimeHub } from "./realtime/hub.js";
import { attachRealtimeServer } from "./realtime/server.js";

async function main(): Promise<void> {
  const startupStartedAt = performance.now();
  const config = getConfig();
  const db = await createApplicationDatabase(config);
  const realtime = new RealtimeHub();
  const context = { config, db, realtime };
  const server = createServer(createApp(context));
  const webSocketServer = attachRealtimeServer(context, server, realtime);
  let maintenance: ContentMaintenanceHandle | null = null;

  try {
    const maintenanceStartedAt = performance.now();
    await runContentStartupMaintenance(context);
    logInfo("maintenance.startup.completed", {
      durationMs: elapsedMilliseconds(maintenanceStartedAt),
      provider: db.provider
    });
    maintenance = startContentMaintenance(context);
    await listen(server, config.port, config.host);
  } catch (error) {
    await closeResources({ db, maintenance, realtime, server, webSocketServer });
    throw error;
  }

  logInfo("server.started", {
    durationMs: elapsedMilliseconds(startupStartedAt),
    host: config.host,
    port: config.port,
    provider: db.provider
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: NodeJS.Signals) => {
    logInfo("server.shutdown.requested", { signal });
    shutdownPromise ??= closeResources({
      db,
      maintenance,
      realtime,
      server,
      webSocketServer
    });
    void shutdownPromise.then(
      () => {
        logInfo("server.shutdown.completed", { signal });
      },
      (error: unknown) => {
        logError("server.shutdown.failed", { signal }, error);
        process.exitCode = 1;
      }
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeResources(input: {
  db: ApplicationDatabase;
  maintenance: ContentMaintenanceHandle | null;
  realtime: RealtimeHub;
  server: Server;
  webSocketServer: WebSocketServer;
}): Promise<void> {
  try {
    await input.maintenance?.stop();
  } finally {
    try {
      await Promise.all([
        input.realtime.close(),
        closeHttpServer(input.server),
        closeWebSocketServer(input.webSocketServer)
      ]);
    } finally {
      await input.db.close();
    }
  }
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

void main().catch((error: unknown) => {
  logError("server.startup.failed", {}, error);
  process.exitCode = 1;
});
