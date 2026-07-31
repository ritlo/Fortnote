import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { performanceFixtureDefinition } from "../../../scripts/create-performance-fixture.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const verifierUrl = pathToFileURL(
  path.join(repositoryRoot, "scripts/verify-assurance.mjs")
).href;

const budgets = {
  "authenticated-action": 500,
  "collaborator-visible": 1_000,
  "large-note-usable": 5_000,
  "local-feedback": 100,
  "note-usable": 2_000,
  "section-usable": 2_000
} as const;

type SampleResult = "failure" | "success" | "timeout";

interface PerformanceSample {
  durationMs: number;
  result: SampleResult;
}

interface MetricSummary {
  budgetMs: number;
  budgetPassed: boolean;
  name: string;
  p95Ms: number;
  sampleCount: number;
  successRate: number;
  successRatePassed: boolean;
}

interface PerformanceHelpers {
  fingerprintPerformanceEnvironment: (environment: Record<string, string | number>) => string;
  nearestRankP95: (values: number[]) => number;
  summarizePerformanceMetric: (
    name: string,
    budgetMs: number,
    samples: PerformanceSample[]
  ) => MetricSummary;
  verifyPerformanceMetrics: (
    metrics: MetricSummary[],
    baselineP95Ms: Record<string, number>
  ) => { errors: string[]; passed: boolean };
}

async function helpers(): Promise<PerformanceHelpers> {
  return await import(verifierUrl) as PerformanceHelpers;
}

describe("performance assurance calculations", () => {
  it("builds the deterministic full three-collaborator fixture", () => {
    const first = performanceFixtureDefinition("release-candidate", "full");
    const second = performanceFixtureDefinition("release-candidate", "full");

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      activeSectionBytes: 4 * 1024 * 1024,
      collaborators: 3,
      compactionEdits: 65,
      logicalBytes: 100 * 1024 * 1024,
      samples: 20,
      sectionCount: 100,
      seed: "release-candidate",
      warmupRuns: 2
    });
    expect(new Set(Object.values(first.accounts).map(({ username }) => username)).size).toBe(3);
  });

  it("calculates nearest-rank p95 from sorted and unsorted samples", async () => {
    const { nearestRankP95 } = await helpers();
    const values = [20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10];

    expect(nearestRankP95(values)).toBe(19);
    expect(values).toEqual([20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10]);
  });

  it("counts failures and timeouts in both latency and success rate", async () => {
    const { summarizePerformanceMetric } = await helpers();
    const samples: PerformanceSample[] = [
      ...Array.from({ length: 18 }, (_, index) => ({
        durationMs: index + 1,
        result: "success" as const
      })),
      { durationMs: 900, result: "failure" },
      { durationMs: 1_000, result: "timeout" }
    ];

    expect(summarizePerformanceMetric("local-feedback", 100, samples)).toMatchObject({
      budgetPassed: false,
      p95Ms: 900,
      sampleCount: 20,
      successRate: 0.9,
      successRatePassed: false
    });
  });

  it("requires at least 95 percent successful samples", async () => {
    const { summarizePerformanceMetric } = await helpers();
    const sample = (successes: number): PerformanceSample[] => [
      ...Array.from({ length: successes }, () => ({ durationMs: 50, result: "success" as const })),
      ...Array.from({ length: 20 - successes }, () => ({ durationMs: 50, result: "failure" as const }))
    ];

    expect(summarizePerformanceMetric("local-feedback", 100, sample(19)).successRatePassed).toBe(true);
    expect(summarizePerformanceMetric("local-feedback", 100, sample(18)).successRatePassed).toBe(false);
  });

  it("requires all six named metrics with their exact budgets", async () => {
    const { summarizePerformanceMetric, verifyPerformanceMetrics } = await helpers();
    const metrics = Object.entries(budgets).map(([name, budgetMs]) =>
      summarizePerformanceMetric(
        name,
        budgetMs,
        Array.from({ length: 20 }, () => ({ durationMs: budgetMs, result: "success" }))
      )
    );
    const baseline = Object.fromEntries(metrics.map(({ name, p95Ms }) => [name, p95Ms]));

    expect(verifyPerformanceMetrics(metrics, baseline)).toEqual({ errors: [], passed: true });
    expect(verifyPerformanceMetrics(metrics.slice(1), baseline).errors.join(" ")).toMatch(/six|local-feedback/iu);

    const wrongBudget = metrics.map((metric) => ({ ...metric }));
    wrongBudget[0]!.budgetMs += 1;
    expect(verifyPerformanceMetrics(wrongBudget, baseline).errors.join(" ")).toMatch(/budget/iu);
  });

  it("fingerprints only performance-equivalent environment properties", async () => {
    const { fingerprintPerformanceEnvironment } = await helpers();
    const environment = {
      browser: "chromium 138.0.7204.49",
      buildMode: "production",
      collaborators: 3,
      cpu: "2-vCPU",
      dataset: "100MiB-100-sections",
      database: "sqlite",
      node: "26.1.0",
      os: "linux",
      warmupRuns: 1
    };
    const reordered = Object.fromEntries(Object.entries(environment).reverse());

    expect(fingerprintPerformanceEnvironment(reordered)).toBe(
      fingerprintPerformanceEnvironment(environment)
    );
    expect(fingerprintPerformanceEnvironment({
      ...environment,
      browser: "chromium 138.0.7204.92",
      node: "26.2.1"
    })).toBe(fingerprintPerformanceEnvironment(environment));
    expect(fingerprintPerformanceEnvironment({ ...environment, cpu: "4-vCPU" })).not.toBe(
      fingerprintPerformanceEnvironment(environment)
    );
  });

  it("accepts a 10 percent p95 regression and rejects anything larger", async () => {
    const { summarizePerformanceMetric, verifyPerformanceMetrics } = await helpers();
    const metrics = Object.entries(budgets).map(([name, budgetMs]) =>
      summarizePerformanceMetric(
        name,
        budgetMs,
        Array.from({ length: 20 }, () => ({ durationMs: 110, result: "success" }))
      )
    );
    const baseline = Object.fromEntries(metrics.map(({ name }) => [name, 100]));

    expect(verifyPerformanceMetrics(metrics, baseline)).toEqual({ errors: [], passed: true });

    const regressed = metrics.map((metric, index) =>
      index === 0 ? { ...metric, p95Ms: 110.01 } : metric
    );
    expect(verifyPerformanceMetrics(regressed, baseline).errors.join(" ")).toMatch(/regression/iu);
  });
});
