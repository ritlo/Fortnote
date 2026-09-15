import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig } from "@server/config.js";

const DATABASE_URL = "postgresql://localhost/fortnote";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("server configuration", () => {
  it("loads safe defaults when no configuration file exists", () => {
    const cwd = temporaryDirectory();
    const config = getConfig({ DATABASE_URL }, { cwd });

    expect(config).toEqual({
      port: 3001,
      host: "0.0.0.0",
      database: {
        url: DATABASE_URL,
        maxConnections: 10,
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        lockTimeoutMs: 5_000,
        startupRetryAttempts: 10,
        startupRetryDelayMs: 1_000
      },
      cookieSecure: true,
      allowedOrigin: "http://localhost:5173",
      webRoot: null,
      jsonControlMaxBytes: 1024 * 1024,
      realtimeFrameMaxBytes: 256 * 1024,
      contentChunkMaxBytes: 256 * 1024,
      storageQuotaBytes: 10 * 1024 * 1024 * 1024,
      maintenanceBatchSize: 100,
      contentUploadExpiryMs: 24 * 60 * 60 * 1000,
      sessionIdleTimeoutMs: 30 * 60 * 1000,
      sessionAbsoluteTimeoutMs: 24 * 60 * 60 * 1000,
      authIpRateLimitMaxAttempts: 60,
      authAccountRateLimitMaxAttempts: 20,
      historyPageMaxItems: 128,
      historyPageMaxBytes: 4 * 1024 * 1024
    });
  });

  it("loads config.yaml and resolves the web root relative to it", () => {
    const cwd = temporaryDirectory();
    writeFileSync(
      path.join(cwd, "config.yaml"),
      `
server:
  port: 4100
  host: 127.0.0.1
  cookieSecure: false
  allowedOrigin: http://127.0.0.1:5173
  webRoot: public
database:
  url: postgresql://yaml-user:yaml-password@localhost:5432/fortnote
  maxConnections: 8
  connectionTimeoutMs: 6000
  statementTimeoutMs: 31000
  lockTimeoutMs: 7000
  startupRetryAttempts: 12
  startupRetryDelayMs: 1500
storage:
  quotaBytes: 2048
  maintenanceBatchSize: 25
  uploadExpiryMs: 3600000
limits:
  jsonControlMaxBytes: 524288
  realtimeFrameMaxBytes: 65536
  contentChunkMaxBytes: 131072
  historyPageMaxItems: 64
  historyPageMaxBytes: 2097152
sessions:
  idleTimeoutMs: 60000
  absoluteTimeoutMs: 7200000
auth:
  ipRateLimitMaxAttempts: 120
  accountRateLimitMaxAttempts: 40
`
    );

    expect(getConfig({}, { cwd })).toEqual({
      port: 4100,
      host: "127.0.0.1",
      database: {
        url: "postgresql://yaml-user:yaml-password@localhost:5432/fortnote",
        maxConnections: 8,
        connectionTimeoutMs: 6000,
        statementTimeoutMs: 31000,
        lockTimeoutMs: 7000,
        startupRetryAttempts: 12,
        startupRetryDelayMs: 1500
      },
      cookieSecure: false,
      allowedOrigin: "http://127.0.0.1:5173",
      webRoot: path.join(cwd, "public"),
      jsonControlMaxBytes: 524288,
      realtimeFrameMaxBytes: 65536,
      contentChunkMaxBytes: 131072,
      storageQuotaBytes: 2048,
      maintenanceBatchSize: 25,
      contentUploadExpiryMs: 3600000,
      sessionIdleTimeoutMs: 60000,
      sessionAbsoluteTimeoutMs: 7200000,
      authIpRateLimitMaxAttempts: 120,
      authAccountRateLimitMaxAttempts: 40,
      historyPageMaxItems: 64,
      historyPageMaxBytes: 2097152
    });
  });

  it("finds the root configuration from a nested working directory", () => {
    const cwd = temporaryDirectory();
    const nested = path.join(cwd, "apps/server");
    writeFileSync(
      path.join(cwd, "config.yaml"),
      `server:\n  port: 4300\ndatabase:\n  url: ${DATABASE_URL}\n`
    );
    mkdirSync(nested, { recursive: true });

    expect(getConfig({}, { cwd: nested }).port).toBe(4300);
  });

  it("applies environment overrides after YAML values", () => {
    const cwd = temporaryDirectory();
    writeFileSync(
      path.join(cwd, "settings.yaml"),
      `
server:
  port: 4100
database:
  url: postgresql://yaml-user@localhost/fortnote
  maxConnections: 8
storage:
  quotaBytes: 2048
`
    );

    const config = getConfig(
      {
        FORTNOTE_CONFIG: "settings.yaml",
        PORT: "4200",
        DATABASE_URL: "postgres://environment-user:secret@database:5432/fortnote",
        DATABASE_MAX_CONNECTIONS: "16",
        DATABASE_CONNECTION_TIMEOUT_MS: "7000",
        DATABASE_STATEMENT_TIMEOUT_MS: "32000",
        DATABASE_LOCK_TIMEOUT_MS: "8000",
        DATABASE_STARTUP_RETRY_ATTEMPTS: "14",
        DATABASE_STARTUP_RETRY_DELAY_MS: "2000",
        STORAGE_QUOTA_BYTES: "4096",
        WEB_ROOT: "web"
      },
      { cwd }
    );

    expect(config.port).toBe(4200);
    expect(config.database).toEqual({
      url: "postgres://environment-user:secret@database:5432/fortnote",
      maxConnections: 16,
      connectionTimeoutMs: 7000,
      statementTimeoutMs: 32000,
      lockTimeoutMs: 8000,
      startupRetryAttempts: 14,
      startupRetryDelayMs: 2000
    });
    expect(config.storageQuotaBytes).toBe(4096);
    expect(config.webRoot).toBe(path.join(cwd, "web"));
  });

  it("requires a valid PostgreSQL URL", () => {
    const cwd = temporaryDirectory();

    expect(() => getConfig({}, { cwd })).toThrow(
      /DATABASE_URL or database.url is required/iu
    );
    expect(() =>
      getConfig({ DATABASE_URL: "mysql://localhost/fortnote" }, { cwd })
    ).toThrow("Invalid DATABASE_URL");
    expect(() => getConfig({ DATABASE_URL: "not a url" }, { cwd })).toThrow(
      "Invalid DATABASE_URL"
    );
  });

  it("rejects removed SQLite and local storage settings", () => {
    const cwd = temporaryDirectory();
    writeFileSync(
      path.join(cwd, "config.yaml"),
      "database:\n  provider: sqlite\n  path: data/fortnote.sqlite\n"
    );
    expect(() => getConfig({ DATABASE_URL }, { cwd })).toThrow(/Invalid configuration/iu);

    writeFileSync(path.join(cwd, "config.yaml"), "localstorage:\n  dataDir: data\n");
    expect(() => getConfig({ DATABASE_URL }, { cwd })).toThrow(/Invalid configuration/iu);
  });

  it("rejects malformed YAML and unknown settings", () => {
    const cwd = temporaryDirectory();
    writeFileSync(path.join(cwd, "config.yaml"), "unknownSetting: true\n");

    expect(() => getConfig({ DATABASE_URL }, { cwd })).toThrow(/Invalid configuration/iu);

    writeFileSync(path.join(cwd, "config.yaml"), "server: [\n");
    expect(() => getConfig({ DATABASE_URL }, { cwd })).toThrow(/Could not parse/iu);
  });

  it("rejects a missing explicitly selected configuration file", () => {
    const cwd = temporaryDirectory();

    expect(() =>
      getConfig({ DATABASE_URL, FORTNOTE_CONFIG: "missing.yaml" }, { cwd })
    ).toThrow(/Configuration file not found/iu);
  });

  it.each([
    ["CONTENT_CHUNK_MAX_BYTES", "0"],
    ["CONTENT_UPLOAD_EXPIRY_MS", "NaN"],
    ["AUTH_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS", "0"],
    ["AUTH_IP_RATE_LIMIT_MAX_ATTEMPTS", "1.5"],
    ["MAINTENANCE_BATCH_SIZE", "1.5"],
    ["REALTIME_FRAME_MAX_BYTES", "-1"],
    ["SESSION_ABSOLUTE_TIMEOUT_MS", "0"],
    ["STORAGE_QUOTA_BYTES", "9007199254740992"],
    ["DATABASE_MAX_CONNECTIONS", "0"],
    ["DATABASE_CONNECTION_TIMEOUT_MS", "0"],
    ["DATABASE_LOCK_TIMEOUT_MS", "-1"],
    ["DATABASE_STARTUP_RETRY_ATTEMPTS", "1.5"],
    ["DATABASE_STARTUP_RETRY_DELAY_MS", "0"],
    ["DATABASE_STATEMENT_TIMEOUT_MS", "NaN"]
  ])("rejects unsafe %s values", (name, value) => {
    const cwd = temporaryDirectory();
    expect(() => getConfig({ DATABASE_URL, [name]: value }, { cwd })).toThrow(
      `Invalid ${name}`
    );
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fortnote-config-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
