#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const containerEngine = selectContainerEngine(process.env.FORTNOTE_CONTAINER_ENGINE);
const containerName = `fortnote-performance-postgres-${String(process.pid)}-${String(Date.now())}`;
const postgresPort = performancePort(process.env.FORTNOTE_PERFORMANCE_POSTGRES_PORT);
const databasePassword = crypto.randomBytes(24).toString("hex");
const databaseUrl =
  `postgresql://fortnote:${databasePassword}@127.0.0.1:` +
  `${String(postgresPort)}/fortnote`;
let containerStarted = false;
let cleanupPromise = null;
let interrupted = false;

process.once("SIGINT", () => handleSignal("SIGINT", 130));
process.once("SIGTERM", () => handleSignal("SIGTERM", 143));

try {
  await run(containerEngine, [
    "run",
    "--detach",
    "--rm",
    `--name=${containerName}`,
    "--env",
    "POSTGRES_DB=fortnote",
    "--env",
    "POSTGRES_USER=fortnote",
    "--env",
    `POSTGRES_PASSWORD=${databasePassword}`,
    "--publish",
    `127.0.0.1:${String(postgresPort)}:5432`,
    "docker.io/library/postgres:18-alpine"
  ]);
  containerStarted = true;
  await waitForPostgres();
  await run(
    process.execPath,
    [path.join(repositoryRoot, "scripts/create-performance-fixture.mjs")],
    {
      ...process.env,
      FORTNOTE_PERFORMANCE_DATABASE_URL: databaseUrl,
      FORTNOTE_PERFORMANCE_PROFILE: process.env.FORTNOTE_PERFORMANCE_PROFILE ?? "smoke"
    }
  );
} finally {
  await cleanup();
}

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = spawnSync(
      containerEngine,
      ["exec", containerName, "pg_isready", "--username=fortnote", "--dbname=fortnote"],
      { stdio: "ignore" }
    );
    if (result.status === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("PostgreSQL performance container did not become ready");
}

async function cleanup() {
  if (!containerStarted) {
    return;
  }
  cleanupPromise ??= run(containerEngine, ["stop", "--time=20", containerName]);
  await cleanupPromise;
}

function handleSignal(signal, exitCode) {
  if (interrupted) {
    return;
  }
  interrupted = true;
  void cleanup().then(
    () => process.exit(exitCode),
    (error) => {
      console.error(`Performance cleanup failed after ${signal}`, error);
      process.exit(1);
    }
  );
}

function run(command, arguments_, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${arguments_.join(" ")} failed` +
            (signal ? ` with ${signal}` : ` with exit code ${String(code)}`)
        )
      );
    });
  });
}

function performancePort(value) {
  const parsed = value === undefined ? 42_000 + (process.pid % 20_000) : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_024 || parsed > 65_535) {
    throw new Error(
      "FORTNOTE_PERFORMANCE_POSTGRES_PORT must be an integer from 1024 through 65535"
    );
  }
  return parsed;
}

function selectContainerEngine(explicitEngine) {
  if (explicitEngine) {
    return explicitEngine;
  }
  for (const candidate of ["docker", "podman"]) {
    const runtime = spawnSync(candidate, ["info"], { stdio: "ignore" });
    if (runtime.status === 0) {
      return candidate;
    }
  }
  throw new Error("Docker or Podman is required for PostgreSQL performance tests");
}
