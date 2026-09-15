import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { PostgresAttachmentMetadataRepository } from "../attachments/postgresMetadataRepository.js";
import { PostgresAttachmentMutationRepository } from "../attachments/postgresMutationRepository.js";
import { PostgresAttachmentStorage } from "../attachments/postgresStorage.js";
import { PostgresAccountRepository } from "../auth/postgresAccountRepository.js";
import { PostgresSessionRepository } from "../auth/postgresSessionRepository.js";
import type { DatabaseConfig, ServerConfig } from "../config.js";
import { PostgresContentMaintenanceRepository } from "../content/postgresMaintenanceRepository.js";
import { PostgresContentManifestRepository } from "../content/postgresManifestRepository.js";
import { PostgresContentUploadRepository } from "../content/postgresUploadRepository.js";
import { AttachmentBackedContentStorage } from "../content/storage.js";
import { PostgresEventReplayRepository } from "../events/postgresReplayRepository.js";
import { PostgresFolderRepository } from "../folders/postgresRepository.js";
import { PostgresNoteLifecycleRepository } from "../notes/postgresLifecycleRepository.js";
import { PostgresNoteMembershipRepository } from "../notes/postgresMembershipRepository.js";
import { PostgresNoteMutationRepository } from "../notes/postgresMutationRepository.js";
import { PostgresNoteAccessRepository } from "../notes/postgresNoteAccessRepository.js";
import { PostgresNoteQueryRepository } from "../notes/postgresQueryRepository.js";
import { PostgresNoteRotationRepository } from "../notes/postgresRotationRepository.js";
import { PostgresNoteSectionRepository } from "../notes/postgresSectionRepository.js";
import { PostgresSectionHistoryRepository } from "../realtime/postgresHistory.js";
import { PostgresSharingKeyRepository } from "../sharingKeys/postgresRepository.js";
import { logInfo } from "../observability/log.js";
import type { ApplicationDatabase, Database } from "./types.js";
import * as schema from "./schema.js";

export interface DatabaseResources {
  pool: Pool;
  orm: Database;
  attachmentStorage: PostgresAttachmentStorage;
  close(): Promise<void>;
}

/** Connects, applies migrations, and removes stale unreferenced attachment objects. */
export async function createDatabaseResources(
  config: DatabaseConfig,
  options: { cwd?: string; migrationsDirectory?: string } = {}
): Promise<DatabaseResources> {
  const pool = new Pool({
    connectionString: config.url,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    lock_timeout: config.lockTimeoutMs
  });
  const orm = drizzle({ client: pool, schema });

  try {
    await waitForDatabase(pool, config.startupRetryAttempts, config.startupRetryDelayMs);
    const migrationsStartedAt = performance.now();
    await migrate(orm, {
      migrationsFolder:
        options.migrationsDirectory ??
        findMigrationsDirectory(options.cwd ?? process.cwd())
    });
    logInfo("database.migrations.completed", {
      durationMs: Math.max(0, Math.round(performance.now() - migrationsStartedAt))
    });
    const attachmentStorage = new PostgresAttachmentStorage(orm);
    await attachmentStorage.removeOrphans();
    return {
      pool,
      orm,
      attachmentStorage,
      close: () => pool.end()
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export async function createApplicationDatabase(
  config: ServerConfig
): Promise<ApplicationDatabase> {
  const resources = await createDatabaseResources(config.database);
  const { pool, orm, attachmentStorage } = resources;
  return {
    pool,
    orm,
    attachmentStorage,
    sessions: new PostgresSessionRepository(
      orm,
      config.sessionIdleTimeoutMs,
      config.sessionAbsoluteTimeoutMs
    ),
    noteAccess: new PostgresNoteAccessRepository(orm),
    attachmentMetadata: new PostgresAttachmentMetadataRepository(orm),
    attachmentMutations: new PostgresAttachmentMutationRepository(orm),
    noteLifecycle: new PostgresNoteLifecycleRepository(orm),
    folders: new PostgresFolderRepository(orm),
    events: new PostgresEventReplayRepository(orm),
    accounts: new PostgresAccountRepository(
      orm,
      config.sessionIdleTimeoutMs,
      config.sessionAbsoluteTimeoutMs
    ),
    sharingKeys: new PostgresSharingKeyRepository(orm),
    noteQueries: new PostgresNoteQueryRepository(orm),
    noteMemberships: new PostgresNoteMembershipRepository(orm),
    noteRotations: new PostgresNoteRotationRepository(orm),
    noteMutations: new PostgresNoteMutationRepository(orm),
    noteSections: new PostgresNoteSectionRepository(orm),
    sectionHistory: new PostgresSectionHistoryRepository(orm),
    contentStorage: new AttachmentBackedContentStorage(attachmentStorage),
    contentUploads: new PostgresContentUploadRepository(orm),
    contentManifests: new PostgresContentManifestRepository(orm),
    contentMaintenance: new PostgresContentMaintenanceRepository(orm),
    checkReady: async () => {
      await pool.query("SELECT 1");
    },
    close: () => resources.close()
  };
}

export function findMigrationsDirectory(startDirectory: string): string {
  let directory = path.resolve(startDirectory);
  for (;;) {
    const candidate = path.join(directory, "drizzle");
    if (fs.existsSync(path.join(candidate, "meta/_journal.json"))) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("Database migrations directory not found");
    }
    directory = parent;
  }
}

async function waitForDatabase(
  pool: Pool,
  attempts: number,
  retryDelayMs: number
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw new Error(
    `PostgreSQL unavailable after ${String(attempts)} connection attempts`,
    {
      cause: lastError
    }
  );
}
