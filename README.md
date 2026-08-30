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

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## License

See [LICENSE](LICENSE).
