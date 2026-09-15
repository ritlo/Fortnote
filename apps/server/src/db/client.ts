import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
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
import { SqliteSharingKeyRepository } from "../sharingKeys/repository.js";
import { SqliteNoteQueryRepository } from "../notes/queryRepository.js";
import { SqliteNoteMembershipRepository } from "../notes/membershipRepository.js";
import { SqliteNoteRotationRepository } from "../notes/rotationRepository.js";
import { SqliteNoteMutationRepository } from "../notes/mutationRepository.js";
import { SqliteNoteSectionRepository } from "../notes/sectionRepository.js";
import { SqliteSectionHistoryRepository } from "../realtime/history.js";
import { SqliteLegacyHistoryRepository } from "../realtime/legacyHistory.js";
import { LocalContentStorage, type ContentStorage } from "../content/storage.js";
import { SqliteContentUploadRepository } from "../content/uploadRepository.js";
import { SqliteContentManifestRepository } from "../content/manifestRepository.js";
import { SqliteContentMaintenanceRepository } from "../content/maintenanceRepository.js";
import type { ApplicationDatabase } from "./types.js";
import * as schema from "./schema.js";
import { runMigrations } from "./migrations.js";

export function createDb(config: ServerConfig): AppDb {
  if (config.database.provider !== "sqlite") {
    throw new Error("createDb requires SQLite configuration");
  }
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
  const sharingKeys = new SqliteSharingKeyRepository(orm);
  const noteQueries = new SqliteNoteQueryRepository(orm);
  const noteMemberships = new SqliteNoteMembershipRepository(orm);
  const noteRotations = new SqliteNoteRotationRepository(orm);
  const noteMutations = new SqliteNoteMutationRepository(orm);
  const noteSections = new SqliteNoteSectionRepository(orm);
  const sectionHistory = new SqliteSectionHistoryRepository(orm);
  const legacyHistory = new SqliteLegacyHistoryRepository(orm);
  const contentStorage: ContentStorage = new LocalContentStorage(config);
  const contentUploads = new SqliteContentUploadRepository(orm);
  const contentManifests = new SqliteContentManifestRepository(orm);
  const contentMaintenance = new SqliteContentMaintenanceRepository(orm);
  return {
    provider: "sqlite",
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
    sharingKeys,
    noteQueries,
    noteMemberships,
    noteRotations,
    noteMutations,
    noteSections,
    sectionHistory,
    legacyHistory,
    contentStorage,
    contentUploads,
    contentManifests,
    contentMaintenance,
    checkReady() {
      sqlite.prepare("SELECT 1").get();
      return Promise.resolve();
    },
    close() {
      sqlite.close();
      return Promise.resolve();
    }
  };
}

export interface AppDb extends ApplicationDatabase {
  readonly provider: "sqlite";
  readonly sqlite: InstanceType<typeof Database>;
  readonly orm: BetterSQLite3Database<typeof schema>;
}
