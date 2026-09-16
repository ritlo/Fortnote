import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const inspector = path.join(repositoryRoot, "scripts/inspect-confidentiality.mjs");
const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

describe("confidentiality inspection CLI", () => {
  it.each([
    "database-dump",
    "ciphertext-files",
    "http",
    "websocket",
    "logs",
    "browser-storage"
  ] as const)(
    "detects a client-only canary in %s without copying it into the report",
    (surface) => {
      const fixture = createFixture(surface);

      const result = inspect(fixture);
      const reportText = readFileSync(fixture.report, "utf8");
      const report = JSON.parse(reportText) as InspectionReport;

      expect(result.status).not.toBe(0);
      expect(report.result).toBe("fail");
      expect(report.inspected).toContain(surface);
      expect(report.findings).toContainEqual(expect.objectContaining({ surface }));
      expect(reportText).not.toContain(fixture.canary);
      expect(reportText).not.toContain(fixture.protectedPayload);
    }
  );

  it("passes after inspecting every declared surface when no canary is present", () => {
    const fixture = createFixture(null);

    const result = inspect(fixture);
    const report = JSON.parse(readFileSync(fixture.report, "utf8")) as InspectionReport;

    expect(result.status).toBe(0);
    expect(report).toMatchObject({ result: "pass", findings: [] });
    expect(report.inspected).toEqual([
      "database-dump",
      "ciphertext-files",
      "http",
      "websocket",
      "logs",
      "browser-storage"
    ]);
  });
});

type Surface =
  | "database-dump"
  | "ciphertext-files"
  | "http"
  | "websocket"
  | "logs"
  | "browser-storage";

interface Fixture {
  browserStorage: string;
  canary: string;
  canaryFile: string;
  ciphertextDirectory: string;
  databaseDump: string;
  http: string;
  logs: string;
  protectedPayload: string;
  report: string;
  websocket: string;
}

interface InspectionReport {
  result: "pass" | "fail";
  inspected: Surface[];
  findings: { surface: Surface; location: string }[];
}

function createFixture(leakingSurface: Surface | null): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "fortnote-inspection-"));
  temporaryDirectories.push(root);
  const canary = `fortnote-canary-${crypto.randomUUID()}`;
  const protectedPayload = `protected-payload-${crypto.randomUUID()}`;
  const leakedValue = `${canary} ${protectedPayload}`;
  const cleanValue = "ciphertext-only-4f0d8a";
  const fixture: Fixture = {
    browserStorage: path.join(root, "browser-storage.json"),
    canary,
    canaryFile: path.join(root, "canaries.txt"),
    ciphertextDirectory: path.join(root, "ciphertext"),
    databaseDump: path.join(root, "assurance-dump.sql"),
    http: path.join(root, "http.json"),
    logs: path.join(root, "service.log"),
    protectedPayload,
    report: path.join(root, "inspection-report.json"),
    websocket: path.join(root, "websocket.json")
  };

  writeFileSync(fixture.canaryFile, `${canary}\n${protectedPayload}\n`);
  mkdirSync(fixture.ciphertextDirectory, { recursive: true });
  writeFileSync(
    path.join(fixture.ciphertextDirectory, "chunk.bin"),
    leakingSurface === "ciphertext-files" ? leakedValue : cleanValue
  );
  writeFileSync(
    fixture.http,
    JSON.stringify([{ body: leakingSurface === "http" ? leakedValue : cleanValue }])
  );
  writeFileSync(
    fixture.websocket,
    JSON.stringify([
      { payload: leakingSurface === "websocket" ? leakedValue : cleanValue }
    ])
  );
  writeFileSync(fixture.logs, leakingSurface === "logs" ? leakedValue : cleanValue);
  writeFileSync(
    fixture.browserStorage,
    JSON.stringify({
      indexedDb: leakingSurface === "browser-storage" ? leakedValue : cleanValue
    })
  );
  writeFileSync(
    fixture.databaseDump,
    [
      "COPY public.notes (id, title_cipher) FROM stdin;",
      `note-1\t${leakingSurface === "database-dump" ? leakedValue : cleanValue}`,
      "\\.",
      ""
    ].join("\n")
  );
  return fixture;
}

function inspect(fixture: Fixture) {
  return spawnSync(
    process.execPath,
    [
      inspector,
      "--canary-file",
      fixture.canaryFile,
      "--database-dump",
      fixture.databaseDump,
      "--ciphertext-files",
      fixture.ciphertextDirectory,
      "--http",
      fixture.http,
      "--websocket",
      fixture.websocket,
      "--logs",
      fixture.logs,
      "--browser-storage",
      fixture.browserStorage,
      "--report",
      fixture.report
    ],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
}
