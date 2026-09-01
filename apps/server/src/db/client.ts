import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ServerConfig } from "../config.js";
import { removeOrphanedEncryptedAttachments } from "../attachments/storage.js";
import * as schema from "./schema.js";
import { runMigrations } from "./migrations.js";

export function createDb(config: ServerConfig) {
  fs.mkdirSync(path.dirname(config.database.path), { recursive: true });
  const sqlite = new Database(config.database.path);
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  const orm = drizzle(sqlite, { schema });
  removeOrphanedEncryptedAttachments(
    config,
    new Set(
      orm
        .select({ fileCipherPath: schema.attachments.fileCipherPath })
        .from(schema.attachments)
        .all()
        .map(({ fileCipherPath }) => fileCipherPath)
    )
  );
  return {
    sqlite,
    orm,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
    sessionAbsoluteTimeoutMs: config.sessionAbsoluteTimeoutMs
  };
}

export type AppDb = ReturnType<typeof createDb>;
