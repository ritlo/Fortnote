#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const performanceBudgets = {
  "authenticated-action": 500,
  "collaborator-visible": 1_000,
  "large-note-usable": 5_000,
  "local-feedback": 100,
  "note-usable": 2_000,
  "section-usable": 2_000
};

export function nearestRankP95(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("nearestRankP95 requires finite samples");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

export function summarizePerformanceMetric(name, budgetMs, samples) {
  const durations = samples.map(({ durationMs }) => durationMs);
  const successes = samples.filter(({ result }) => result === "success").length;
  const successRate = samples.length === 0 ? 0 : successes / samples.length;
  const p95Ms = nearestRankP95(durations);
  const successRatePassed = successRate >= 0.95;
  return {
    name,
    budgetMs,
    budgetPassed: p95Ms <= budgetMs && successRatePassed,
    p95Ms,
    sampleCount: samples.length,
    successRate,
    successRatePassed
  };
}

export function verifyPerformanceMetrics(metrics, baselineP95Ms) {
  const errors = [];
  const byName = new Map(metrics.map((metric) => [metric.name, metric]));
  if (metrics.length !== 6 || byName.size !== 6) errors.push("Performance requires exactly six metrics.");
  for (const [name, budgetMs] of Object.entries(performanceBudgets)) {
    const metric = byName.get(name);
    if (!metric) {
      errors.push(`Performance metric ${name} is missing.`);
      continue;
    }
    if (metric.budgetMs !== budgetMs) errors.push(`Performance metric ${name} has the wrong budget.`);
    if (metric.sampleCount < 20) errors.push(`Performance metric ${name} requires at least 20 samples.`);
    if (metric.successRatePassed === false || (metric.successRate ?? 1) < 0.95) {
      errors.push(`Performance success rate failed for ${name}.`);
    }
    const baseline = baselineP95Ms[name];
    if (!Number.isFinite(baseline)) errors.push(`Performance baseline is missing for ${name}.`);
    else if (((metric.p95Ms - baseline) / baseline) * 100 > 10) {
      errors.push(`Performance regression exceeded 10 percent for ${name}.`);
    }
  }
  return { errors, passed: errors.length === 0 };
}

export function fingerprintPerformanceEnvironment(environment) {
  const normalized = Object.fromEntries(Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, ["browser", "node"].includes(key) ? majorVersion(value) : value]));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function majorVersion(value) {
  const match = String(value).match(/^(.*?)(\d+)(?:\.\d+)*$/u);
  return match ? `${match[1]}${match[2]}` : value;
}

function isDateTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function parseArguments(argv) {
  const options = {
    root: process.cwd(),
    ledger: undefined,
    schema: undefined,
    now: new Date()
  };
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${option ?? "argument"} requires a value`);
    if (option === "--root") options.root = path.resolve(value);
    else if (option === "--ledger") options.ledger = path.resolve(value);
    else if (option === "--schema") options.schema = path.resolve(value);
    else if (option === "--now") options.now = new Date(value);
    else throw new Error(`Unknown argument: ${option}`);
  }
  options.ledger ??= path.join(options.root, "specs/001-collaboration-design-assurance/assurance.json");
  options.schema ??= path.join(options.root, "specs/001-collaboration-design-assurance/contracts/assurance-record.schema.json");
  if (Number.isNaN(options.now.valueOf())) throw new Error("--now must be an ISO date-time");
  return options;
}

function resolveRepositoryPath(root, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) return undefined;
  const resolved = path.resolve(root, relativePath);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

function duplicateErrors(records, label) {
  const seen = new Set();
  const errors = [];
  for (const record of records) {
    if (seen.has(record.id)) errors.push(`Duplicate ${label} ID: ${record.id}`);
    seen.add(record.id);
  }
  return errors;
}

function referenceErrors(record, root, now) {
  const errors = [
    ...duplicateErrors(record.sourceInventory, "inventory"),
    ...duplicateErrors(record.evidence, "evidence"),
    ...duplicateErrors(record.findings, "finding"),
    ...duplicateErrors(record.exceptions, "exception")
  ];
  const requirements = new Map(record.sourceInventory.map((item) => [item.id, item]));
  const evidence = new Map(record.evidence.map((item) => [item.id, item]));
  const findings = new Map(record.findings.map((item) => [item.id, item]));
  const exceptions = new Map(record.exceptions.map((item) => [item.id, item]));

  for (const item of record.sourceInventory) {
    const source = resolveRepositoryPath(root, item.source);
    if (!source || !existsSync(source)) errors.push(`Inventory source path is stale: ${item.source}`);
    else if (!readFileSync(source, "utf8").includes(`${item.kind === "requirement" ? "###" : "####"} ${item.kind === "requirement" ? "Requirement" : "Scenario"}: ${item.heading}`)) {
      errors.push(`Inventory heading drift: ${item.heading} in ${item.source}`);
    }
    if (item.kind === "scenario" && (!item.parentId || requirements.get(item.parentId)?.kind !== "requirement")) {
      errors.push(`Inventory scenario ${item.id} has a missing requirement parent.`);
    }
    for (const id of item.evidenceIds) if (!evidence.has(id)) errors.push(`Inventory ${item.id} references missing evidence ${id}.`);
    for (const id of item.findingIds) if (!findings.has(id)) errors.push(`Inventory ${item.id} references missing finding ${id}.`);
    if (item.evidenceIds.length === 0 && item.findingIds.length === 0) errors.push(`Inventory ${item.id} has no evidence or finding.`);
  }

  for (const item of record.evidence) {
    for (const id of item.requirementIds) if (!requirements.has(id)) errors.push(`Evidence ${item.id} references missing requirement ${id}.`);
    if (item.result !== "pass") errors.push(`Required evidence ${item.id} is ${item.result}.`);
    errors.push(...testReferenceErrors(item, root));
    if (item.artifact && !existsRepositoryPath(root, item.artifact)) errors.push(`Evidence artifact is missing: ${item.artifact}`);
  }

  for (const item of record.findings) {
    for (const id of item.requirementIds) if (!requirements.has(id)) errors.push(`Finding ${item.id} references missing requirement ${id}.`);
    for (const id of item.evidenceIds) if (!evidence.has(id)) errors.push(`Finding ${item.id} references missing evidence ${id}.`);
    if (["critical", "high"].includes(item.severity) && item.status === "open") {
      errors.push(`${item.severity} finding ${item.id} remains open.`);
    }
    if (item.status === "accepted" && (!["medium", "low"].includes(item.severity) || !item.exceptionId)) {
      errors.push(`Finding ${item.id} has an invalid accepted-risk exception.`);
    }
    if (item.status === "remediated" && (item.verificationStatus !== "passed" || item.evidenceIds.length === 0)) {
      errors.push(`Remediated finding ${item.id} lacks passing verification evidence.`);
    }
    if (item.exceptionId && !exceptions.has(item.exceptionId)) errors.push(`Finding ${item.id} references missing exception ${item.exceptionId}.`);
  }

  for (const item of record.exceptions) {
    for (const field of ["owner", "approver", "risk", "reason", "followUp"]) {
      if (typeof item[field] !== "string" || item[field].trim() === "") errors.push(`Exception ${item.id} requires ${field}.`);
    }
    if (item.owner === item.approver) errors.push(`Exception ${item.id} requires an independent approver.`);
    if (!Number.isFinite(Date.parse(item.expiresAt)) || new Date(item.expiresAt) <= now) errors.push(`Exception ${item.id} is expired or invalid.`);
    for (const id of item.findingIds) {
      const finding = findings.get(id);
      if (!finding || finding.exceptionId !== item.id) errors.push(`Exception ${item.id} has an invalid finding reference ${id}.`);
    }
  }
  return errors;
}

function existsRepositoryPath(root, relativePath) {
  const resolved = resolveRepositoryPath(root, relativePath);
  return Boolean(resolved && existsSync(resolved));
}

function testReferenceErrors(evidence, root) {
  const [file, identity] = evidence.testReference.split("#", 2);
  const resolved = resolveRepositoryPath(root, file);
  if (!resolved || !existsSync(resolved)) return [`Evidence test path is missing: ${file}`];
  if (!identity) return [`Evidence test identity is missing: ${evidence.testReference}`];
  const normalizedIdentity = identity.replace(/[-_]/gu, " ").toLowerCase();
  const normalizedContents = readFileSync(resolved, "utf8").replace(/[-_]/gu, " ").toLowerCase();
  return normalizedContents.includes(normalizedIdentity) ? [] : [`Evidence test identity is stale: ${evidence.testReference}`];
}

function assuranceErrors(record, root, now) {
  const errors = referenceErrors(record, root, now);
  const passingLayers = new Set(record.evidence.filter(({ result }) => result === "pass").map(({ layer }) => layer));
  if (!passingLayers.has("accessibility") || !passingLayers.has("manual")) {
    errors.push("Distinct passing automated accessibility and manual accessibility evidence are required.");
  }
  for (const evidence of record.evidence.filter(({ layer, artifact }) => layer === "mutation" && artifact)) {
    const artifact = resolveRepositoryPath(root, evidence.artifact);
    if (!artifact || !existsSync(artifact)) continue;
    const mutation = JSON.parse(readFileSync(artifact, "utf8"));
    const survivor = findMutationSurvivor(mutation);
    if (survivor) errors.push(`Mutation survivor ${survivor.id ?? "unknown"} is non-equivalent.`);
  }
  if (record.performance && typeof record.performance === "object") {
    errors.push(...performanceRecordErrors(record.performance, root));
  }
  return errors;
}

function findMutationSurvivor(value) {
  if (!value || typeof value !== "object") return undefined;
  if (String(value.status).toLowerCase() === "survived" && value.equivalent !== true) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const survivor = findMutationSurvivor(child);
    if (survivor) return survivor;
  }
  return undefined;
}

function performanceRecordErrors(performance, root) {
  const errors = [];
  const baseline = Object.fromEntries(performance.baseline.metrics.map((metric) => [metric.name, metric.p95Ms]));
  for (const metric of performance.baseline.metrics) {
    if (!existsRepositoryPath(root, metric.rawSamplesArtifact)) errors.push(`Performance baseline artifact is missing: ${metric.rawSamplesArtifact}`);
  }
  for (const run of performance.runs) {
    if (!run.equivalentEnvironment) errors.push("Performance run environment is not equivalent to the baseline.");
    const summaries = run.metrics.map((metric) => ({
      ...metric,
      p95Ms: metric.currentP95Ms,
      successRate: metric.successRate ?? 1,
      successRatePassed: metric.successRatePassed ?? true
    }));
    errors.push(...verifyPerformanceMetrics(summaries, baseline).errors);
    for (const metric of run.metrics) {
      if (metric.budgetPassed === false) errors.push(`Performance budget failed for ${metric.name}.`);
      if (metric.regressionPassed === false) errors.push(`Performance regression failed for ${metric.name}.`);
      if (!existsRepositoryPath(root, metric.rawSamplesArtifact)) errors.push(`Performance run artifact is missing: ${metric.rawSamplesArtifact}`);
    }
  }
  return errors;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
let options;
if (isMain) {
  try {
    options = parseArguments(process.argv.slice(2));
    const record = JSON.parse(readFileSync(options.ledger, "utf8"));
    const schema = JSON.parse(readFileSync(options.schema, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false, formats: { "date-time": isDateTime } });
    const validate = ajv.compile(schema);
    const errors = validate(record) ? [] : validate.errors.map((error) =>
      `Schema validation failed at ${error.instancePath || "/"}: ${error.message}`
    );
    if (record && Array.isArray(record.sourceInventory) && Array.isArray(record.evidence)
      && Array.isArray(record.findings) && Array.isArray(record.exceptions)) {
      errors.push(...assuranceErrors(record, options.root, options.now));
    }
    if (errors.length > 0) throw new Error([...new Set(errors)].join("\n"));
    console.log(`Assurance verification passed for ${record.sourceInventory.length} inventory rows.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
