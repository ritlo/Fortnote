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
  collaborators: number;
  compactionEdits: number;
  documentBytes: number;
  samples: number;
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
export function performanceDatabaseEnvironment(
  postgresUrl: string | undefined,
  sqlitePath: string
):
  | { DATABASE_PROVIDER: "postgres"; DATABASE_URL: string }
  | { DATABASE_PROVIDER: "sqlite"; DATABASE_PATH: string };
