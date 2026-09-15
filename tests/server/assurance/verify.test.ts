import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAssuranceArtifacts } from "../../../scripts/verify-assurance.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

describe("assurance artifact verifier", () => {
  it("accepts tracked mutation evidence without non-equivalent survivors", () => {
    const root = fixtureRoot({ mutants: [{ id: "guard", status: "Killed" }] });

    expect(verifyAssuranceArtifacts(root)).toEqual([]);
  });

  it("rejects a missing mutation artifact", () => {
    const root = fixtureRoot();

    expect(verifyAssuranceArtifacts(root)).toContain(
      "Mutation artifact is missing: specs/001-collaboration-design-assurance/evidence/mutation-results.json"
    );
  });

  it("rejects malformed mutation evidence", () => {
    const root = fixtureRoot("not-json");

    expect(verifyAssuranceArtifacts(root).join(" ")).toMatch(/not valid JSON/iu);
  });

  it("rejects a non-equivalent mutation survivor", () => {
    const root = fixtureRoot({
      mutants: [{ id: "guard", status: "Survived", equivalent: false }]
    });

    expect(verifyAssuranceArtifacts(root)).toContain(
      "Mutation artifact contains a non-equivalent survivor."
    );
  });
});

function fixtureRoot(mutationArtifact?: object | string): string {
  const root = mkdtempSync(path.join(tmpdir(), "fortnote-assurance-artifacts-"));
  temporaryDirectories.push(root);
  if (mutationArtifact === undefined) return root;
  const directory = path.join(root, "specs/001-collaboration-design-assurance/evidence");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "mutation-results.json"),
    typeof mutationArtifact === "string"
      ? mutationArtifact
      : JSON.stringify(mutationArtifact)
  );
  return root;
}
