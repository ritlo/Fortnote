import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";

interface ManagedServer {
  name: string;
  child: ChildProcess;
  gracefulShutdownMs: number;
}

// Playwright's webServer probe connects to the port before launching. Where a
// closed localhost port drops packets instead of refusing (WSL2 mirrored
// networking), that probe waits out the kernel connect timeout (~2 minutes)
// per server, so these servers are started here with bounded checks instead.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const apiPort = Number(process.env.API_PORT ?? 3101);
  const clientPort = Number(process.env.CLIENT_PORT ?? 5273);
  const productionPerformance = process.env.FORTNOTE_PERFORMANCE_BUILD === "1";
  const env = {
    ...process.env,
    API_PORT: String(apiPort),
    CLIENT_PORT: String(clientPort),
    PORT: String(apiPort)
  };

  await Promise.all([assertPortFree(apiPort), assertPortFree(clientPort)]);
  if (!productionPerformance) {
    // The dev servers import @fortnote/shared from its build output, which a
    // fresh checkout does not have. The performance run builds everything first.
    buildSharedPackage();
  }
  const servers: ManagedServer[] = [];
  const teardown = async () => {
    for (const server of servers.reverse()) {
      await stopServer(server);
    }
  };

  try {
    servers.push(
      startServer(
        "API",
        productionPerformance
          ? "node apps/server/dist/index.js"
          : "pnpm exec tsx tests/e2e/support/runE2eServer.ts",
        env,
        10_000
      )
    );
    await waitForHttp(`http://127.0.0.1:${String(apiPort)}/api/health`, servers[0]);

    servers.push(
      startServer(
        "client",
        productionPerformance
          ? `pnpm --filter @fortnote/client preview --host 127.0.0.1 --port ${String(clientPort)}`
          : `pnpm --filter @fortnote/client dev --host 127.0.0.1 --port ${String(clientPort)}`,
        env,
        0
      )
    );
    await waitForHttp(`http://127.0.0.1:${String(clientPort)}`, servers[1]);
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}

function buildSharedPackage(): void {
  const result = spawnSync("pnpm", ["build:shared"], {
    stdio: ["ignore", "ignore", "inherit"]
  });
  if (result.status !== 0) {
    throw new Error("Building @fortnote/shared failed", { cause: result.error });
  }
}

function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      reject(new Error(`Port ${String(port)} is already in use`, { cause: error }));
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => {
        resolve();
      });
    });
  });
}

function startServer(
  name: string,
  command: string,
  env: NodeJS.ProcessEnv,
  gracefulShutdownMs: number
): ManagedServer {
  const child = spawn(command, {
    detached: process.platform !== "win32",
    env,
    shell: true,
    stdio: ["ignore", "ignore", "inherit"]
  });
  return { name, child, gracefulShutdownMs };
}

async function waitForHttp(url: string, server: ManagedServer): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `${server.name} server exited early (${String(server.child.exitCode)})`
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status < 500) {
        return;
      }
    } catch {
      // Not listening yet, or the connection attempt was dropped.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${server.name} server did not become available at ${url}`);
}

async function stopServer(server: ManagedServer): Promise<void> {
  const { child } = server;
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
  signalGroup(child, server.gracefulShutdownMs > 0 ? "SIGTERM" : "SIGKILL");
  if (server.gracefulShutdownMs > 0) {
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          resolve(true);
        }, server.gracefulShutdownMs)
      )
    ]);
    if (timedOut) {
      signalGroup(child, "SIGKILL");
    }
  }
  await exited;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
    }
  } catch {
    // The process group has already exited.
  }
}
