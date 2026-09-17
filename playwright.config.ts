import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

const clientPort = Number(process.env.CLIENT_PORT ?? 5273);
// Parallel workers share one API, client dev server, and database, so smaller
// machines such as CI runners need fewer of them.
const parallelWorkers = Number(process.env.E2E_WORKERS ?? 4);

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/support/globalSetup.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
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
      grepInvert: /@server-restart/,
      fullyParallel: true,
      workers: parallelWorkers,
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "chromium-server-restart",
      testIgnore: ["accessibility.spec.ts", "performance.spec.ts"],
      grep: /@server-restart/,
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
  ]
});
