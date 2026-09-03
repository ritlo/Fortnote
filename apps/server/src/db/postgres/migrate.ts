import { getConfig } from "../../config.js";
import { logError } from "../../observability/log.js";
import { createPostgresResources } from "./client.js";

async function main(): Promise<void> {
  const config = getConfig({
    ...process.env,
    DATABASE_PROVIDER: "postgres"
  });
  if (config.database.provider !== "postgres") {
    throw new Error("PostgreSQL migration configuration could not be loaded");
  }
  const resources = await createPostgresResources(config.database);
  await resources.close();
}

void main().catch((error: unknown) => {
  logError("database.migrations.failed", { provider: "postgres" }, error);
  process.exitCode = 1;
});
