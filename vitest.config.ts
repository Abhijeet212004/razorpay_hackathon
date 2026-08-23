import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Ryuk is the Testcontainers reaper. Connecting to it fails intermittently on Docker
    // Desktop and fails a run for reasons unrelated to the code. Teardown stops the
    // container explicitly, so the reaper has nothing to clean up.
    env: { TESTCONTAINERS_RYUK_DISABLED: "true" },
    // One real Postgres 16 for the whole run; each suite gets its own database inside
    // it. No mocked database anywhere — ADR-011.
    globalSetup: ["tests/support/global-setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // Each suite owns its own container; running files in parallel would
    // start N Postgres containers on a judge's laptop.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
  },
});
