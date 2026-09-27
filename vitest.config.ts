import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Tests run against sources, never stale build output.
  resolve: {
    alias: {
      "@access/contracts": src("contracts"),
      "@access/domain": src("domain"),
      "@access/policy": src("policy"),
      "@access/rules": src("rules"),
      "@access/config": src("config"),
      "@access/observability": src("observability"),
      "@access/db": src("db"),
    },
  },
  test: {
    // One real PostgreSQL database: suites use distinct tenants but run
    // serially so dispatcher and migration tests stay deterministic.
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          setupFiles: ["tests/support/quiet-logs.ts"],
          include: ["tests/unit/**/*.test.ts", "tests/fault/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          setupFiles: ["tests/support/quiet-logs.ts"],
          include: ["tests/integration/**/*.test.ts", "tests/e2e/**/*.test.ts"],
          globalSetup: ["tests/support/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
