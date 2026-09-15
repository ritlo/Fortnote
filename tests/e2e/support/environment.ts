export function e2eServerEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...env,
    ALLOWED_ORIGIN: env.ALLOWED_ORIGIN ?? `http://127.0.0.1:${env.CLIENT_PORT ?? "5173"}`,
    COOKIE_SECURE: env.COOKIE_SECURE ?? "false",
    DATABASE_PATH: env.DATABASE_PATH ?? "data/e2e.sqlite",
    DATA_DIR: env.DATA_DIR ?? "data/e2e-attachments",
    AUTH_IP_RATE_LIMIT_MAX_ATTEMPTS: env.AUTH_IP_RATE_LIMIT_MAX_ATTEMPTS ?? "1000",
    AUTH_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS:
      env.AUTH_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS ?? "1000",
    PORT: env.API_PORT ?? env.PORT ?? "3001"
  };
}
