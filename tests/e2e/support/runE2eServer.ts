import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const restartPath = resolve("data/e2e-server.restart");
const statePath = resolve("data/e2e-server.state");
const serverEnvironment = {
  ...process.env,
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN ??
    `http://127.0.0.1:${process.env.CLIENT_PORT ?? "5173"}`,
  COOKIE_SECURE: process.env.COOKIE_SECURE ?? "false",
  DATABASE_PATH: process.env.DATABASE_PATH ?? "data/e2e.sqlite",
  DATA_DIR: process.env.DATA_DIR ?? "data/e2e-attachments",
  AUTH_IP_RATE_LIMIT_MAX_ATTEMPTS: process.env.AUTH_IP_RATE_LIMIT_MAX_ATTEMPTS ?? "1000",
  AUTH_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS:
    process.env.AUTH_ACCOUNT_RATE_LIMIT_MAX_ATTEMPTS ?? "1000",
  PORT: process.env.API_PORT ?? process.env.PORT ?? "3001"
};
const serverHealthUrl = `http://127.0.0.1:${serverEnvironment.PORT}/api/health`;
let child: ChildProcess | null = null;
let stopping = false;
let restarting = false;
let lastToken = await readToken();

await mkdir(dirname(statePath), { recursive: true });
startServer();
await waitForHealth();
await writeState(`managed:${String(process.pid)}`);
const signalPoll = setInterval(() => {
  void checkRestartSignal();
}, 100);

process.on("SIGINT", () => {
  void shutdown(130);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});

function startServer(): void {
  child = spawn(
    "pnpm",
    ["--filter", "@fortnote/server", "exec", "tsx", "src/index.ts"],
    {
      detached: process.platform !== "win32",
      env: serverEnvironment,
      stdio: "inherit"
    }
  );
  child.once("exit", (code, signal) => {
    child = null;
    if (!stopping && !restarting) {
      console.error(
        `E2E API exited unexpectedly (${signal ?? String(code ?? "unknown")})`
      );
      process.exit(code ?? 1);
    }
  });
}

async function checkRestartSignal(): Promise<void> {
  if (stopping || restarting) {
    return;
  }
  const token = await readToken();
  if (!token || token === lastToken) {
    return;
  }
  lastToken = token;
  restarting = true;
  await writeState(`stopping:${token}`);
  await stopServer();
  await writeState(`starting:${token}`);
  startServer();
  await waitForHealth();
  await writeState(`ready:${token}:${String(process.pid)}`);
  restarting = false;
}

async function stopServer(): Promise<void> {
  const running = child;
  if (!running?.pid) {
    return;
  }
  const exited = new Promise<void>((resolveExit) => {
    running.once("exit", () => {
      resolveExit();
    });
  });
  if (process.platform === "win32") {
    running.kill("SIGTERM");
  } else {
    process.kill(-running.pid, "SIGTERM");
  }
  await Promise.race([
    exited,
    new Promise<void>((resolveTimeout) => {
      setTimeout(resolveTimeout, 5_000);
    })
  ]);
  if (child === running) {
    if (process.platform === "win32") {
      running.kill("SIGKILL");
    } else {
      process.kill(-running.pid, "SIGKILL");
    }
    await exited;
  }
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(serverHealthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // The replacement process has not bound its socket yet.
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 100);
    });
  }
  throw new Error("Replacement E2E API did not become healthy");
}

async function shutdown(code: number): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  clearInterval(signalPoll);
  await stopServer();
  await rm(statePath, { force: true });
  process.exit(code);
}

async function readToken(): Promise<string> {
  try {
    return (await readFile(restartPath, "utf8")).trim();
  } catch {
    return "";
  }
}

async function writeState(state: string): Promise<void> {
  await writeFile(statePath, state, "utf8");
}
