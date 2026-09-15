import { randomUUID } from "node:crypto";
import { Pool, types } from "pg";
import { onTestFinished } from "vitest";
import { getConfig, type ServerConfig } from "@server/config.js";
import type { ApplicationDatabase } from "@server/db/types.js";

/** Matches `pnpm test:db:start`; CI points this at its PostgreSQL service instead. */
export const TEST_DATABASE_URL =
  process.env.FORTNOTE_POSTGRES_TEST_URL ??
  "postgresql://fortnote:fortnote-test@127.0.0.1:55432/fortnote";

export interface TestDatabaseConfig {
  database: ServerConfig["database"];
  dispose(): Promise<void>;
}

/**
 * Creates a fresh database for one test so tests that reuse usernames or counts
 * cannot see each other. The application migrates it when it opens.
 */
export async function createTestDatabaseConfig(): Promise<TestDatabaseConfig> {
  const name = `fortnote_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await adminQuery(`CREATE DATABASE ${name}`);
  } catch (error) {
    const target = new URL(TEST_DATABASE_URL);
    throw new Error(
      `Test PostgreSQL is unavailable at ${target.host}; run \`pnpm test:db:start\` or set FORTNOTE_POSTGRES_TEST_URL`,
      { cause: error }
    );
  }
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return {
    database: getConfig({ DATABASE_URL: url.toString(), DATABASE_MAX_CONNECTIONS: "3" })
      .database,
    dispose: () => adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
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

// Assertion rows use numbers for 64-bit integers and numerics, 0/1 for booleans,
// and text for timestamps, which keeps expected values compact.
const INT8_OID = 20;
const BOOL_OID = 16;
const NUMERIC_OID = 1700;
const TEMPORAL_OIDS = new Set([1082, 1114, 1184]);
const assertionRowTypes = {
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

/** Runs assertion SQL with `?` placeholders against a test database. */
export function testSql(database: unknown): TestSql {
  const { pool } = database as ApplicationDatabase;
  const query = async (sql: string, params: unknown[]) => {
    let index = 0;
    // PostgreSQL folds unquoted aliases to lowercase; quote camelCase ones.
    const text = sql
      .replace(/\bAS\s+([a-z]+[A-Z]\w*)/gu, 'AS "$1"')
      .replace(/\?/gu, () => `$${String(++index)}`);
    return pool.query({ text, values: params, types: assertionRowTypes });
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
  await (database as ApplicationDatabase).pool.query(`
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
async function adminQuery(text: string): Promise<void> {
  const maintenanceUrl = new URL(TEST_DATABASE_URL);
  maintenanceUrl.pathname = "/postgres";
  const pool = new Pool({ connectionString: maintenanceUrl.toString(), max: 1 });
  try {
    await pool.query(text);
  } finally {
    await pool.end();
  }
}
