import { createServer } from "node:http";
import { getConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createApp } from "./http/app.js";
import { RealtimeHub } from "./realtime/hub.js";
import { attachRealtimeServer } from "./realtime/server.js";

const config = getConfig();
const db = createDb(config);
const realtime = new RealtimeHub();
const app = createApp({ config, db, realtime });
const server = createServer(app);
attachRealtimeServer({ config, db, realtime }, server, realtime);

server.listen(config.port, config.host, () => {
  console.log(`Fortnote API listening on ${config.host}:${String(config.port)}`);
});
