import { getConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createApp } from "./http/app.js";

const config = getConfig();
const db = createDb(config);
const app = createApp({ config, db });

app.listen(config.port, () => {
  console.log(`Fortnote API listening on ${String(config.port)}`);
});
