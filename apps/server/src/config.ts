import path from "node:path";

export interface ServerConfig {
  port: number;
  host: string;
  databasePath: string;
  dataDir: string;
  cookieSecure: boolean;
  allowedOrigin: string;
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

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export function getConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: positiveInteger(env, "PORT", 3001),
    host: env.HOST ?? "0.0.0.0",
    databasePath: env.DATABASE_PATH ?? "data/fortnote.sqlite",
    dataDir: env.DATA_DIR ?? "data/attachments",
    cookieSecure: env.COOKIE_SECURE !== "false",
    allowedOrigin: env.ALLOWED_ORIGIN ?? "http://localhost:5173",
    jsonControlMaxBytes: MIB,
    realtimeFrameMaxBytes: positiveInteger(env, "REALTIME_FRAME_MAX_BYTES", 256 * KIB),
    contentChunkMaxBytes: positiveInteger(env, "CONTENT_CHUNK_MAX_BYTES", 256 * KIB),
    storageQuotaBytes: positiveInteger(env, "STORAGE_QUOTA_BYTES", 10 * GIB),
    maintenanceBatchSize: positiveInteger(env, "MAINTENANCE_BATCH_SIZE", 100),
    contentUploadExpiryMs: positiveInteger(env, "CONTENT_UPLOAD_EXPIRY_MS", 24 * HOUR_MS),
    sessionIdleTimeoutMs: positiveInteger(env, "SESSION_IDLE_TIMEOUT_MS", 30 * MINUTE_MS),
    sessionAbsoluteTimeoutMs: positiveInteger(
      env,
      "SESSION_ABSOLUTE_TIMEOUT_MS",
      24 * HOUR_MS
    ),
    authIpRateLimitMaxAttempts: positiveInteger(
      env,
      "AUTH_IP_RATE_LIMIT_MAX_ATTEMPTS",
      60
    ),
    authAccountRateLimitMaxAttempts: positiveInteger(
      env,
      "AUTH_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS",
      20
    ),
    historyPageMaxItems: positiveInteger(env, "HISTORY_PAGE_MAX_ITEMS", 128),
    historyPageMaxBytes: positiveInteger(env, "HISTORY_PAGE_MAX_BYTES", 4 * MIB)
  };
}

export function resolveDataPath(config: ServerConfig, value: string): string {
  return path.resolve(process.cwd(), value.startsWith("/") ? value : config.dataDir, value);
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
