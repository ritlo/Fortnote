import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const verifier = path.join(repositoryRoot, "scripts/verify-assurance.mjs");
const schema = path.join(
  repositoryRoot,
  "specs/001-collaboration-design-assurance/contracts/assurance-record.schema.json"
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { force: true, recursive: true });
  });
});

describe("assurance verifier CLI", () => {
  it.each(["fail", "blocked"] as const)("rejects %s required evidence", (result) => {
    const record = validRecord();
    record.evidence[0]!.result = result;

    expectFailure(record, new RegExp(`evidence.*${result}`, "iu"));
  });

  it.each(["critical", "high"] as const)("rejects open %s findings", (severity) => {
    const record = validRecord();
    record.sourceInventory[0]!.evidenceIds = [];
    record.sourceInventory[0]!.findingIds = ["finding.open"];
    record.findings = [finding({ severity })];

    expectFailure(record, new RegExp(`${severity}.*open|open.*${severity}`, "iu"));
  });

  it("rejects invalid and expired accepted-risk exceptions", () => {
    const invalid = acceptedRecord();
    invalid.exceptions[0]!.approver = "";
    expectFailure(invalid, /exception.*approver|approver.*required/iu);

    const expired = acceptedRecord();
    expired.exceptions[0]!.expiresAt = "2025-01-01T00:00:00.000Z";
    expectFailure(expired, /exception.*expired|expired.*exception/iu);
  });

  it("requires distinct passing manual accessibility evidence", () => {
    const record = validRecord();
    record.evidence = record.evidence.filter((evidence) => evidence.layer !== "manual");
    record.sourceInventory[0]!.evidenceIds = record.sourceInventory[0]!.evidenceIds.filter(
      (id) => id !== "evidence.manual"
    );

    expectFailure(record, /manual.*accessibility|accessibility.*manual/iu);
  });

  it("rejects non-equivalent critical mutation survivors", () => {
    const record = validRecord();
    expectFailure(record, /mutation.*survivor|survivor.*mutation/iu, {
      "evidence/mutation.json": JSON.stringify({
        mutants: [{ id: "critical-guard", status: "Survived", equivalent: false }]
      })
    });
  });

  it("rejects failed budgets, regressions, incomplete metrics, and environment mismatch", () => {
    const failedBudget = validRecord();
    failedBudget.performance.runs[0]!.metrics[0]!.budgetPassed = false;
    expectFailure(failedBudget, /performance.*budget|budget.*failed/iu);

    const failedRegression = validRecord();
    failedRegression.performance.runs[0]!.metrics[0]!.regressionPassed = false;
    expectFailure(failedRegression, /performance.*regression|regression.*failed/iu);

    const incomplete = validRecord();
    incomplete.performance.runs[0]!.metrics.pop();
    expectFailure(incomplete, /performance.*six|metrics.*6|schema/iu);

    const mismatched = validRecord();
    mismatched.performance.runs[0]!.equivalentEnvironment = false;
    expectFailure(mismatched, /environment.*equivalent|not equivalent/iu);
  });
});

type Result = "pass" | "fail" | "blocked";
type Severity = "critical" | "high" | "medium" | "low";

interface AssuranceRecord {
  schemaVersion: number;
  featureId: string;
  sourceInventory: InventoryItem[];
  evidence: Evidence[];
  findings: Finding[];
  exceptions: ExceptionRecord[];
  performance: Performance;
}

interface InventoryItem {
  id: string;
  kind: "requirement";
  source: string;
  heading: string;
  priority: Severity;
  outcome: string;
  evidenceIds: string[];
  findingIds: string[];
}

interface Evidence {
  id: string;
  requirementIds: string[];
  layer: string;
  command: string;
  testReference: string;
  environment: Record<string, string>;
  result: Result;
  limitations: string[];
  artifact?: string;
  commit: string;
  recordedAt: string;
}

interface Finding {
  id: string;
  requirementIds: string[];
  severity: Severity;
  status: "open" | "accepted";
  reproduction: string;
  userImpact: string;
  securityImpact: string;
  remediation: string;
  owner: string;
  verificationStatus: "not-run";
  evidenceIds: string[];
  exceptionId?: string;
}

interface ExceptionRecord {
  id: string;
  findingIds: string[];
  owner: string;
  approver: string;
  risk: string;
  reason: string;
  expiresAt: string;
  followUp: string;
}

interface Performance {
  environment: Record<string, string | number>;
  baseline: { commit: string; recordedAt: string; metrics: BaselineMetric[] };
  runs: { commit: string; recordedAt: string; equivalentEnvironment: boolean; metrics: RunMetric[] }[];
}

interface BaselineMetric {
  name: string;
  sampleCount: number;
  p95Ms: number;
  rawSamplesArtifact: string;
}

interface RunMetric extends BaselineMetric {
  budgetMs: number;
  baselineP95Ms: number;
  currentP95Ms: number;
  regressionPercent: number;
  budgetPassed: boolean;
  regressionPassed: boolean;
}

