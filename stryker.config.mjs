/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  concurrency: 4,
  coverageAnalysis: "perTest",
  ignorePatterns: [".codegraph", "data"],
  mutate: [
    "packages/shared/src/crypto.ts:53-67",
    "packages/shared/src/crypto.ts:194-210",
    "packages/shared/src/crypto.ts:263-367",
    "packages/shared/src/crdt.ts:177-294",
    "apps/server/src/config.ts:57-64",
    "apps/client/src/realtime/outbox.ts:88-100",
    "apps/client/src/lib/indexedDb.ts:250-274",
    "apps/server/src/realtime/history.ts:69-184",
    "apps/server/src/notes/access.ts:49-62"
  ],
  packageManager: "pnpm",
  plugins: ["@stryker-mutator/vitest-runner"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "specs/001-collaboration-design-assurance/evidence/mutation-results.json"
  },
  testRunner: "vitest"
};
