import path from "node:path";

export interface ServerConfig {
  port: number;
  host: string;
  databasePath: string;
  dataDir: string;
  cookieSecure: boolean;
  allowedOrigin: string;
}

export function getConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? "0.0.0.0",
    databasePath: process.env.DATABASE_PATH ?? "data/fortnote.sqlite",
    dataDir: process.env.DATA_DIR ?? "data/attachments",
    cookieSecure: process.env.COOKIE_SECURE !== "false",
    allowedOrigin: process.env.ALLOWED_ORIGIN ?? "http://localhost:5173"
  };
}

export function resolveDataPath(config: ServerConfig, value: string): string {
  return path.resolve(process.cwd(), value.startsWith("/") ? value : config.dataDir, value);
}
