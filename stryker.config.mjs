/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  concurrency: 2,
  coverageAnalysis: "perTest",
  ignorePatterns: [".codegraph", "data"],
  mutate: [
    "packages/shared/src/crypto.ts:58-61",
    "packages/shared/src/crypto.ts:205-209",
    "packages/shared/src/crypto.ts:312-315",
    "packages/shared/src/crypto.ts:338-348",
    "packages/shared/src/crypto.ts:362-366",
    "packages/shared/src/crdt.ts:184-185",
    "packages/shared/src/crdt.ts:196-198",
    "packages/shared/src/crdt.ts:226-232",
    "packages/shared/src/crdt.ts:242-252",
    "apps/server/src/config.ts:57-64",
    "apps/client/src/realtime/outbox.ts:91-94",
    "apps/client/src/lib/indexedDb.ts:250-262",
    "apps/server/src/realtime/history.ts:86-90",
    "apps/server/src/realtime/history.ts:111-112",
    "apps/server/src/realtime/history.ts:134-136",
    "apps/server/src/realtime/history.ts:154-157",
    "apps/server/src/realtime/history.ts:165-181",
    "apps/server/src/notes/access.ts:49-57"
  ],
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "specs/001-collaboration-design-assurance/evidence/mutation-results.json"
  },
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.stryker.config.ts",
    related: false
  }
};
