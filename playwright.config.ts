import { defineConfig, devices } from "@playwright/test";
import {
  ALLOW_LIST,
  API_URL,
  CONSOLE_URL,
  E2E_DATABASE_URL,
  GRAPH_URL,
  IDENTIFIER_HASH_KEY,
  PORTS,
  TENANT_ID,
  WHATSAPP,
  API_LOGIN,
  WORKER_LOGIN,
  loginUrl,
} from "./tests/browser/support/env.js";

/**
 * Browser end-to-end suite: the built console, API and worker run as they
 * are deployed (compiled output, least-privilege database logins) against a
 * dedicated database reset and seeded before the API starts. The worker's
 * production WhatsApp adapter talks to a local Graph API stand-in. Requires
 * `npm run build` first.
 */
const common = {
  ACCESS_DEPLOYMENT_PROFILE: "local",
  ACCESS_DATA_MODE: "SYNTHETIC",
  NODE_ENV: "production",
  BUILD_ID: "e2e",
  IDENTIFIER_HASH_KEY,
};
export default defineConfig({
  testDir: "tests/browser",
  testMatch: /.*\.spec\.ts$/,
  // One seeded database: specs run one at a time, in file order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["json", { outputFile: "e2e-report.json" }]]
    : [["list"]],
  use: {
    baseURL: CONSOLE_URL,
    // Deliberately not the practice's zone: the console must show practice
    // time, whatever the browser's clock says.
    timezoneId: "America/Anchorage",
    locale: "en-ZA",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "phone",
      use: { ...devices["Pixel 7"] },
      grep: /@phone/,
    },
  ],
  webServer: [
    {
      command: "npx tsx tests/browser/support/graph-server.ts",
      url: `${GRAPH_URL}/__fixture/health`,
      reuseExistingServer: false,
      stdout: "ignore",
    },
    {
      command:
        "npx tsx tests/browser/support/setup-db.ts && node apps/core-api/dist/server.js",
      url: `${API_URL}/ready`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
      env: {
        ...common,
        E2E_DATABASE_URL,
        DATABASE_URL: loginUrl(API_LOGIN),
        PORT: String(PORTS.api),
        CONSOLE_ORIGIN: CONSOLE_URL,
        ACCESS_AUTH_MODE: "synthetic",
        ARTIFACT_ENCRYPTION_KEY: "0".repeat(64),
        ARTIFACT_STORE: "local",
        ARTIFACT_ROOT: "test-results/e2e-artifacts",
        ARTIFACT_SCANNER: "mock",
        WHATSAPP_APP_SECRET: WHATSAPP.appSecret,
        WHATSAPP_VERIFY_TOKEN: WHATSAPP.verifyToken,
      },
    },
    {
      command: "node apps/worker/dist/main.js",
      url: `http://127.0.0.1:${PORTS.worker}/ready`,
      reuseExistingServer: false,
      env: {
        ...common,
        DATABASE_URL: loginUrl(WORKER_LOGIN),
        PORT: String(PORTS.worker),
        WORKER_TENANT_IDS: TENANT_ID,
        WORKER_POLL_MS: "200",
        WHATSAPP_GRAPH_BASE_URL: GRAPH_URL,
        [WHATSAPP.tokenRef]: WHATSAPP.token,
        INTEGRATION_ALLOW_PRIVATE_TARGETS: "true",
        NOTIFICATION_RECIPIENT_ALLOWLIST: ALLOW_LIST,
      },
    },
    {
      command:
        "npx vite build --logLevel warn && npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
      cwd: "apps/console",
      url: CONSOLE_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        VITE_CORE_API_URL: API_URL,
        VITE_AUTH_MODE: "synthetic",
      },
    },
  ],
});
