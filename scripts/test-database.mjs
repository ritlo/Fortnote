// Starts or stops a disposable PostgreSQL container for the server test suite.
// Usage: node scripts/test-database.mjs start|stop
import { spawnSync } from "node:child_process";
import process from "node:process";

const CONTAINER = "fortnote-test-postgres";
const IMAGE = "docker.io/library/postgres:18-alpine";
const PORT = process.env.FORTNOTE_TEST_POSTGRES_PORT ?? "55432";
const PASSWORD = "fortnote-test";
const TEST_URL = `postgresql://fortnote:${PASSWORD}@127.0.0.1:${PORT}/fortnote`;

function containerEngine() {
  const candidates = [process.env.FORTNOTE_CONTAINER_ENGINE, "docker", "podman"];
  for (const candidate of candidates.filter(Boolean)) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) {
      return candidate;
    }
  }
  throw new Error(
    "Docker or Podman is required; set FORTNOTE_CONTAINER_ENGINE to override"
  );
}

function run(engine, args, options = {}) {
  return spawnSync(engine, args, { encoding: "utf8", ...options });
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isRunning(engine) {
  const result = run(engine, ["inspect", "--format", "{{.State.Running}}", CONTAINER]);
  return result.status === 0 && result.stdout.trim() === "true";
}

function start(engine) {
  if (!isRunning(engine)) {
    const result = run(
      engine,
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        CONTAINER,
        "--env",
        "POSTGRES_DB=fortnote",
        "--env",
        "POSTGRES_USER=fortnote",
        "--env",
        `POSTGRES_PASSWORD=${PASSWORD}`,
        "--publish",
        `127.0.0.1:${PORT}:5432`,
        "--tmpfs",
        "/var/lib/postgresql",
        IMAGE
      ],
      { stdio: "inherit" }
    );
    if (result.status !== 0) {
      throw new Error(`Could not start ${CONTAINER}`);
    }
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = run(engine, [
      "exec",
      CONTAINER,
      "pg_isready",
      "-U",
      "fortnote",
      "-d",
      "fortnote"
    ]);
    if (ready.status === 0) {
      console.log(`Test PostgreSQL is ready at ${TEST_URL}`);
      return;
    }
    sleep(1_000);
  }
  throw new Error(`${CONTAINER} did not become ready`);
}

function stop(engine) {
  run(engine, ["rm", "--force", CONTAINER], { stdio: "ignore" });
  console.log(`Stopped ${CONTAINER}`);
}

const command = process.argv[2];
try {
  const engine = containerEngine();
  if (command === "start") {
    start(engine);
  } else if (command === "stop") {
    stop(engine);
  } else {
    throw new Error("Usage: node scripts/test-database.mjs start|stop");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
