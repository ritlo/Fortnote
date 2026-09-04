#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const MIB = 1024 * 1024;

export const PERFORMANCE_FIXTURE = Object.freeze({
  collaborators: 3,
  compactionEdits: 65,
  documentBytes: 4 * MIB,
  samples: 20,
  warmupRuns: 2
});

export const PERFORMANCE_SMOKE_FIXTURE = Object.freeze({
  ...PERFORMANCE_FIXTURE,
  samples: 3,
  warmupRuns: 1
});

export function performanceFixtureDefinition(
  seed = "fortnote-performance-v1",
  profile = "smoke"
) {
  const suffix = seed.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 24);
  if (!suffix) throw new Error("Performance fixture seed must contain a letter or digit");
  const account = (role) => ({
    password: `Fortnote-${suffix}-${role}-password`,
    suffix,
    username: `perf-${role}-${suffix}`
  });
  return {
    ...(profile === "full" ? PERFORMANCE_FIXTURE : PERFORMANCE_SMOKE_FIXTURE),
    accounts: {
      editor: account("editor"),
      owner: account("owner"),
      viewer: account("viewer")
    },
    seed: suffix,
    title: `Performance fixture ${suffix}`
  };
}

export function performanceDatabaseEnvironment(postgresUrl, sqlitePath) {
  return postgresUrl
    ? {
        DATABASE_PROVIDER: "postgres",
        DATABASE_URL: postgresUrl
      }
    : {
        DATABASE_PROVIDER: "sqlite",
        DATABASE_PATH: sqlitePath
      };
}

async function run() {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "fortnote-performance-"));
  const apiPort = await availablePort();
  let clientPort = await availablePort();
  while (clientPort === apiPort) clientPort = await availablePort();
  const outputDirectory = path.resolve(
    process.env.FORTNOTE_PERFORMANCE_OUTPUT ?? "test-results/performance"
  );
  const profile = process.env.FORTNOTE_PERFORMANCE_PROFILE ?? "smoke";
  if (profile !== "smoke" && profile !== "full") {
    throw new Error("FORTNOTE_PERFORMANCE_PROFILE must be smoke or full");
  }
  const definition = performanceFixtureDefinition(
    process.env.FORTNOTE_PERFORMANCE_SEED,
    profile
  );
  const postgresUrl = process.env.FORTNOTE_PERFORMANCE_DATABASE_URL;
  const databaseEnvironment = performanceDatabaseEnvironment(
    postgresUrl,
    path.join(fixtureRoot, "performance.sqlite")
  );
  await mkdir(outputDirectory, { recursive: true });

  const child = spawn(
    "pnpm",
    ["exec", "playwright", "test", "--project=performance"],
    {
      env: {
        ...process.env,
        ...databaseEnvironment,
        DATA_DIR: path.join(fixtureRoot, "ciphertext"),
        API_PORT: String(apiPort),
        ALLOWED_ORIGIN: `http://127.0.0.1:${String(clientPort)}`,
        CLIENT_PORT: String(clientPort),
        PORT: String(apiPort),
        FORTNOTE_PERFORMANCE_BUILD: "1",
        FORTNOTE_PERFORMANCE_OUTPUT: outputDirectory,
        FORTNOTE_PERFORMANCE_PROFILE: profile,
        FORTNOTE_PERFORMANCE_SEED: definition.seed,
        FORTNOTE_RUN_PERFORMANCE: "1"
      },
      stdio: "inherit"
    }
  );

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  // Playwright clears its output directory when the run starts, so write the
  // fixture after it exits to retain the exact dataset beside the results.
  await writeFile(
    path.join(outputDirectory, "fixture.json"),
    `${JSON.stringify(definition, null, 2)}\n`,
    "utf8"
  );
  if (process.env.FORTNOTE_KEEP_PERFORMANCE_FIXTURE !== "1") {
    await rm(fixtureRoot, { force: true, recursive: true });
  } else {
    console.log(`Performance fixture retained at ${fixtureRoot}`);
  }
  process.exitCode = exitCode;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate an isolated performance port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await run();
}
