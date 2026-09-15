import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_SQLITE_PATH = "data/fortnote.sqlite";
const DEFAULT_POSTGRES_MAX_CONNECTIONS = 10;
const DEFAULT_POSTGRES_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_POSTGRES_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_POSTGRES_STARTUP_RETRY_ATTEMPTS = 10;
const DEFAULT_POSTGRES_STARTUP_RETRY_DELAY_MS = 1_000;

const positiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const serverSchema = z.strictObject({
  port: positiveIntegerSchema.default(3001),
  host: z.string().min(1).default("0.0.0.0"),
  cookieSecure: z.boolean().default(true),
  allowedOrigin: z.string().min(1).default("http://localhost:5173"),
  webRoot: z.string().min(1).nullable().default(null)
});
const databaseSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("sqlite"),
    path: z.string().min(1).default(DEFAULT_SQLITE_PATH)
  }),
  z.strictObject({
    provider: z.literal("postgres"),
    url: z.string().min(1).optional(),
    maxConnections: positiveIntegerSchema.default(DEFAULT_POSTGRES_MAX_CONNECTIONS),
    connectionTimeoutMs: positiveIntegerSchema.default(
      DEFAULT_POSTGRES_CONNECTION_TIMEOUT_MS
    ),
    statementTimeoutMs: positiveIntegerSchema.default(
      DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS
    ),
    lockTimeoutMs: positiveIntegerSchema.default(DEFAULT_POSTGRES_LOCK_TIMEOUT_MS),
    startupRetryAttempts: positiveIntegerSchema.default(
      DEFAULT_POSTGRES_STARTUP_RETRY_ATTEMPTS
    ),
    startupRetryDelayMs: positiveIntegerSchema.default(
      DEFAULT_POSTGRES_STARTUP_RETRY_DELAY_MS
    )
  })
]);
const localStorageSchema = z.strictObject({
  dataDir: z.string().min(1).default("data/attachments"),
  quotaBytes: positiveIntegerSchema.default(10 * GIB),
  maintenanceBatchSize: positiveIntegerSchema.default(100),
  uploadExpiryMs: positiveIntegerSchema.default(24 * HOUR_MS)
});
const limitsSchema = z.strictObject({
  jsonControlMaxBytes: positiveIntegerSchema.default(MIB),
  realtimeFrameMaxBytes: positiveIntegerSchema.default(256 * KIB),
  contentChunkMaxBytes: positiveIntegerSchema.default(256 * KIB),
  historyPageMaxItems: positiveIntegerSchema.default(128),
  historyPageMaxBytes: positiveIntegerSchema.default(4 * MIB)
});
const sessionsSchema = z.strictObject({
  idleTimeoutMs: positiveIntegerSchema.default(30 * MINUTE_MS),
  absoluteTimeoutMs: positiveIntegerSchema.default(24 * HOUR_MS)
});
const authSchema = z.strictObject({
  ipRateLimitMaxAttempts: positiveIntegerSchema.default(60),
  accountRateLimitMaxAttempts: positiveIntegerSchema.default(20)
});
const configFileSchema = z.strictObject({
  server: serverSchema.prefault({}),
  database: databaseSchema.prefault({ provider: "sqlite" }),
  localstorage: localStorageSchema.prefault({}),
  limits: limitsSchema.prefault({}),
  sessions: sessionsSchema.prefault({}),
  auth: authSchema.prefault({})
});

export interface SqliteDatabaseConfig {
  provider: "sqlite";
  path: string;
}

export interface PostgresDatabaseConfig {
  provider: "postgres";
  url: string;
  maxConnections: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  startupRetryAttempts: number;
  startupRetryDelayMs: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  database: SqliteDatabaseConfig | PostgresDatabaseConfig;
  dataDir: string;
  cookieSecure: boolean;
  allowedOrigin: string;
  webRoot: string | null;
  jsonControlMaxBytes: number;
  realtimeFrameMaxBytes: number;
  contentChunkMaxBytes: number;
  storageQuotaBytes: number;
  maintenanceBatchSize: number;
  contentUploadExpiryMs: number;
  sessionIdleTimeoutMs: number;
  sessionAbsoluteTimeoutMs: number;
  authIpRateLimitMaxAttempts: number;
  authAccountRateLimitMaxAttempts: number;
  historyPageMaxItems: number;
  historyPageMaxBytes: number;
}

