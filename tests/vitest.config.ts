import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  resolve: {
    alias: [
      {
        find: /^@blocknote\/mantine$/u,
        replacement: fileURLToPath(
          new URL(
            "../apps/client/node_modules/@blocknote/mantine/dist/blocknote-mantine.js",
            import.meta.url
          )
        )
      },
      {
        find: /^@blocknote\/react$/u,
        replacement: fileURLToPath(
          new URL(
            "../apps/client/node_modules/@blocknote/react/dist/blocknote-react.js",
            import.meta.url
          )
        )
      },
      {
        find: "@client",
        replacement: fileURLToPath(new URL("../apps/client/src", import.meta.url))
      },
      {
        find: "@server",
        replacement: fileURLToPath(new URL("../apps/server/src", import.meta.url))
      },
      {
        find: "@shared",
        replacement: fileURLToPath(new URL("../packages/shared/src", import.meta.url))
      }
    ]
  },
  test: {
    include: [
      "tests/client/**/*.test.{ts,tsx}",
      "tests/server/**/*.test.{ts,tsx}",
      "tests/shared/**/*.test.{ts,tsx}"
    ]
  }
});
