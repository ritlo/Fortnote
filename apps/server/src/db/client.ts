import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ServerConfig } from "../config.js";
import {
  LocalAttachmentStorage,
  type AttachmentStorage
} from "../attachments/storage.js";
import { SqliteAttachmentMetadataRepository } from "../attachments/metadataRepository.js";
import { SqliteAttachmentMutationRepository } from "../attachments/mutationRepository.js";
import { SqliteSessionRepository } from "../auth/sessionRepository.js";
import { SqliteNoteAccessRepository } from "../notes/noteAccessRepository.js";
import { SqliteNoteLifecycleRepository } from "../notes/lifecycleRepository.js";
import { SqliteFolderRepository } from "../folders/repository.js";
import { SqliteEventReplayRepository } from "../events/replay.js";
import { SqliteAccountRepository } from "../auth/accountRepository.js";
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
  const sessions = new SqliteSessionRepository(
    orm,
    config.sessionIdleTimeoutMs,
    config.sessionAbsoluteTimeoutMs
  );
  const noteAccess = new SqliteNoteAccessRepository(orm);
  const attachmentMetadata = new SqliteAttachmentMetadataRepository(orm);
  const attachmentMutations = new SqliteAttachmentMutationRepository(orm);
  const noteLifecycle = new SqliteNoteLifecycleRepository(orm);
  const folders = new SqliteFolderRepository(orm);
  const events = new SqliteEventReplayRepository(orm);
  const accounts = new SqliteAccountRepository(
    orm,
    config.sessionIdleTimeoutMs,
    config.sessionAbsoluteTimeoutMs
  );
  return {
    sqlite,
    orm,
    attachmentStorage,
    sessions,
    noteAccess,
    attachmentMetadata,
    attachmentMutations,
    noteLifecycle,
    folders,
    events,
    accounts,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
    sessionAbsoluteTimeoutMs: config.sessionAbsoluteTimeoutMs
  };
}

export type AppDb = ReturnType<typeof createDb>;
