export const REQUIRED_ASSURANCE_COMMANDS: readonly string[];

export function verifyAssuranceSummary(summary: string, root: string): string[];

export function findMutationSurvivor(value: unknown): object | undefined;

export function nearestRankP95(values: number[]): number;

export function summarizePerformanceMetric(
  name: string,
  budgetMs: number,
  samples: { durationMs: number; result: string }[]
): {
  budgetPassed: boolean;
  budgetMs: number;
  name: string;
  p95Ms: number;
  sampleCount: number;
  successRate: number;
  successRatePassed: boolean;
};
