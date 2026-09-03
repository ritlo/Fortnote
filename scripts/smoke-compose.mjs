import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const composeFile = path.join(repositoryRoot, "compose.postgres.yaml");
const containerEngine = selectContainerEngine(
  process.env.FORTNOTE_CONTAINER_ENGINE
);
const projectName = `fortnote-smoke-${String(process.pid)}-${String(Date.now())}`;
const port = smokePort(
  process.env.FORTNOTE_SMOKE_PORT,
  "FORTNOTE_SMOKE_PORT",
  32_000 + (process.pid % 10_000)
);
const postgresPort = smokePort(
  process.env.FORTNOTE_SMOKE_POSTGRES_PORT,
  "FORTNOTE_SMOKE_POSTGRES_PORT",
  52_000 + (process.pid % 10_000)
);
if (postgresPort === port) {
  throw new Error("The application and PostgreSQL smoke ports must differ");
}
const baseUrl = `http://127.0.0.1:${String(port)}`;
const databasePassword = crypto.randomBytes(24).toString("hex");
const composeEnvironment = {
  ...process.env,
  FORTNOTE_ALLOWED_ORIGIN: baseUrl,
  FORTNOTE_COOKIE_SECURE: "false",
  FORTNOTE_DATABASE_URL:
    `postgresql://fortnote:${encodeURIComponent(databasePassword)}` +
    "@postgres:5432/fortnote",
  FORTNOTE_PORT: String(port),
  FORTNOTE_POSTGRES_PORT: String(postgresPort),
  FORTNOTE_POSTGRES_PASSWORD: databasePassword
};
const composeArguments = [
  "compose",
  "--project-name",
  projectName,
  "--file",
  composeFile
];

let composeStarted = false;
let cleanupPromise = null;
let interrupted = false;

process.once("SIGINT", () => handleSignal("SIGINT", 130));
process.once("SIGTERM", () => handleSignal("SIGTERM", 143));

try {
  composeStarted = true;
  await compose("up", "--detach", "--build");
  await expectServiceRunning("postgres");
  await expectServiceRunning("app");
  await waitUntilReady();
  await compose(
    "exec",
    "-T",
    "app",
    "node",
    "--eval",
    "if (process.getuid?.() === 0) process.exit(1)"
  );

  const username = `smoke-${crypto.randomUUID()}`;
  const registration = await jsonRequest("/api/auth/register", {
    method: "POST",
    body: registrationPayload(username),
    expectedStatus: 201
  });
  const firstCookie = sessionCookie(registration.response);
  const note = await jsonRequest("/api/notes", {
    method: "POST",
    body: notePayload(),
    cookie: firstCookie,
    expectedStatus: 201
  });
  const noteId = requiredString(note.body.id, "created note ID");
  const attachmentId = crypto.randomUUID();
  const ciphertext = crypto.randomBytes(640 * 1024 + 17);

  await binaryRequest(`/api/notes/${noteId}/attachments`, {
    method: "POST",
    body: ciphertext,
    cookie: firstCookie,
    expectedStatus: 201,
    headers: {
      "content-length": String(ciphertext.length),
      "content-type": "application/octet-stream",
      "x-fortnote-attachment-id": attachmentId,
      "x-fortnote-size": String(ciphertext.length),
      "x-fortnote-expected-key-epoch": "1",
      "x-fortnote-metadata-cipher": "compose_smoke_attachment_metadata_cipher",
      "x-fortnote-metadata-nonce": "compose_smoke_attachment_metadata_nonce",
      "x-fortnote-metadata-format-version": "2",
      "x-fortnote-encrypted-attachment-key":
        "compose_smoke_encrypted_attachment_key",
      "x-fortnote-attachment-key-nonce": "compose_smoke_attachment_key_nonce",
      "x-fortnote-file-nonce": "compose_smoke_attachment_file_nonce"
    }
  });
  expectBytes(
    await binaryRequest(`/api/attachments/${attachmentId}`, {
      cookie: firstCookie,
      expectedStatus: 200
    }),
    ciphertext
  );

  await compose("restart", "--timeout", "20", "app");
  await waitUntilReady();
  const logs = await composeLogs("app");
  if (!logs.includes("Fortnote received SIGTERM; shutting down")) {
    throw new Error("Application restart did not record graceful SIGTERM shutdown");
  }

  const login = await jsonRequest("/api/auth/login", {
    method: "POST",
    body: {
      username,
      authVerifier: registrationPayload(username).authVerifier
    },
    expectedStatus: 200
  });
  const restartedCookie = sessionCookie(login.response);
  await jsonRequest(`/api/notes/${noteId}`, {
    cookie: restartedCookie,
    expectedStatus: 200
  });
  expectBytes(
    await binaryRequest(`/api/attachments/${attachmentId}`, {
      cookie: restartedCookie,
      expectedStatus: 200
    }),
    ciphertext
  );

} catch (error) {
  if (composeStarted) {
    const logs = await composeLogs().catch(() => "");
    if (logs) {
      console.error(logs);
    }
  }
  throw error;
} finally {
  await cleanup();
}
console.log("Fortnote Compose smoke test passed");

async function cleanup() {
  if (!composeStarted) {
    return;
  }
  cleanupPromise ??= (async () => {
    await compose(
      "down",
      "--volumes",
      "--remove-orphans",
      "--timeout",
      "20",
      ...(containerEngine === "docker" ? ["--rmi", "local"] : [])
    );
    if (containerEngine === "podman") {
      await run(
        containerEngine,
        ["network", "rm", "--force", `${projectName}_default`],
        false
      );
      await run(
        containerEngine,
        ["image", "rm", "--ignore", `${projectName}_app`],
        false
      );
    }
  })();
  await cleanupPromise;
}