function validRecord(): AssuranceRecord {
  const evidence = [
    evidenceRecord("evidence.integration", "integration", "evidence/test.ts#passes"),
    evidenceRecord("evidence.accessibility", "accessibility", "evidence/a11y.ts#axe"),
    evidenceRecord("evidence.manual", "manual", "evidence/manual.md#assessment"),
    {
      ...evidenceRecord("evidence.mutation", "mutation", "evidence/mutation.test.ts#guards"),
      artifact: "evidence/mutation.json"
    }
  ];
  return {
    schemaVersion: 1,
    featureId: "001-collaboration-design-assurance",
    sourceInventory: [{
      id: "requirement.one",
      kind: "requirement",
      source: "openspec/specs/fixture/spec.md",
      heading: "Protected outcome",
      priority: "critical",
      outcome: "The protected outcome remains true.",
      evidenceIds: evidence.map(({ id }) => id),
      findingIds: []
    }],
    evidence,
    findings: [],
    exceptions: [],
    performance: performanceRecord()
  };
}

function acceptedRecord(): AssuranceRecord {
  const record = validRecord();
  record.findings = [finding({
    id: "finding.accepted",
    severity: "medium",
    status: "accepted",
    exceptionId: "exception.accepted"
  })];
  record.exceptions = [{
    id: "exception.accepted",
    findingIds: ["finding.accepted"],
    owner: "owner",
    approver: "approver",
    risk: "Bounded usability risk.",
    reason: "Scheduled follow-up.",
    expiresAt: "2099-01-01T00:00:00.000Z",
    followUp: "Resolve before expiry."
  }];
  return record;
}

function evidenceRecord(id: string, layer: string, testReference: string): Evidence {
  return {
    id,
    requirementIds: ["requirement.one"],
    layer,
    command: "pnpm test",
    testReference,
    environment: { os: "linux", node: "26", database: "sqlite", dataset: "fixture" },
    result: "pass",
    limitations: [],
    commit: "abcdef1",
    recordedAt: "2026-07-20T00:00:00.000Z"
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding.open",
    requirementIds: ["requirement.one"],
    severity: "critical",
    status: "open",
    reproduction: "Run the focused check.",
    userImpact: "The protected outcome can fail.",
    securityImpact: "The boundary is not proven.",
    remediation: "Implement and rerun the check.",
    owner: "owner",
    verificationStatus: "not-run",
    evidenceIds: [],
    ...overrides
  };
}

function performanceRecord(): Performance {
  const names = [
    "local-feedback",
    "note-usable",
    "large-note-usable",
    "section-usable",
    "authenticated-action",
    "collaborator-visible"
  ];
  const baseline = names.map((name) => ({
    name,
    sampleCount: 20,
    p95Ms: 100,
    rawSamplesArtifact: `evidence/${name}-baseline.json`
  }));
  const run = baseline.map((metric) => ({
    ...metric,
    budgetMs: 200,
    baselineP95Ms: 100,
    currentP95Ms: 105,
    regressionPercent: 5,
    budgetPassed: true,
    regressionPassed: true,
    rawSamplesArtifact: `evidence/${metric.name}-run.json`
  }));
  return {
    environment: {
      os: "linux",
      cpu: "fixture",
      node: "26",
      browser: "chromium",
      buildMode: "production",
      database: "sqlite",
      dataset: "fixture",
      collaborators: 3,
      warmupRuns: 1
    },
    baseline: { commit: "abcdef1", recordedAt: "2026-07-20T00:00:00.000Z", metrics: baseline },
    runs: [{
      commit: "abcdef2",
      recordedAt: "2026-07-20T01:00:00.000Z",
      equivalentEnvironment: true,
      metrics: run
    }]
  };
}

function expectFailure(
  record: AssuranceRecord,
  pattern: RegExp,
  artifacts: Record<string, string> = {}
): void {
  const fixture = mkdtempSync(path.join(tmpdir(), "fortnote-verify-"));
  temporaryDirectories.push(fixture);
  const files: Record<string, string> = {
    "openspec/specs/fixture/spec.md": "### Requirement: Protected outcome\n",
    "evidence/test.ts": "test('passes', () => undefined);\n",
    "evidence/a11y.ts": "test('axe', () => undefined);\n",
    "evidence/manual.md": "# Assessment\n",
    "evidence/mutation.test.ts": "test('guards', () => undefined);\n",
    "evidence/mutation.json": JSON.stringify({ mutants: [] }),
    ...artifacts
  };
  for (const metric of [
    ...record.performance.baseline.metrics,
    ...(record.performance.runs[0]?.metrics ?? [])
  ]) {
    files[metric.rawSamplesArtifact] = JSON.stringify(Array.from({ length: 20 }, () => 100));
  }
  Object.entries(files).forEach(([relativePath, contents]) => {
    const target = path.join(fixture, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  });
  const ledger = path.join(fixture, "assurance.json");
  writeFileSync(ledger, `${JSON.stringify(record, null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    verifier,
    "--root", fixture,
    "--ledger", ledger,
    "--schema", schema,
    "--now", "2026-07-20T12:00:00.000Z"
  ], { cwd: repositoryRoot, encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status).not.toBe(0);
  expect(output).toMatch(pattern);
}
