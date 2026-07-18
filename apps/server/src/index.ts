import { createServer } from "node:http";
import { getConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createApp } from "./http/app.js";
import {
  runContentStartupMaintenance,
  startContentMaintenance
} from "./content/maintenance.js";
import { RealtimeHub } from "./realtime/hub.js";
import { attachRealtimeServer } from "./realtime/server.js";

const config = getConfig();
const db = createDb(config);
const realtime = new RealtimeHub();
const context = { config, db, realtime };
const app = createApp(context);
const server = createServer(app);
attachRealtimeServer(context, server, realtime);

void runContentStartupMaintenance(context)
  .then(() => {
    const maintenance = startContentMaintenance(context);
    server.once("close", () => {
      void maintenance.stop();
    });
    server.listen(config.port, config.host, () => {
      console.log(`Fortnote API listening on ${config.host}:${String(config.port)}`);
    });
  })
  .catch((error: unknown) => {
    console.error("Fortnote startup maintenance failed", error);
    process.exitCode = 1;
  });
