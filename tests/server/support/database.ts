import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, types } from "pg";
import { onTestFinished } from "vitest";
import { getConfig, type ServerConfig } from "@server/config.js";
import type { AppDb } from "@server/db/client.js";
import type { PostgresApplicationDatabase } from "@server/db/postgres/client.js";
import type { ApplicationDatabase } from "@server/db/types.js";

export const testDatabaseProvider: ApplicationDatabase["provider"] =
  process.env.FORTNOTE_TEST_DATABASE_PROVIDER === "postgres" ? "postgres" : "sqlite";

export interface TestDatabaseConfig {
  database: ServerConfig["database"];
  dispose(): Promise<void>;
}

/**
 * Creates an isolated database for one test. PostgreSQL gets a fresh database
 * per call so tests that reuse usernames or counts cannot see each other.
 */
export async function createTestDatabaseConfig(
  options: { persistent?: boolean } = {}
): Promise<TestDatabaseConfig> {
  if (testDatabaseProvider === "sqlite") {
    if (!options.persistent) {
      return {
        database: { provider: "sqlite", path: ":memory:" },
        dispose: () => Promise.resolve()
      };
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fortnote-test-db-"));
    return {
      database: { provider: "sqlite", path: path.join(directory, "fortnote.sqlite") },
      dispose: () => fs.promises.rm(directory, { recursive: true, force: true })
    };
  }

  const adminUrl = process.env.FORTNOTE_POSTGRES_TEST_URL;
  if (!adminUrl) {
    throw new Error(
      "FORTNOTE_POSTGRES_TEST_URL is required when FORTNOTE_TEST_DATABASE_PROVIDER=postgres"
    );
  }
  const name = `fortnote_test_${randomUUID().replaceAll("-", "")}`;
  await adminQuery(adminUrl, `CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    database: getConfig({
      DATABASE_PROVIDER: "postgres",
      DATABASE_URL: url.toString(),
      DATABASE_MAX_CONNECTIONS: "3"
    }).database,
    dispose: () => adminQuery(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  };
}

/**
 * Makes close idempotent, disposes an owned test database after closing, and
 * closes automatically when the current test finishes.
 */
export function trackTestDatabase<T extends ApplicationDatabase>(
  database: T,
  owned: TestDatabaseConfig | null
): T {
  let closing: Promise<void> | null = null;
  const tracked = {
    ...database,
    close: () =>
      (closing ??= (async () => {
        await database.close();
        await owned?.dispose();
      })())
  } as T;
  onTestFinished(() => tracked.close());
  return tracked;
}

export interface TestSql {
  get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<void>;
}

// PostgreSQL rows are shaped like SQLite rows: 64-bit integers and numerics as
// numbers, booleans as 0/1, so assertions are identical for both providers.
const INT8_OID = 20;
const BOOL_OID = 16;
const NUMERIC_OID = 1700;
// date, timestamp, timestamptz: keep text like SQLite and the drizzle string mode.
const TEMPORAL_OIDS = new Set([1082, 1114, 1184]);
const sqliteShapedTypes = {
  getTypeParser(oid: number, format?: "text" | "binary"): (value: string) => unknown {
    if (oid === INT8_OID || oid === NUMERIC_OID) {
      return (value: string) => Number(value);
    }
    if (oid === BOOL_OID) {
      return (value: string) => (value === "t" ? 1 : 0);
    }
    if (TEMPORAL_OIDS.has(oid)) {
      return (value: string) => value;
    }
    return types.getTypeParser(oid, format) as (value: string) => unknown;
  }
};

/** Runs portable SQL with `?` placeholders against either provider. */
export function testSql(database: unknown): TestSql {
  const application = database as ApplicationDatabase;
  if (application.provider === "sqlite") {
    const sqlite = (application as AppDb).sqlite;
    return {
      get: <T>(sql: string, ...params: unknown[]) =>
        Promise.resolve(sqlite.prepare(sql).get(...(params as never[])) as T | undefined),
      all: <T>(sql: string, ...params: unknown[]) =>
        Promise.resolve(sqlite.prepare(sql).all(...(params as never[])) as T[]),
      run: (sql: string, ...params: unknown[]) => {
        sqlite.prepare(sql).run(...(params as never[]));
        return Promise.resolve();
      }
    };
  }
  const { pool } = application as PostgresApplicationDatabase;
  const query = async (sql: string, params: unknown[]) => {
    let index = 0;
    // PostgreSQL folds unquoted aliases to lowercase; quote camelCase ones.
    const text = sql
      .replace(/\bAS\s+([a-z]+[A-Z]\w*)/gu, 'AS "$1"')
      .replace(/\?/gu, () => `$${String(++index)}`);
    return pool.query({ text, values: params, types: sqliteShapedTypes });
  };
  return {
    get: async <T>(sql: string, ...params: unknown[]) =>
      (await query(sql, params)).rows[0] as T | undefined,
    all: async <T>(sql: string, ...params: unknown[]) =>
      (await query(sql, params)).rows as T[],
    run: async (sql: string, ...params: unknown[]) => {
      await query(sql, params);
    }
  };
}

/** Installs a trigger that makes every note event insert fail. */
export async function failNoteEventWrites(database: unknown): Promise<void> {
  const application = database as ApplicationDatabase;
  if (application.provider === "sqlite") {
    (application as AppDb).sqlite.exec(`
      CREATE TRIGGER fail_note_events_insert
      BEFORE INSERT ON note_events
      BEGIN
        SELECT RAISE(ABORT, 'note event failure');
      END;
    `);
    return;
  }
  await (application as PostgresApplicationDatabase).pool.query(`
    CREATE FUNCTION fail_note_events_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'note event failure';
    END;
    $$;
    CREATE TRIGGER fail_note_events_insert
    BEFORE INSERT ON note_events
    FOR EACH ROW EXECUTE FUNCTION fail_note_events_insert();
  `);
}

// Create and drop test databases from the maintenance database so setup never
// appears as activity on the shared database that runtime tests inspect.
async function adminQuery(url: string, text: string): Promise<void> {
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = "/postgres";
  const pool = new Pool({ connectionString: maintenanceUrl.toString(), max: 1 });
  try {
    await pool.query(text);
  } finally {
    await pool.end();
  }
}
