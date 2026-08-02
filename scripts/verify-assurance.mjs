#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MUTATION_ARTIFACT =
  "specs/001-collaboration-design-assurance/evidence/mutation-results.json";

const performanceBudgets = {
  "authenticated-action": 500,
  "collaborator-visible": 1_000,
  "fresh-session-usable": 5_000,
  "local-feedback": 100,
  "note-usable": 2_000,
  "representative-note-usable": 5_000
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

function parseArguments(argv) {
  const options = { root: process.cwd() };
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${option ?? "argument"} requires a value`);
    if (option === "--root") options.root = path.resolve(value);
    else throw new Error(`Unknown argument: ${option}`);
  }
  return options;
}

export function verifyAssuranceArtifacts(root) {
  const errors = [];
  const artifact = path.join(root, MUTATION_ARTIFACT);
  if (!existsSync(artifact)) {
    errors.push(`Mutation artifact is missing: ${MUTATION_ARTIFACT}`);
    return errors;
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(artifact, "utf8"));
  } catch {
    errors.push(`Mutation artifact is not valid JSON: ${MUTATION_ARTIFACT}`);
    return errors;
  }
  if (findMutationSurvivor(evidence)) {
    errors.push("Mutation artifact contains a non-equivalent survivor.");
  }
  return errors;
}

export function findMutationSurvivor(value) {
  if (!value || typeof value !== "object") return undefined;
  if (String(value.status).toLowerCase() === "survived" && value.equivalent !== true) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const survivor = findMutationSurvivor(child);
    if (survivor) return survivor;
  }
  return undefined;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const errors = verifyAssuranceArtifacts(options.root);
    if (errors.length > 0) throw new Error([...new Set(errors)].join("\n"));
    console.log("Assurance artifact verification passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
