import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

const apiPort = Number(process.env.API_PORT ?? 3101);
const clientPort = Number(process.env.CLIENT_PORT ?? 5273);
const productionPerformance = process.env.FORTNOTE_PERFORMANCE_BUILD === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  outputDir: "test-results",
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${String(clientPort)}`,
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      testIgnore: ["accessibility.spec.ts", "performance.spec.ts"],
      workers: 1,
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "accessibility",
      testMatch: "accessibility.spec.ts",
      outputDir: "test-results/accessibility",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "performance",
      testMatch: "performance.spec.ts",
      outputDir: "test-results/performance",
      timeout: 180_000,
      workers: 1,
      use: { ...devices["Desktop Chrome"], trace: "off" }
    }
  ],
  webServer: [
    {
      command: productionPerformance
        ? "node apps/server/dist/index.js"
        : "pnpm exec tsx tests/e2e/support/runE2eServer.ts",
      env: {
        API_PORT: String(apiPort),
        CLIENT_PORT: String(clientPort),
        PORT: String(apiPort)
      },
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      url: `http://127.0.0.1:${String(apiPort)}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: productionPerformance
        ? `pnpm --filter @fortnote/client preview --host 127.0.0.1 --port ${String(clientPort)}`
        : `pnpm --filter @fortnote/client dev --host 127.0.0.1 --port ${String(clientPort)}`,
      env: {
        API_PORT: String(apiPort),
        CLIENT_PORT: String(clientPort)
      },
      url: `http://127.0.0.1:${String(clientPort)}`,
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
