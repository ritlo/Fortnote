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
`DATABASE_PROVIDER`, `DATABASE_PATH`, `DATABASE_URL`, `DATABASE_MAX_CONNECTIONS`, `DATA_DIR`,
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

## Storage and deployment roadmap

PostgreSQL stores relational data and encrypted attachment chunks. Attachment chunks use ordinary
`bytea` rows rather than PostgreSQL large objects. This fits Fortnote's existing bounded,
encrypted chunks and keeps backup and deletion behavior
transactional. An S3-compatible attachment backend can be added later through the same storage
interface.

The long-term deployment target is Docker Compose with separate application and PostgreSQL
services, persistent volumes, health checks, a read-only `config.yaml` mount, and secrets passed
through environment variables or Docker secrets. The committed configuration will continue to
default to local SQLite and local filesystem storage for development.

The PostgreSQL schema, migration history, repositories, runtime provider selection, and chunked
attachment backend are present. For schema development, start the isolated PostgreSQL service and
apply its migrations with:

```sh
docker compose -f compose.postgres.yaml up -d
DATABASE_URL=postgresql://fortnote:fortnote-local@127.0.0.1:5432/fortnote \
  pnpm --filter @fortnote/server db:migrate:postgres
```

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## License

See [LICENSE](LICENSE).
