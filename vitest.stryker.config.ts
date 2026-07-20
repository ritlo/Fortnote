import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    include: [
      "packages/shared/src/crypto.test.ts",
      "packages/shared/src/crdt.test.ts",
      "apps/client/src/realtime/outbox.test.ts",
      "apps/client/src/lib/indexedDb.test.ts",
      "apps/server/src/config.test.ts",
      "apps/server/src/notes/access.test.ts",
      "apps/server/src/realtime/server.test.ts",
      "apps/server/src/notes/routes.test.ts"
    ]
  }
});
