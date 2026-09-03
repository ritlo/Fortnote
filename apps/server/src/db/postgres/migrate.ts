import { getConfig } from "../../config.js";
import { createPostgresResources } from "./client.js";

const config = getConfig({
  ...process.env,
  DATABASE_PROVIDER: "postgres"
});
if (config.database.provider !== "postgres") {
  throw new Error("PostgreSQL migration configuration could not be loaded");
}

const resources = await createPostgresResources(config.database);
await resources.close();
console.log("PostgreSQL migrations applied");
