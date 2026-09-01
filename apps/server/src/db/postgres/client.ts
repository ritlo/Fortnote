import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { PostgresAttachmentStorage } from "../../attachments/postgresStorage.js";
import type { PostgresDatabaseConfig } from "../../config.js";
import * as schema from "./schema.js";

export interface PostgresResources {
  pool: Pool;
  orm: ReturnType<typeof createPostgresOrm>;
  attachmentStorage: PostgresAttachmentStorage;
  close(): Promise<void>;
}

export async function createPostgresResources(
  config: PostgresDatabaseConfig,
  options: { cwd?: string; migrationsDirectory?: string } = {}
): Promise<PostgresResources> {
  const pool = new Pool({
    connectionString: config.url,
    max: config.maxConnections
  });
  const orm = createPostgresOrm(pool);

  try {
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
