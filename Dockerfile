# syntax=docker/dockerfile:1.7

FROM docker.io/library/node:22-bookworm-slim AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/client apps/client
COPY apps/server apps/server
COPY packages/shared packages/shared
RUN pnpm build
RUN pnpm --filter @fortnote/server deploy --prod --legacy /runtime

FROM docker.io/library/node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV WEB_ROOT=/app/public
WORKDIR /app

COPY --from=workspace --chown=node:node /runtime ./
COPY --from=workspace --chown=node:node /workspace/apps/client/dist ./public
COPY --chown=node:node config.yaml ./config.yaml
COPY --chown=node:node drizzle/postgres ./drizzle/postgres

USER node
EXPOSE 3001

CMD ["node", "dist/index.js"]
