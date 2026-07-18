import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  outputDir: "test-results",
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      testIgnore: ["accessibility.spec.ts", "performance.spec.ts"],
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
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: [
    {
      command:
        "DATABASE_PATH=data/e2e.sqlite DATA_DIR=data/e2e-attachments COOKIE_SECURE=false ALLOWED_ORIGIN=http://127.0.0.1:5173 pnpm --filter @fortnote/server dev",
      url: "http://127.0.0.1:3001/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    },
    {
      command: "pnpm --filter @fortnote/client dev --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    }
  ]
});