async function expectServiceRunning(service) {
  const containerId = await run(
    containerEngine,
    [
      "ps",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "--filter",
      `label=com.docker.compose.service=${service}`
    ],
    true
  );
  if (!containerId.trim()) {
    throw new Error(`Compose service did not start: ${service}`);
  }
}

function handleSignal(signal, exitCode) {
  if (interrupted) {
    return;
  }
  interrupted = true;
  void cleanup().then(
    () => process.exit(exitCode),
    (error) => {
      console.error(`Smoke-test cleanup failed after ${signal}`, error);
      process.exit(1);
    }
  );
}

function compose(...arguments_) {
  return run(containerEngine, [...composeArguments, ...arguments_], false);
}

function composeOutput(...arguments_) {
  return run(containerEngine, [...composeArguments, ...arguments_], true);
}

function composeLogs(service) {
  return composeOutput(
    "logs",
    ...(containerEngine === "docker" ? ["--no-color"] : []),
    ...(service ? [service] : [])
  );
}

function run(command, arguments_, captureOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: composeEnvironment,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    const output = [];
    if (captureOutput) {
      child.stdout.on("data", (value) => output.push(Buffer.from(value)));
      child.stderr.on("data", (value) => output.push(Buffer.from(value)));
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(output).toString("utf8"));
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

async function waitUntilReady() {
  const deadline = Date.now() + 180_000;
  let lastStatus = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/ready`);
      lastStatus = `HTTP ${String(response.status)}`;
      if (response.ok && (await response.json()).ok === true) {
        return;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Application readiness timed out: ${lastStatus}`);
}

async function jsonRequest(
  pathname,
  { method = "GET", body, cookie, expectedStatus }
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: requestHeaders(cookie, body === undefined ? {} : {
      "content-type": "application/json"
    }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  await expectStatus(response, expectedStatus);
  return { response, body: await response.json() };
}

async function binaryRequest(
  pathname,
  { method = "GET", body, cookie, expectedStatus, headers = {} }
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: requestHeaders(cookie, headers),
    ...(body === undefined ? {} : { body })
  });
  await expectStatus(response, expectedStatus);
  return Buffer.from(await response.arrayBuffer());
}

function requestHeaders(cookie, headers) {
  return {
    origin: baseUrl,
    "sec-fetch-site": "same-origin",
    ...(cookie ? { cookie } : {}),
    ...headers
  };
}

async function expectStatus(response, expectedStatus) {
  if (response.status === expectedStatus) {
    return;
  }
  const detail = await response.text();
  throw new Error(
    `${response.url} returned HTTP ${String(response.status)}; expected ` +
      `${String(expectedStatus)}: ${detail}`
  );
}

function expectBytes(actual, expected) {
  if (!actual.equals(expected)) {
    throw new Error(
      `Attachment ciphertext mismatch: received ${String(actual.length)} of ` +
        `${String(expected.length)} expected bytes`
    );
  }
}

function sessionCookie(response) {
  const value = response.headers.get("set-cookie");
  if (!value) {
    throw new Error("Authentication response did not set a session cookie");
  }
  return value.split(";", 1)[0];
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function smokePort(value, variableName, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_024 || parsed > 65_535) {
    throw new Error(
      `${variableName} must be an integer from 1024 through 65535`
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
    const composeProvider = spawnSync(candidate, ["compose", "version"], {
      stdio: "ignore"
    });
    if (runtime.status === 0 && composeProvider.status === 0) {
      return candidate;
    }
  }
  throw new Error(
    "Docker or Podman with a Compose provider is required for this smoke test"
  );
}

function registrationPayload(username) {
  return {
    username,
    authVerifier: `smoke_auth_verifier_${username}_abcdefghijklmnopqrstuvwxyz`,
    authKdf: {
      salt: `smoke_auth_salt_${username}_abcdefghijklmnopqrstuvwxyz`,
      opsLimit: 4,
      memLimit: 67_108_864,
      version: 1
    },
    vaultKdf: {
      salt: `smoke_vault_salt_${username}_abcdefghijklmnopqrstuvwxyz`,
      opsLimit: 4,
      memLimit: 67_108_864,
      version: 1
    },
    encryptedRootKey: `smoke_encrypted_root_key_${username}_abcdefghijklmnopqrstuvwxyz`,
    rootKeyNonce: `smoke_root_key_nonce_${username}_abcdefghijklmnopqrstuvwxyz`,
    recoveryAuthVerifier:
      `smoke_recovery_auth_verifier_${username}_abcdefghijklmnopqrstuvwxyz`,
    recoveryKdf: {
      salt: `smoke_recovery_salt_${username}_abcdefghijklmnopqrstuvwxyz`,
      opsLimit: 4,
      memLimit: 67_108_864,
      version: 1
    },
    recoveryEncryptedRootKey:
      `smoke_recovery_root_key_${username}_abcdefghijklmnopqrstuvwxyz`,
    recoveryRootKeyNonce:
      `smoke_recovery_root_nonce_${username}_abcdefghijklmnopqrstuvwxyz`
  };
}

function notePayload() {
  return {
    id: crypto.randomUUID(),
    folderId: null,
    title: "Compose smoke encrypted note",
    encryptedNoteKey: "compose_smoke_encrypted_note_key_abcdefghijklmnopqrstuvwxyz",
    noteKeyNonce: "compose_smoke_note_key_nonce_abcdefghijklmnopqrstuvwxyz",
    contentCipher: "compose_smoke_content_cipher_abcdefghijklmnopqrstuvwxyz",
    contentNonce: "compose_smoke_content_nonce_abcdefghijklmnopqrstuvwxyz",
    contentLength: 128
  };
}
