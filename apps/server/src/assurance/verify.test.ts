import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_ASSURANCE_COMMANDS,
  verifyAssuranceSummary
} from "../../../../scripts/verify-assurance.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

describe("assurance summary verifier", () => {
  it("accepts concrete automated outcomes with explicit limitations", () => {
    const root = fixtureRoot();
    const summary = validSummary().replace(
      "| `pnpm e2e` | PASS |",
      "| `pnpm e2e` | 9 failed / 9 passed / 1 skipped |"
    );

    expect(verifyAssuranceSummary(summary, root)).toEqual([]);
  });

  it("rejects a missing or placeholder command result", () => {
    const root = fixtureRoot();
    const summary = validSummary().replace("| `pnpm e2e` | PASS |", "| `pnpm e2e` | PENDING |");

    expect(verifyAssuranceSummary(summary, root)).toContain(
      "Assurance command lacks an actual result: pnpm e2e"
    );
  });

  it("requires personal-project scope limitations and known risks", () => {
    const root = fixtureRoot();
    const summary = validSummary()
      .replace("Manual screen-reader qualification was omitted.\n", "")
      .replace("The optional 100 MiB/20-sample performance qualification was omitted.\n", "")
      .replace("- Browser automation cannot prove every assistive-technology workflow.\n", "");

    expect(verifyAssuranceSummary(summary, root).join("\n")).toMatch(
      /known product risks.*manual screen-reader.*100 MiB\/20-sample/isu
    );
  });

  it("rejects a non-equivalent mutation survivor", () => {
    const root = fixtureRoot([{ id: "guard", status: "Survived", equivalent: false }]);

    expect(verifyAssuranceSummary(validSummary(), root)).toContain(
      "Mutation artifact contains a non-equivalent survivor."
    );
  });
});

function fixtureRoot(mutants: object[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), "fortnote-assurance-summary-"));
  temporaryDirectories.push(root);
  const directory = path.join(
    root,
    "specs/001-collaboration-design-assurance/evidence"
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "mutation-results.json"),
    JSON.stringify({ mutants })
  );
  return root;
}

function validSummary(): string {
  const checks = REQUIRED_ASSURANCE_COMMANDS
    .map((command) => `| \`${command}\` | PASS |`)
    .join("\n");
  return `# Assurance summary

## Automated checks

| Command | Result |
| --- | --- |
${checks}

Mutation evidence: specs/001-collaboration-design-assurance/evidence/mutation-results.json

## Known product risks

- Browser automation cannot prove every assistive-technology workflow.

## Scope limitations

Manual screen-reader qualification was omitted.
The optional 100 MiB/20-sample performance qualification was omitted.
`;
}
