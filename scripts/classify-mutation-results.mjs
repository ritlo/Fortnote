#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const reportPath = path.resolve(
  "specs/001-collaboration-design-assurance/evidence/mutation-results.json"
);
const report = JSON.parse(await readFile(reportPath, "utf8"));
const mutants = Object.values(report.files ?? {}).flatMap((file) => file.mutants ?? []);
const survivors = mutants.filter((mutant) => mutant.status === "Survived");
const uncovered = mutants.filter((mutant) => mutant.status === "NoCoverage");

if (survivors.length > 0) {
  throw new Error(
    `${String(survivors.length)} mutation survivor(s) require an explicit equivalent classification and rationale`
  );
}

if (uncovered.length > 0) {
  throw new Error(
    `${String(uncovered.length)} critical mutation(s) were not covered by the isolated test suite`
  );
}

report.assuranceClassification = {
  equivalentMutants: [],
  rationale: "No mutants survived, so no equivalent-mutant classification was required.",
  reviewedAt: new Date().toISOString(),
  summary: Object.fromEntries(
    ["Killed", "Survived", "NoCoverage", "Timeout", "RuntimeError", "Ignored"].map((status) => [
      status,
      mutants.filter((mutant) => mutant.status === status).length
    ])
  )
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
