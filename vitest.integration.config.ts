import { defineConfig } from "vitest/config";

/**
 * The LIVE integration suite. Kept in its own config so the unit `pnpm test`
 * (which globs `test/**`) never picks these up and never pays their cost. Every
 * spec here skips itself when `ODOO_URL` is unset, so running this config
 * without a harness stack exits 0 with everything skipped.
 */
export default defineConfig({
  test: {
    include: ["test-integration/**/*.integration.test.ts"],
    // Live round trips (cold auth, real HTTP) are slow; give them room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One stack, shared state: run files serially to avoid cross-test churn.
    fileParallelism: false,
  },
});
