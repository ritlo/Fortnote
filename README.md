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
`DATABASE_PATH`, `DATA_DIR`, and `ALLOWED_ORIGIN` override YAML values, which keeps secrets
and deployment-specific values out of source control.

SQLite is currently the only supported database provider. The `database.provider` setting
is explicit so PostgreSQL can be added in a later stage without changing the configuration
contract.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## License

See [LICENSE](LICENSE).
