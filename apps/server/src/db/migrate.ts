import { getConfig } from "../config.js";
import { logError } from "../observability/log.js";
import { createDatabaseResources } from "./client.js";

async function main(): Promise<void> {
  const resources = await createDatabaseResources(getConfig().database);
  await resources.close();
}

void main().catch((error: unknown) => {
  logError("database.migrations.failed", {}, error);
  process.exitCode = 1;
});
