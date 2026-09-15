export function e2eServerEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...env,
    ALLOWED_ORIGIN: env.ALLOWED_ORIGIN ?? `http://127.0.0.1:${env.CLIENT_PORT ?? "5173"}`,
    COOKIE_SECURE: env.COOKIE_SECURE ?? "false",
    // Defaults to the disposable database from `pnpm test:db:start`.
    DATABASE_URL:
      env.DATABASE_URL ??
      env.FORTNOTE_POSTGRES_TEST_URL ??
      "postgresql://fortnote:fortnote-test@127.0.0.1:55432/fortnote",
    AUTH_IP_RATE_LIMIT_MAX_ATTEMPTS: env.AUTH_IP_RATE_LIMIT_MAX_ATTEMPTS ?? "1000",
    AUTH_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS:
      env.AUTH_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS ?? "1000",
    PORT: env.API_PORT ?? env.PORT ?? "3001"
  };
}