export interface ConfigLoadOptions {
  cwd?: string;
  configPath?: string;
}

export function getConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: ConfigLoadOptions = {}
): ServerConfig {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const explicitConfigPath = options.configPath ?? env.FORTNOTE_CONFIG;
  const configPath = explicitConfigPath
    ? path.resolve(cwd, explicitConfigPath)
    : findConfigFile(cwd);
  if (explicitConfigPath && (configPath === undefined || !fs.existsSync(configPath))) {
    throw new Error(`Configuration file not found: ${explicitConfigPath}`);
  }

  const fileConfig = parseConfigFile(configPath);
  const baseDirectory = configPath ? path.dirname(configPath) : cwd;
  const configuredWebRoot = env.WEB_ROOT ?? fileConfig.server.webRoot;
  const databaseProvider = env.DATABASE_PROVIDER ?? fileConfig.database.provider;
  if (databaseProvider !== "sqlite" && databaseProvider !== "postgres") {
    throw new Error("Invalid DATABASE_PROVIDER: expected sqlite or postgres");
  }

  const database =
    databaseProvider === "sqlite"
      ? {
          provider: "sqlite" as const,
          path: resolveConfiguredPath(
            baseDirectory,
            env.DATABASE_PATH ??
              (fileConfig.database.provider === "sqlite"
                ? fileConfig.database.path
                : DEFAULT_SQLITE_PATH),
            true
          )
        }
      : {
          provider: "postgres" as const,
          url: postgresUrl(
            env.DATABASE_URL ??
              (fileConfig.database.provider === "postgres"
                ? fileConfig.database.url
                : undefined)
          ),
          maxConnections: environmentPositiveInteger(
            env,
            "DATABASE_MAX_CONNECTIONS",
            fileConfig.database.provider === "postgres"
              ? fileConfig.database.maxConnections
              : DEFAULT_POSTGRES_MAX_CONNECTIONS
          ),
          connectionTimeoutMs: environmentPositiveInteger(
            env,
            "DATABASE_CONNECTION_TIMEOUT_MS",
            fileConfig.database.provider === "postgres"
              ? fileConfig.database.connectionTimeoutMs
              : DEFAULT_POSTGRES_CONNECTION_TIMEOUT_MS
          ),
          statementTimeoutMs: environmentPositiveInteger(
            env,
            "DATABASE_STATEMENT_TIMEOUT_MS",
            fileConfig.database.provider === "postgres"
              ? fileConfig.database.statementTimeoutMs
              : DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS
          ),
          lockTimeoutMs: environmentPositiveInteger(
            env,
            "DATABASE_LOCK_TIMEOUT_MS",
            fileConfig.database.provider === "postgres"
              ? fileConfig.database.lockTimeoutMs
              : DEFAULT_POSTGRES_LOCK_TIMEOUT_MS
          ),
          startupRetryAttempts: environmentPositiveInteger(
            env,
            "DATABASE_STARTUP_RETRY_ATTEMPTS",
            fileConfig.database.provider === "postgres"
              ? fileConfig.database.startupRetryAttempts
              : DEFAULT_POSTGRES_STARTUP_RETRY_ATTEMPTS
          ),
          startupRetryDelayMs: environmentPositiveInteger(
            env,
            "DATABASE_STARTUP_RETRY_DELAY_MS",
            fileConfig.database.provider === "postgres"
              ? fileConfig.database.startupRetryDelayMs
              : DEFAULT_POSTGRES_STARTUP_RETRY_DELAY_MS
          )
        };

  return {
    port: environmentPositiveInteger(env, "PORT", fileConfig.server.port),
    host: env.HOST ?? fileConfig.server.host,
    database,
    dataDir: resolveConfiguredPath(
      baseDirectory,
      env.DATA_DIR ?? fileConfig.localstorage.dataDir
    ),
    cookieSecure: environmentBoolean(
      env,
      "COOKIE_SECURE",
      fileConfig.server.cookieSecure
    ),
    allowedOrigin: env.ALLOWED_ORIGIN ?? fileConfig.server.allowedOrigin,
    webRoot:
      configuredWebRoot === null
        ? null
        : resolveConfiguredPath(baseDirectory, configuredWebRoot),
    jsonControlMaxBytes: environmentPositiveInteger(
      env,
      "JSON_CONTROL_MAX_BYTES",
      fileConfig.limits.jsonControlMaxBytes
    ),
    realtimeFrameMaxBytes: environmentPositiveInteger(
      env,
      "REALTIME_FRAME_MAX_BYTES",
      fileConfig.limits.realtimeFrameMaxBytes
    ),
    contentChunkMaxBytes: environmentPositiveInteger(
      env,
      "CONTENT_CHUNK_MAX_BYTES",
      fileConfig.limits.contentChunkMaxBytes
    ),
    storageQuotaBytes: environmentPositiveInteger(
      env,
      "STORAGE_QUOTA_BYTES",
      fileConfig.localstorage.quotaBytes
    ),
    maintenanceBatchSize: environmentPositiveInteger(
      env,
      "MAINTENANCE_BATCH_SIZE",
      fileConfig.localstorage.maintenanceBatchSize
    ),
    contentUploadExpiryMs: environmentPositiveInteger(
      env,
      "CONTENT_UPLOAD_EXPIRY_MS",
      fileConfig.localstorage.uploadExpiryMs
    ),
    sessionIdleTimeoutMs: environmentPositiveInteger(
      env,
      "SESSION_IDLE_TIMEOUT_MS",
      fileConfig.sessions.idleTimeoutMs
    ),
    sessionAbsoluteTimeoutMs: environmentPositiveInteger(
      env,
      "SESSION_ABSOLUTE_TIMEOUT_MS",
      fileConfig.sessions.absoluteTimeoutMs
    ),
    authIpRateLimitMaxAttempts: environmentPositiveInteger(
      env,
      "AUTH_IP_RATE_LIMIT_MAX_ATTEMPTS",
      fileConfig.auth.ipRateLimitMaxAttempts
    ),
    authAccountRateLimitMaxAttempts: environmentPositiveInteger(
      env,
      "AUTH_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS",
      fileConfig.auth.accountRateLimitMaxAttempts
    ),
    historyPageMaxItems: environmentPositiveInteger(
      env,
      "HISTORY_PAGE_MAX_ITEMS",
      fileConfig.limits.historyPageMaxItems
    ),
    historyPageMaxBytes: environmentPositiveInteger(
      env,
      "HISTORY_PAGE_MAX_BYTES",
      fileConfig.limits.historyPageMaxBytes
    )
  };
}

