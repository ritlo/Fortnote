import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const script = path.join(repositoryRoot, "scripts/inventory-assurance.mjs");
const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

describe("assurance inventory CLI", () => {
  it("generates exact coverage with stable path-and-heading IDs", () => {
    const fixture = createFixture({
      "alpha/spec.md": spec(
        ["First protected outcome", "Second protected outcome"],
        [["First succeeds"], ["Second succeeds", "Second recovers"]]
      )
    });

    writeInventory(fixture);
    const first = inventory(fixture);
    expect(first).toHaveLength(5);
    expect(new Set(first.map((item) => item.id))).toHaveLength(5);
    expect(first.filter((item) => item.kind === "scenario")).toHaveLength(3);
    expect(first.filter((item) => item.kind === "scenario").every((item) =>
      first.some((parent) => parent.id === item.parentId && parent.kind === "requirement")
    )).toBe(true);

    writeSpec(fixture, "alpha/spec.md", spec(
      ["Inserted outcome", "First protected outcome", "Second protected outcome"],
      [[], ["First succeeds"], ["Second succeeds", "Second recovers"]]
    ));
    writeInventory(fixture);
    const second = inventory(fixture);
    for (const heading of ["First protected outcome", "Second protected outcome", "First succeeds"]) {
      expect(second.find((item) => item.heading === heading)?.id)
        .toBe(first.find((item) => item.heading === heading)?.id);
    }
  });

  it("reports heading drift and exact missing inventory coverage", () => {
    const fixture = createFixture({
      "alpha/spec.md": spec(["Durable outcome"], [["Original scenario"]])
    });
    writeInventory(fixture);
    writeSpec(fixture, "alpha/spec.md", spec(
      ["Durable outcome", "New outcome"],
      [["Renamed scenario"], []]
    ));

    const result = checkInventory(fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/drift/iu);
    expect(result.output).toContain("Original scenario");
    expect(result.output).toContain("Renamed scenario");
    expect(result.output).toContain("New outcome");
  });

  it("rejects duplicate IDs, missing parents, stale paths, and malformed rows", () => {
    const fixture = createFixture({
      "alpha/spec.md": spec(["Protected outcome"], [["Protected scenario"]])
    });
    writeInventory(fixture);
    const ledger = ledgerAt(fixture);
    const document = JSON.parse(readFileSync(ledger, "utf8")) as InventoryDocument;
    const [requirement, scenario] = document.sourceInventory;
    document.sourceInventory = [
      requirement!,
      { ...scenario!, id: requirement!.id, parentId: "missing-parent" },
      {
        id: "stale-row",
        kind: "requirement",
        source: "openspec/specs/missing/spec.md"
      }
    ];
    writeFileSync(ledger, `${JSON.stringify(document, null, 2)}\n`);

    const result = checkInventory(fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/duplicate/iu);
    expect(result.output).toMatch(/missing-parent/iu);
    expect(result.output).toMatch(/stale|missing\/spec\.md/iu);
    expect(result.output).toMatch(/malformed|heading/iu);
  });
});

interface InventoryItem {
  heading?: string;
  id: string;
  kind: "requirement" | "scenario";
  parentId?: string;
  source: string;
}

interface InventoryDocument {
  sourceInventory: InventoryItem[];
}

function createFixture(specs: Record<string, string>): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fortnote-inventory-"));
  temporaryDirectories.push(directory);
  Object.entries(specs).forEach(([relativePath, contents]) => {
    writeSpec(directory, relativePath, contents);
  });
  return directory;
}

function writeSpec(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, "openspec/specs", relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function writeInventory(root: string): void {
  execFileSync(process.execPath, [
    script,
    "--spec-root", path.join(root, "openspec/specs"),
    "--ledger", ledgerAt(root),
    "--write"
  ], { cwd: repositoryRoot, encoding: "utf8" });
}

function checkInventory(root: string): { output: string; status: number | null } {
  const result = spawnSync(process.execPath, [
    script,
    "--spec-root", path.join(root, "openspec/specs"),
    "--ledger", ledgerAt(root),
    "--check"
  ], { cwd: repositoryRoot, encoding: "utf8" });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

function inventory(root: string): InventoryItem[] {
  return (JSON.parse(readFileSync(ledgerAt(root), "utf8")) as InventoryDocument).sourceInventory;
}

function ledgerAt(root: string): string {
  return path.join(root, "assurance.json");
}

function spec(requirements: string[], scenarios: string[][]): string {
  return [
    "# Fixture specification",
    "",
    "## Requirements",
    "",
    ...requirements.flatMap((requirement, index) => [
      `### Requirement: ${requirement}`,
      "The system MUST preserve this outcome.",
      "",
      ...(scenarios[index] ?? []).flatMap((scenario) => [
        `#### Scenario: ${scenario}`,
        "- **WHEN** the action runs",
        "- **THEN** the outcome remains protected",
        ""
      ])
    ])
  ].join("\n");
}
