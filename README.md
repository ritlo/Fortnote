# Fortnote

Fortnote is a self-hosted notes application with end-to-end encryption, realtime collaboration,
sharing, encrypted attachments, and account recovery. Note content, titles, folder names, and
attachment files and names are encrypted in the browser before they reach the server.

| Path              | Contents                                                          |
| ----------------- | ----------------------------------------------------------------- |
| `apps/client`     | React web app built with Vite, the BlockNote editor, and Yjs      |
| `apps/server`     | Express API and realtime WebSocket server on PostgreSQL (Drizzle) |
| `packages/shared` | Cryptography and realtime protocol shared by client and server    |
| `drizzle`         | Database migrations                                               |
| `tests`           | Unit, integration, and Playwright end-to-end tests                |
| `scripts`         | Test database, performance, and deployment smoke tooling          |

## Requirements

- Node.js 22 or newer
- pnpm 11 (`corepack enable` installs the version pinned in `package.json`)
- Docker or Podman, for PostgreSQL in development and tests

## Run the full stack

```sh
docker compose -f compose.postgres.yaml up --build
```

Open <http://localhost:3001>. The application container builds the client and API, serves both
from one origin, and stores all data, including encrypted attachments, in the `postgres` service.

## Development

```sh
pnpm install
docker compose -f compose.postgres.yaml up -d postgres
```

Then run the API and the web client in separate terminals:

```sh
pnpm dev:server
```

```sh
pnpm dev
```

Open <http://localhost:5173>. The API listens on port 3001 and applies database migrations before
it accepts requests; the Vite dev server proxies `/api` to it.

To delete all local data, remove the database volume:

```sh
docker compose -f compose.postgres.yaml down -v
```

## Configuration

The server reads [`config.yaml`](config.yaml), searching the current directory and its parents;
set `FORTNOTE_CONFIG` to use another file. The committed file holds safe local defaults and no
secrets. Environment variables override the YAML values:

| Environment                            | `config.yaml`                      |
| -------------------------------------- | ---------------------------------- |
| `HOST`                                 | `server.host`                      |
| `PORT`                                 | `server.port`                      |
| `ALLOWED_ORIGIN`                       | `server.allowedOrigin`             |
| `COOKIE_SECURE`                        | `server.cookieSecure`              |
| `WEB_ROOT`                             | `server.webRoot`                   |
| `DATABASE_URL`                         | `database.url`                     |
| `DATABASE_MAX_CONNECTIONS`             | `database.maxConnections`          |
| `DATABASE_CONNECTION_TIMEOUT_MS`       | `database.connectionTimeoutMs`     |
| `DATABASE_STATEMENT_TIMEOUT_MS`        | `database.statementTimeoutMs`      |
| `DATABASE_LOCK_TIMEOUT_MS`             | `database.lockTimeoutMs`           |
| `DATABASE_STARTUP_RETRY_ATTEMPTS`      | `database.startupRetryAttempts`    |
| `DATABASE_STARTUP_RETRY_DELAY_MS`      | `database.startupRetryDelayMs`     |
| `STORAGE_QUOTA_BYTES`                  | `storage.quotaBytes`               |
| `MAINTENANCE_BATCH_SIZE`               | `storage.maintenanceBatchSize`     |
| `CONTENT_UPLOAD_EXPIRY_MS`             | `storage.uploadExpiryMs`           |
| `JSON_CONTROL_MAX_BYTES`               | `limits.jsonControlMaxBytes`       |
| `REALTIME_FRAME_MAX_BYTES`             | `limits.realtimeFrameMaxBytes`     |
| `CONTENT_CHUNK_MAX_BYTES`              | `limits.contentChunkMaxBytes`      |
| `HISTORY_PAGE_MAX_ITEMS`               | `limits.historyPageMaxItems`       |
| `HISTORY_PAGE_MAX_BYTES`               | `limits.historyPageMaxBytes`       |
| `SESSION_IDLE_TIMEOUT_MS`              | `sessions.idleTimeoutMs`           |
| `SESSION_ABSOLUTE_TIMEOUT_MS`          | `sessions.absoluteTimeoutMs`       |
| `AUTH_IP_RATE_LIMIT_MAX_ATTEMPTS`      | `auth.ipRateLimitMaxAttempts`      |
| `AUTH_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS` | `auth.accountRateLimitMaxAttempts` |

