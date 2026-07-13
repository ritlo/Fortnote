import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ServerConfig } from "../config.js";
import { removeOrphanedEncryptedAttachments } from "../attachments/storage.js";
import * as schema from "./schema.js";
import { runMigrations } from "./migrations.js";

export function createDb(config: ServerConfig) {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const sqlite = new Database(config.databasePath);
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  removeOrphanedEncryptedAttachments(
    config,
    new Set(
      sqlite.prepare("SELECT file_cipher_path FROM attachments").pluck().all() as string[]
    )
  );
  return {
    sqlite,
    orm: drizzle(sqlite, { schema })
  };
}

export type AppDb = ReturnType<typeof createDb>;
