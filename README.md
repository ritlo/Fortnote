# Fortnote

Fortnote is a self-hosted, end-to-end encrypted notes application with realtime collaboration, sharing, attachments, and account recovery.

## Requirements

- Node.js 22 or newer
- pnpm

## Development

Install dependencies:

```sh
pnpm install
```

Start the API server and web client in separate terminals:

```sh
pnpm dev:server
```

```sh
pnpm dev
```

Open <http://localhost:5173>. Local server data is written under `data/` and is ignored by Git.

## Configuration

Server settings live in the root [`config.yaml`](config.yaml). The committed file contains
safe local defaults and no secrets. Relative database and `localstorage` paths are resolved from
the configuration file's directory.

The server searches the current directory and its parents for `config.yaml`. Set
`FORTNOTE_CONFIG` to use a different file. Existing environment variables such as `PORT`,
`DATABASE_PROVIDER`, `DATABASE_PATH`, `DATABASE_URL`, `DATABASE_MAX_CONNECTIONS`,
`DATABASE_CONNECTION_TIMEOUT_MS`, `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_LOCK_TIMEOUT_MS`,
`DATABASE_STARTUP_RETRY_ATTEMPTS`, `DATABASE_STARTUP_RETRY_DELAY_MS`, `DATA_DIR`,
and `ALLOWED_ORIGIN` override YAML values, which keeps secrets and deployment-specific values
out of source control.

SQLite remains the safe default. To run the complete application with PostgreSQL, set the
provider and connection URL through the environment; migrations run before the server listens:

```sh
DATABASE_PROVIDER=postgres \
DATABASE_URL=postgresql://fortnote:fortnote-local@127.0.0.1:5432/fortnote \
DATABASE_MAX_CONNECTIONS=10 \
pnpm dev:server
```

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

The PostgreSQL schema, migration history, repositories, runtime provider selection, and chunked
attachment backend are present. Migrations run automatically before the application becomes ready.
For schema development, start only the isolated PostgreSQL service and apply migrations manually:

```sh
docker compose -f compose.postgres.yaml up -d postgres
DATABASE_URL=postgresql://fortnote:fortnote-local@127.0.0.1:5432/fortnote \
  pnpm --filter @fortnote/server db:migrate:postgres
```

Run the live PostgreSQL runtime contract tests against an isolated test database. They apply
migrations, clear that database, run the same auth, note, and encrypted-attachment workflow against
SQLite and PostgreSQL, verify restart and failed-migration recovery, and exercise concurrent
attachment, content, note, membership, rotation, and event mutations. Never point them at
development or production data:

```sh
FORTNOTE_POSTGRES_TEST_URL=postgresql://fortnote:fortnote-local@127.0.0.1:5432/fortnote_test \
  pnpm --filter @fortnote/server test:postgres
```

## Checks

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run `pnpm format` to apply the Prettier formatting that `format:check` enforces. The CI
workflow in `.github/workflows/ci.yml` runs these checks on every push and pull request, plus
the server suite against PostgreSQL through `pnpm --filter @fortnote/server test:postgres`.

## License

See [LICENSE](LICENSE).
