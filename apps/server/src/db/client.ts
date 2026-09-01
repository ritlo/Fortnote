import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ServerConfig } from "../config.js";
import {
  LocalAttachmentStorage,
  type AttachmentStorage
} from "../attachments/storage.js";
import * as schema from "./schema.js";
import { runMigrations } from "./migrations.js";

export function createDb(config: ServerConfig) {
  fs.mkdirSync(path.dirname(config.database.path), { recursive: true });
  const sqlite = new Database(config.database.path);
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  const orm = drizzle(sqlite, { schema });
  const localAttachmentStorage = new LocalAttachmentStorage(config.dataDir);
  localAttachmentStorage.removeOrphans(
    new Set(
      orm
        .select({ storageKey: schema.attachments.storageKey })
        .from(schema.attachments)
        .all()
        .map(({ storageKey }) => storageKey)
    )
  );
  const attachmentStorage: AttachmentStorage = localAttachmentStorage;
  return {
    sqlite,
    orm,
    attachmentStorage,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
    sessionAbsoluteTimeoutMs: config.sessionAbsoluteTimeoutMs
  };
}

export type AppDb = ReturnType<typeof createDb>;
