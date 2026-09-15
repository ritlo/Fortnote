import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const positiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const serverSchema = z.strictObject({
  port: positiveIntegerSchema.default(3001),
  host: z.string().min(1).default("0.0.0.0"),
  cookieSecure: z.boolean().default(true),
  allowedOrigin: z.string().min(1).default("http://localhost:5173"),
  webRoot: z.string().min(1).nullable().default(null)
});
const databaseSchema = z.strictObject({
  url: z.string().min(1).optional(),
  maxConnections: positiveIntegerSchema.default(10),
  connectionTimeoutMs: positiveIntegerSchema.default(5_000),
  statementTimeoutMs: positiveIntegerSchema.default(30_000),
  lockTimeoutMs: positiveIntegerSchema.default(5_000),
  startupRetryAttempts: positiveIntegerSchema.default(10),
  startupRetryDelayMs: positiveIntegerSchema.default(1_000)
});
const storageSchema = z.strictObject({
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
  database: databaseSchema.prefault({}),
  storage: storageSchema.prefault({}),
  limits: limitsSchema.prefault({}),
  sessions: sessionsSchema.prefault({}),
  auth: authSchema.prefault({})
});

export interface DatabaseConfig {
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
  database: DatabaseConfig;
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
  const integer = (name: string, fallback: number) =>
    environmentPositiveInteger(env, name, fallback);

  return {
    port: integer("PORT", fileConfig.server.port),
    host: env.HOST ?? fileConfig.server.host,
    database: {
      url: databaseUrl(env.DATABASE_URL ?? fileConfig.database.url),
      maxConnections: integer(
        "DATABASE_MAX_CONNECTIONS",
        fileConfig.database.maxConnections
      ),
      connectionTimeoutMs: integer(
        "DATABASE_CONNECTION_TIMEOUT_MS",
        fileConfig.database.connectionTimeoutMs
      ),
      statementTimeoutMs: integer(
        "DATABASE_STATEMENT_TIMEOUT_MS",
        fileConfig.database.statementTimeoutMs
      ),
      lockTimeoutMs: integer(
        "DATABASE_LOCK_TIMEOUT_MS",
        fileConfig.database.lockTimeoutMs
      ),
      startupRetryAttempts: integer(
        "DATABASE_STARTUP_RETRY_ATTEMPTS",
        fileConfig.database.startupRetryAttempts
      ),
      startupRetryDelayMs: integer(
        "DATABASE_STARTUP_RETRY_DELAY_MS",
        fileConfig.database.startupRetryDelayMs
      )
    },
    cookieSecure: environmentBoolean(
      env,
      "COOKIE_SECURE",
      fileConfig.server.cookieSecure
    ),
    allowedOrigin: env.ALLOWED_ORIGIN ?? fileConfig.server.allowedOrigin,
    webRoot:
      configuredWebRoot === null ? null : path.resolve(baseDirectory, configuredWebRoot),
    jsonControlMaxBytes: integer(
      "JSON_CONTROL_MAX_BYTES",
      fileConfig.limits.jsonControlMaxBytes
    ),
    realtimeFrameMaxBytes: integer(
      "REALTIME_FRAME_MAX_BYTES",
      fileConfig.limits.realtimeFrameMaxBytes
    ),
    contentChunkMaxBytes: integer(
      "CONTENT_CHUNK_MAX_BYTES",
      fileConfig.limits.contentChunkMaxBytes
    ),
    storageQuotaBytes: integer("STORAGE_QUOTA_BYTES", fileConfig.storage.quotaBytes),
    maintenanceBatchSize: integer(
      "MAINTENANCE_BATCH_SIZE",
      fileConfig.storage.maintenanceBatchSize
    ),
    contentUploadExpiryMs: integer(
      "CONTENT_UPLOAD_EXPIRY_MS",
      fileConfig.storage.uploadExpiryMs
    ),
    sessionIdleTimeoutMs: integer(
      "SESSION_IDLE_TIMEOUT_MS",
      fileConfig.sessions.idleTimeoutMs
    ),
    sessionAbsoluteTimeoutMs: integer(
      "SESSION_ABSOLUTE_TIMEOUT_MS",
      fileConfig.sessions.absoluteTimeoutMs
    ),
    authIpRateLimitMaxAttempts: integer(
      "AUTH_IP_RATE_LIMIT_MAX_ATTEMPTS",
      fileConfig.auth.ipRateLimitMaxAttempts
    ),
    authAccountRateLimitMaxAttempts: integer(
      "AUTH_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS",
      fileConfig.auth.accountRateLimitMaxAttempts
    ),
    historyPageMaxItems: integer(
      "HISTORY_PAGE_MAX_ITEMS",
      fileConfig.limits.historyPageMaxItems
    ),
    historyPageMaxBytes: integer(
      "HISTORY_PAGE_MAX_BYTES",
      fileConfig.limits.historyPageMaxBytes
    )
  };
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

function databaseUrl(value: string | undefined): string {
  if (!value) {
    throw new Error("DATABASE_URL or database.url is required");
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