The database pool defaults to 10 connections, a 5-second connection timeout, a 30-second statement
timeout, and a 5-second lock timeout. At startup the server tries to connect up to 10 times, one
second apart.

## Database

PostgreSQL holds all application data. Encrypted attachments are stored as bounded `bytea` chunks
rather than large objects, so backups and deletions stay transactional.

Migrations in `drizzle/` run automatically when the server starts:

- `0000_baseline.sql` and later numbered migrations are generated from
  `apps/server/src/db/schema.ts`.
- `0001_folder_integrity.sql` is a custom migration (`drizzle-kit generate --custom`) with the
  folder ownership triggers, which the schema cannot express. `db:generate` never recreates it.

After changing the schema, add a new migration and apply it to the development database:

```sh
pnpm --filter @fortnote/server db:generate
pnpm --filter @fortnote/server db:migrate
```

CI fails when `db:generate` would produce a migration that is not committed.

## Testing

Start the disposable test database once. It runs as the `fortnote-test-postgres` container on
`127.0.0.1:55432`:

```sh
pnpm test:db:start
```

| Command                        | What it runs                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `pnpm test`                    | Typecheck, then the shared, client, and server suites. Every server test gets its own database.         |
| `pnpm e2e`                     | Playwright end-to-end tests in Chromium on four workers, then the API-restart test on its own.          |
| `pnpm assurance:accessibility` | Accessibility checks with axe.                                                                          |
| `pnpm assurance:perf`          | Production build and performance run against its own PostgreSQL container. Use `:full` for all samples. |
| `pnpm smoke:compose`           | Destructive deployment smoke test in an isolated Compose project.                                       |

Install the Playwright browser once with `pnpm exec playwright install chromium`. The end-to-end
servers use ports 3101 and 5273; set `API_PORT` and `CLIENT_PORT` to change them, and
`E2E_WORKERS` to change the number of parallel workers (default 4). Set
`FORTNOTE_RUN_DOCUMENT_ASSURANCE=1` to include the long document durability journey.

Stop the test database with `pnpm test:db:stop`. To test against another PostgreSQL server, set
`FORTNOTE_POSTGRES_TEST_URL` to a URL whose user can create databases. Never point it at data you
want to keep: the tests create, clear, and drop databases.

## Deployment

The Compose defaults are for localhost only. For any other deployment, set a strong database
password, a matching connection URL, and the public HTTPS origin:

```sh
FORTNOTE_POSTGRES_PASSWORD='replace-with-a-strong-password' \
FORTNOTE_DATABASE_URL='postgresql://fortnote:URL_ENCODED_PASSWORD@postgres:5432/fortnote' \
FORTNOTE_ALLOWED_ORIGIN='https://notes.example.com' \
FORTNOTE_COOKIE_SECURE=true \
docker compose -f compose.postgres.yaml up -d --build
```

`FORTNOTE_POSTGRES_PASSWORD` is passed to PostgreSQL unchanged, so percent-encode reserved
characters in the password portion of `FORTNOTE_DATABASE_URL`. Keep credentials in a protected
environment file or secret manager rather than shell history.

The application container runs as the unprivileged `node` user with a read-only filesystem and
mounts `config.yaml` read-only. PostgreSQL data lives in the `postgres-data` volume.

Before staging, run `pnpm smoke:compose` on a host with Docker Compose. It builds the image, then
checks migrations, readiness, non-root execution, sign-in, notes, encrypted attachments, restart,
persistence, graceful shutdown, and cleanup, using a unique project, volume, and free local ports.
It uses Docker when available and Podman otherwise; set `FORTNOTE_CONTAINER_ENGINE` to choose, and
`FORTNOTE_SMOKE_PORT` or `FORTNOTE_SMOKE_POSTGRES_PORT` to fix the ports.

## Checks

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm format` applies the Prettier formatting that `format:check` enforces. The CI workflow in
`.github/workflows/ci.yml` runs these checks, the migration check, and `pnpm e2e` against
PostgreSQL services on every push and pull request.

## License

See [LICENSE](LICENSE).
