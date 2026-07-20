export interface PerformanceAccount {
  password: string;
  suffix: string;
  username: string;
}

export interface PerformanceFixtureDefinition {
  accounts: {
    editor: PerformanceAccount;
    owner: PerformanceAccount;
    viewer: PerformanceAccount;
  };
  activeSectionBytes: number;
  collaborators: number;
  compactionEdits: number;
  logicalBytes: number;
  samples: number;
  sectionCount: number;
  seed: string;
  title: string;
  warmupRuns: number;
}

export const PERFORMANCE_FIXTURE: Readonly<Omit<PerformanceFixtureDefinition, "accounts" | "seed" | "title">>;
export const PERFORMANCE_SMOKE_FIXTURE: Readonly<Omit<PerformanceFixtureDefinition, "accounts" | "seed" | "title">>;
export function performanceFixtureDefinition(
  seed?: string,
  profile?: "smoke" | "full"
): PerformanceFixtureDefinition;
