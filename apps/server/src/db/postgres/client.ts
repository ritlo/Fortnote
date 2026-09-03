import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { PostgresAttachmentMetadataRepository } from "../../attachments/postgresMetadataRepository.js";
import { PostgresAttachmentMutationRepository } from "../../attachments/postgresMutationRepository.js";
import { PostgresAttachmentStorage } from "../../attachments/postgresStorage.js";
import { PostgresAccountRepository } from "../../auth/postgresAccountRepository.js";
import { PostgresSessionRepository } from "../../auth/postgresSessionRepository.js";
import type { PostgresDatabaseConfig, ServerConfig } from "../../config.js";
import { PostgresContentMaintenanceRepository } from "../../content/postgresMaintenanceRepository.js";
import { PostgresContentManifestRepository } from "../../content/postgresManifestRepository.js";
import { PostgresContentUploadRepository } from "../../content/postgresUploadRepository.js";
import { AttachmentBackedContentStorage } from "../../content/storage.js";
import { PostgresEventReplayRepository } from "../../events/postgresReplayRepository.js";
import { PostgresFolderRepository } from "../../folders/postgresRepository.js";
import { PostgresNoteLifecycleRepository } from "../../notes/postgresLifecycleRepository.js";
import { PostgresNoteMembershipRepository } from "../../notes/postgresMembershipRepository.js";
import { PostgresNoteMutationRepository } from "../../notes/postgresMutationRepository.js";
import { PostgresNoteAccessRepository } from "../../notes/postgresNoteAccessRepository.js";
import { PostgresNoteQueryRepository } from "../../notes/postgresQueryRepository.js";
import { PostgresNoteRotationRepository } from "../../notes/postgresRotationRepository.js";
import { PostgresNoteSectionRepository } from "../../notes/postgresSectionRepository.js";
import { PostgresSectionHistoryRepository } from "../../realtime/postgresHistory.js";
import { PostgresLegacyHistoryRepository } from "../../realtime/postgresLegacyHistory.js";
import { PostgresSharingKeyRepository } from "../../sharingKeys/postgresRepository.js";
import type { ApplicationDatabase } from "../types.js";
import * as schema from "./schema.js";

export interface PostgresResources {
  pool: Pool;
  orm: ReturnType<typeof createPostgresOrm>;
  attachmentStorage: PostgresAttachmentStorage;
  close(): Promise<void>;
}

export interface PostgresApplicationDatabase extends ApplicationDatabase {
  readonly provider: "postgres";
  readonly pool: Pool;
  readonly orm: ReturnType<typeof createPostgresOrm>;
}

export async function createPostgresResources(
  config: PostgresDatabaseConfig,
  options: { cwd?: string; migrationsDirectory?: string } = {}
): Promise<PostgresResources> {
  const pool = new Pool({
    connectionString: config.url,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    lock_timeout: config.lockTimeoutMs
  });
  const orm = createPostgresOrm(pool);

  try {
    await waitForPostgres(
      pool,
      config.startupRetryAttempts,
      config.startupRetryDelayMs
    );
    await migrate(orm, {
      migrationsFolder:
        options.migrationsDirectory ??
        findPostgresMigrationsDirectory(options.cwd ?? process.cwd())
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

export async function createPostgresDatabase(
  config: ServerConfig
): Promise<PostgresApplicationDatabase> {
  if (config.database.provider !== "postgres") {
    throw new Error("createPostgresDatabase requires PostgreSQL configuration");
  }
  const resources = await createPostgresResources(config.database);
  const { orm, attachmentStorage } = resources;
  try {
    const contentStorage = new AttachmentBackedContentStorage(attachmentStorage);
    return {
      provider: "postgres",
      pool: resources.pool,
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
      legacyHistory: new PostgresLegacyHistoryRepository(orm),
      contentStorage,
      contentUploads: new PostgresContentUploadRepository(orm),
      contentManifests: new PostgresContentManifestRepository(orm),
      contentMaintenance: new PostgresContentMaintenanceRepository(orm),
      checkReady: async () => {
        await resources.pool.query("SELECT 1");
      },
      close: () => resources.close()
    };
  } catch (error) {
    await resources.close();
    throw error;
  }
}

export function findPostgresMigrationsDirectory(startDirectory: string): string {
  let directory = path.resolve(startDirectory);
  for (;;) {
    const candidate = path.join(directory, "drizzle/postgres");
    if (fs.existsSync(path.join(candidate, "meta/_journal.json"))) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("PostgreSQL migrations directory not found");
    }
    directory = parent;
  }
}

function createPostgresOrm(pool: Pool) {
  return drizzle({ client: pool, schema });
}

async function waitForPostgres(
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
    { cause: lastError }
  );
}
