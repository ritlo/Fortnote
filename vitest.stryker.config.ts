import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@client": fileURLToPath(new URL("./apps/client/src", import.meta.url)),
      "@server": fileURLToPath(new URL("./apps/server/src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./packages/shared/src", import.meta.url))
    }
  },
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    include: [
      "tests/shared/crypto.test.ts",
      "tests/shared/crdt.test.ts",
      "tests/client/realtime/outbox.test.ts",
      "tests/client/lib/indexedDb.test.ts",
      "tests/server/config.test.ts",
      "tests/server/notes/access.test.ts",
      "tests/server/realtime/server.test.ts",
      "tests/server/notes/routes.test.ts"
    ]
  }
});
