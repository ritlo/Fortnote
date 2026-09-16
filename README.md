# Fortnote

Fortnote is a self-hosted, end-to-end encrypted notes application with realtime collaboration, sharing, attachments, and account recovery.

## Requirements

- Node.js 22 or newer
- pnpm
- Docker or Podman, for PostgreSQL in development and tests

## Development

Install dependencies:

```sh
pnpm install
```

Start PostgreSQL, then the API server and web client in separate terminals. The server applies
database migrations before it listens:

```sh
docker compose -f compose.postgres.yaml up -d postgres
```

```sh
pnpm dev:server
```

```sh
pnpm dev
```

Open <http://localhost:5173>.

### Tests

The server tests need PostgreSQL. Start the disposable test database once, then run the tests:

```sh
pnpm test:db:start
pnpm test
```

Each server test creates and drops its own database, and the runtime contract tests clear the
test database itself. Stop the container with `pnpm test:db:stop`. To use another server, set
`FORTNOTE_POSTGRES_TEST_URL` to a URL whose user can create databases; never point it at data you
want to keep.

## Configuration

Server settings live in the root [`config.yaml`](config.yaml). The committed file contains
safe local defaults and no secrets; its database URL matches the `postgres` service in
`compose.postgres.yaml`.

The server searches the current directory and its parents for `config.yaml`. Set
`FORTNOTE_CONFIG` to use a different file. Environment variables such as `PORT`, `DATABASE_URL`,
`DATABASE_MAX_CONNECTIONS`, `DATABASE_CONNECTION_TIMEOUT_MS`, `DATABASE_STATEMENT_TIMEOUT_MS`,
`DATABASE_LOCK_TIMEOUT_MS`, `DATABASE_STARTUP_RETRY_ATTEMPTS`,
`DATABASE_STARTUP_RETRY_DELAY_MS`, `STORAGE_QUOTA_BYTES`, and `ALLOWED_ORIGIN` override YAML
values, which keeps secrets and deployment-specific values out of source control.

PostgreSQL defaults to 10 pooled connections, a 5-second connection timeout, a 30-second statement
timeout, and a 5-second lock timeout. Startup makes up to 10 connection attempts one second apart
before failing; all of these values can be changed with the YAML fields or environment variables
listed above.

## Storage and deployment roadmap

PostgreSQL stores relational data and encrypted attachment chunks. Attachment chunks use ordinary
`bytea` rows rather than PostgreSQL large objects. This fits Fortnote's existing bounded,
encrypted chunks and keeps backup and deletion behavior
transactional. An S3-compatible attachment backend can be added later through the same storage
interface.

The staging deployment uses Docker Compose with separate application and PostgreSQL services. The
application image builds both the web client and API, runs as the unprivileged `node` user, serves
the client and API from one origin, mounts `config.yaml` read-only, and stores PostgreSQL-mode
attachments entirely in the database. PostgreSQL data is kept in the `postgres-data` volume; the
application container has a read-only filesystem and does not need an attachment volume.

Start the complete local stack and open <http://localhost:3001>:

```sh
docker compose -f compose.postgres.yaml up --build
```

The committed Compose defaults are for localhost only. For a non-local deployment, set a strong
database password and a matching connection URL, plus the externally visible HTTPS origin:

```sh
FORTNOTE_POSTGRES_PASSWORD='replace-with-a-strong-password' \
FORTNOTE_DATABASE_URL='postgresql://fortnote:URL_ENCODED_PASSWORD@postgres:5432/fortnote' \
FORTNOTE_ALLOWED_ORIGIN='https://notes.example.com' \
FORTNOTE_COOKIE_SECURE=true \
docker compose -f compose.postgres.yaml up -d --build
```

`FORTNOTE_POSTGRES_PASSWORD` is passed to PostgreSQL as-is; encode reserved URL characters in the
password portion of `FORTNOTE_DATABASE_URL`. Prefer a protected environment file or deployment
secret manager instead of placing credentials in shell history.

On a host with Docker Compose, run the destructive, isolated deployment smoke test before staging:

```sh
pnpm smoke:compose
```

The smoke runner uses a unique Compose project and database volume, chooses unprivileged local
ports, and removes its stack afterward. It verifies image build and migration, database readiness,
non-root execution, authentication, note creation, encrypted attachment upload/download, app
restart, persistence, graceful shutdown, and volume cleanup. Set `FORTNOTE_SMOKE_PORT` and
`FORTNOTE_SMOKE_POSTGRES_PORT` only when specific unused host ports are required. The runner uses
Docker when available and otherwise uses Podman; set `FORTNOTE_CONTAINER_ENGINE` to override that
selection. The selected engine must have a Compose provider installed.

Migrations run automatically before the application becomes ready. After changing
`apps/server/src/db/schema.ts`, generate a migration and apply it to the development database:

```sh
pnpm --filter @fortnote/server db:generate
pnpm --filter @fortnote/server db:migrate
```

`drizzle/` holds a single baseline migration. While the project has no deployed data, a schema
change may also be folded into that baseline by regenerating it, which requires empty databases:

```sh
docker compose down -v
pnpm --filter @fortnote/server db:migrate
pnpm test:db:stop && pnpm test:db:start
```

The runtime contract tests in `tests/server/db/postgres-runtime.test.ts` apply migrations to the
test database, clear it, and verify auth, notes, encrypted attachments, restart and failed-migration
recovery, and concurrent attachment, content, note, membership, rotation, and event mutations.
They run as part of `pnpm test`.

## Checks

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run `pnpm format` to apply the Prettier formatting that `format:check` enforces. The CI
workflow in `.github/workflows/ci.yml` runs these checks on every push and pull request against a
PostgreSQL service.

## License

See [LICENSE](LICENSE).