export function resolveDataPath(config: ServerConfig, value: string): string {
  return path.resolve(value.startsWith("/") ? value : config.dataDir, value);
}

function findConfigFile(startDirectory: string): string | undefined {
  let directory = startDirectory;
  for (;;) {
    const candidate = path.join(directory, "config.yaml");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function parseConfigFile(
  configPath: string | undefined
): z.infer<typeof configFileSchema> {
  let input: unknown = {};
  if (configPath) {
    const document = parseDocument(fs.readFileSync(configPath, "utf8"));
    if (document.errors.length > 0) {
      throw new Error(
        `Could not parse ${configPath}: ${document.errors.map(({ message }) => message).join("; ")}`
      );
    }
    input = document.toJS() ?? {};
  }

  const parsed = configFileSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Invalid configuration${configPath ? ` in ${configPath}` : ""}: ${detail}`
    );
  }
  return parsed.data;
}

function resolveConfiguredPath(
  baseDirectory: string,
  value: string,
  allowMemoryDatabase = false
): string {
  if (allowMemoryDatabase && value === ":memory:") {
    return value;
  }
  return path.resolve(baseDirectory, value);
}

function environmentPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function environmentBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean
): boolean {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`Invalid ${name}`);
}

function postgresUrl(value: string | undefined): string {
  if (!value) {
    throw new Error("DATABASE_URL is required when database provider is postgres");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid DATABASE_URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Invalid DATABASE_URL");
  }
  return value;
}
