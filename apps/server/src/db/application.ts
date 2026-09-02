import type { ServerConfig } from "../config.js";
import { createDb } from "./client.js";
import { createPostgresDatabase } from "./postgres/client.js";
import type { ApplicationDatabase } from "./types.js";

export function createApplicationDatabase(
  config: ServerConfig
): Promise<ApplicationDatabase> {
  return config.database.provider === "postgres"
    ? createPostgresDatabase(config)
    : Promise.resolve(createDb(config));
}
