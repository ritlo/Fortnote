import { createPostgresResources } from "./client.js";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required");
}

const maxConnections = Number(process.env.DATABASE_MAX_CONNECTIONS ?? "10");
if (!Number.isSafeInteger(maxConnections) || maxConnections <= 0) {
  throw new Error("Invalid DATABASE_MAX_CONNECTIONS");
}

const resources = await createPostgresResources({
  provider: "postgres",
  url,
  maxConnections
});
await resources.close();
console.log("PostgreSQL migrations applied");
