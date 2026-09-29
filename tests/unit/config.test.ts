import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadApiConfig,
  loadWorkerConfig,
} from "../../packages/config/src/index.js";

const key = randomBytes(32).toString("hex");
const hashKey = randomBytes(32).toString("hex");
const pilotApi = {
  NODE_ENV: "production",
  ACCESS_DEPLOYMENT_PROFILE: "client-pilot",
  ACCESS_DATA_MODE: "REAL",
  API_DATABASE_URL:
    "postgres://access_request.projectref:secret@db.example.test:5432/postgres",
  DATABASE_SSL: "require",
  ARTIFACT_ENCRYPTION_KEY: key,
  ACCESS_AUTH_MODE: "jwt",
  AUTH_JWT_ISSUER: "https://project.supabase.co/auth/v1",
  AUTH_JWT_AUDIENCE: "authenticated",
  AUTH_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
  CONSOLE_ORIGIN: "https://console.example.test",
  ARTIFACT_STORE: "supabase",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_STORAGE_BUCKET: "access-artifacts",
  SUPABASE_SERVICE_ROLE_KEY: "<service-role-placeholder>",
  ARTIFACT_SCANNER: "clamav",
  CLAMAV_HOST: "127.0.0.1",
  IDENTIFIER_HASH_KEY: hashKey,
  METRICS_TOKEN: "m".repeat(12) + randomBytes(16).toString("hex"),
};
function problems(fn: () => unknown): string[] {
  try {
    fn();
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

describe("API startup configuration", () => {
  it("accepts a complete client-pilot REAL configuration", () => {
    const config = loadApiConfig(pilotApi);
    expect(config.secure).toBe(true);
    expect(config.extraction.fixturesAllowed).toBe(false);
  });
  it("reports the build: BUILD_ID, else Railway's commit, else its deployment", () => {
    const build = (env: Record<string, string>) =>
      loadApiConfig({ ...pilotApi, ...env }).buildId;
    expect(build({ BUILD_ID: "b1", RAILWAY_GIT_COMMIT_SHA: "c1" })).toBe("b1");
    // An unresolved ${{RAILWAY_GIT_COMMIT_SHA}} reference is empty.
    expect(build({ BUILD_ID: "", RAILWAY_GIT_COMMIT_SHA: "c1" })).toBe("c1");
    expect(build({ RAILWAY_DEPLOYMENT_ID: "d1" })).toBe("d1");
    expect(build({})).toBe("dev");
  });
  it("refuses the synthetic tenant bridge in client-pilot and production", () => {
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, ACCESS_AUTH_MODE: "synthetic" }),
      ).join(),
    ).toMatch(/synthetic tenant context/);
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, ALLOW_SYNTHETIC_TENANT_CONTEXT: "true" }),
      ).join(),
    ).toMatch(/refuses ALLOW_SYNTHETIC/);
    expect(
      problems(() =>
        loadApiConfig({
          ...pilotApi,
          ACCESS_DEPLOYMENT_PROFILE: "production",
          ACCESS_AUTH_MODE: "synthetic",
        }),
      ).length,
    ).toBeGreaterThan(0);
  });
  it("refuses insecure development components in REAL data mode", () => {
    const p = problems(() =>
      loadApiConfig({
        ...pilotApi,
        ARTIFACT_STORE: "local",
        ARTIFACT_SCANNER: "mock",
      }),
    ).join();
    expect(p).toMatch(/refuses the local artifact store/);
    expect(p).toMatch(/refuses the mock scanner/);
    expect(
      problems(() =>
        loadApiConfig({
          ...pilotApi,
          ACCESS_DEPLOYMENT_PROFILE: "synthetic-staging",
        }),
      ).join(),
    ).toMatch(/REAL is only permitted/);
  });
  it("fails on missing database URL, unsafe role, reused migration credential or missing TLS", () => {
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, API_DATABASE_URL: undefined }),
      ).join(),
    ).toMatch(/API_DATABASE_URL is required/);
    expect(
      problems(() =>
        loadApiConfig({
          ...pilotApi,
          API_DATABASE_URL: "postgres://postgres:x@db/postgres",
        }),
      ).join(),
    ).toMatch(/access_request/);
    expect(
      problems(() =>
        loadApiConfig({
          ...pilotApi,
          MIGRATION_DATABASE_URL: pilotApi.API_DATABASE_URL,
        }),
      ).join(),
    ).toMatch(/migration credential/);
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, DATABASE_SSL: undefined }),
      ).join(),
    ).toMatch(/DATABASE_SSL=require/);
  });
  it("fails on missing JWT issuer, audience or key", () => {
    const p = problems(() =>
      loadApiConfig({
        ...pilotApi,
        AUTH_JWT_ISSUER: undefined,
        AUTH_JWT_AUDIENCE: undefined,
        AUTH_JWKS_URL: undefined,
      }),
    ).join();
    expect(p).toMatch(/AUTH_JWT_ISSUER/);
    expect(p).toMatch(/AUTH_JWT_AUDIENCE/);
    expect(p).toMatch(/AUTH_JWKS_URL or AUTH_JWT_SECRET/);
  });
  it("fails on wildcard or non-https CORS and on placeholder encryption keys", () => {
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, CONSOLE_ORIGIN: "*" }),
      ).join(),
    ).toMatch(/explicit https origin/);
    expect(
      problems(() =>
        loadApiConfig({
          ...pilotApi,
          CONSOLE_ORIGIN: "http://console.example.test",
        }),
      ).join(),
    ).toMatch(/https origin/);
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, ARTIFACT_ENCRYPTION_KEY: "0".repeat(64) }),
      ).join(),
    ).toMatch(/placeholder/);
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, ARTIFACT_ENCRYPTION_KEY: "abc" }),
      ).join(),
    ).toMatch(/64 hexadecimal/);
  });
  it("requires an explicit profile outside development", () =>
    expect(
      problems(() =>
        loadApiConfig({
          NODE_ENV: "production",
          API_DATABASE_URL: "postgres://access_request:x@h/d",
          ARTIFACT_ENCRYPTION_KEY: key,
        }),
      ).join(),
    ).toMatch(/ACCESS_DEPLOYMENT_PROFILE is required/));
  it("local development keeps working with the synthetic bridge", () => {
    const config = loadApiConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://dev:dev@localhost/access",
      ARTIFACT_ENCRYPTION_KEY: "0".repeat(64),
      IDENTIFIER_HASH_KEY: "1".repeat(64),
    });
    expect(config.auth.mode).toBe("synthetic");
    expect(config.profile).toBe("local");
    expect(config.metricsToken).toBeUndefined();
  });
  it("requires a real identifier hash key and a metrics token in secure profiles", () => {
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, IDENTIFIER_HASH_KEY: undefined }),
      ).join(),
    ).toMatch(/IDENTIFIER_HASH_KEY must be 64/);
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, IDENTIFIER_HASH_KEY: "0".repeat(64) }),
      ).join(),
    ).toMatch(/placeholder/);
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, IDENTIFIER_HASH_KEY: key }),
      ).join(),
    ).toMatch(/must differ/);
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, METRICS_TOKEN: undefined }),
      ).join(),
    ).toMatch(/requires METRICS_TOKEN/);
    expect(
      problems(() =>
        loadApiConfig({ ...pilotApi, METRICS_TOKEN: "short" }),
      ).join(),
    ).toMatch(/at least 32/);
  });
});

describe("worker startup configuration", () => {
  const pilotWorker = {
    NODE_ENV: "production",
    ACCESS_DEPLOYMENT_PROFILE: "client-pilot",
    ACCESS_DATA_MODE: "REAL",
    WORKER_DATABASE_URL:
      "postgres://access_worker.projectref:secret@db.example.test:5432/postgres",
    DATABASE_SSL: "require",
    CONNECTOR_KIND: "none",
    METRICS_TOKEN: "worker-metrics-token-at-least-32-characters",
    IDENTIFIER_HASH_KEY:
      "8f3c2b1a0e9d8c7b6a5f4e3d2c1b0a998877665544332211ffeeddccbbaa0099",
  };
  it("client-pilot REAL uses no connector (manual destination) and validates", () =>
    expect(loadWorkerConfig(pilotWorker).connector.capabilities).toEqual([]));
  it("scheduling platform settings: metrics, providers, allow-list and targets fail closed", () => {
    const noToken: Record<string, string> = { ...pilotWorker };
    delete noToken.METRICS_TOKEN;
    expect(problems(() => loadWorkerConfig(noToken)).join()).toMatch(
      /requires METRICS_TOKEN/,
    );
    const pilot = loadWorkerConfig(pilotWorker);
    // Real data: no recipient restriction unless one is configured.
    expect(pilot.notifications.allowList).toBeNull();
    expect(pilot.smtp).toBeNull();
    expect(pilot.whatsapp.graphBaseUrl).toBe("https://graph.facebook.com");
    expect(pilot.port).toBe(8081);
    // Synthetic data: only allow-listed test recipients are ever messaged.
    const staging = loadWorkerConfig({
      NODE_ENV: "production",
      ACCESS_DEPLOYMENT_PROFILE: "synthetic-staging",
      ACCESS_DATA_MODE: "SYNTHETIC",
      WORKER_DATABASE_URL: "postgres://access_worker:secret@db.example.test/db",
      IDENTIFIER_HASH_KEY: pilotWorker.IDENTIFIER_HASH_KEY,
      NOTIFICATION_RECIPIENT_ALLOWLIST: "+27820000001, QA@Example.com",
    });
    expect([...staging.notifications.allowList!]).toEqual([
      "+27820000001",
      "qa@example.com",
    ]);
    expect(
      loadWorkerConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://localhost/access",
        IDENTIFIER_HASH_KEY: "07".repeat(32),
      }).notifications.allowList?.size,
    ).toBe(0);
    for (const [env, message] of [
      [{ NOTIFICATION_RECIPIENT_ALLOWLIST: "0820000001" }, /E.164/],
      [{ SMTP_URL: "smtps://u:p@smtp.example.test" }, /set together/],
      [
        {
          SMTP_URL: "smtp://u:p@smtp.example.test",
          SMTP_FROM: "a@example.test",
          SMTP_REQUIRE_TLS: "false",
        },
        /only permitted in the local profile/,
      ],
      [{ INTEGRATION_ALLOW_PRIVATE_TARGETS: "true" }, /local profile/],
      [{ WHATSAPP_GRAPH_BASE_URL: "http://graph.example.test" }, /https/],
      [{ WHATSAPP_API_VERSION: "latest" }, /v23.0/],
      [{ METRICS_TOKEN: "short" }, /at least 32/],
    ] as const)
      expect(
        problems(() => loadWorkerConfig({ ...pilotWorker, ...env })).join(),
      ).toMatch(message);
  });
  it("the LLM intent classifier is off unless configured, and gated for real data", () => {
    expect(loadWorkerConfig(pilotWorker).intentClassifier).toBeNull();
    const llm = {
      INTENT_CLASSIFIER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-api-key-for-config-tests-0123",
    };
    expect(
      problems(() => loadWorkerConfig({ ...pilotWorker, ...llm })).join(),
    ).toMatch(/INTENT_CLASSIFIER_PROCESSOR_APPROVED=true/);
    expect(
      loadWorkerConfig({
        ...pilotWorker,
        ...llm,
        INTENT_CLASSIFIER_PROCESSOR_APPROVED: "true",
      }).intentClassifier,
    ).toEqual({
      provider: "anthropic",
      apiKey: llm.ANTHROPIC_API_KEY,
      model: "claude-opus-5",
      timeoutMs: 4000,
      maxPerMinute: 120,
    });
    const approved = {
      ...pilotWorker,
      INTENT_CLASSIFIER_PROCESSOR_APPROVED: "true",
    };
    for (const [env, message] of [
      [{ INTENT_CLASSIFIER: "openai" }, /off or anthropic/],
      [{ INTENT_CLASSIFIER: "anthropic" }, /requires ANTHROPIC_API_KEY/],
      [{ ...llm, INTENT_CLASSIFIER_MODEL: "gpt-4o" }, /Claude model id/],
      [
        { ...llm, INTENT_CLASSIFIER_TIMEOUT_MS: "60000" },
        /between 0 and 15000/,
      ],
    ] as const)
      expect(
        problems(() => loadWorkerConfig({ ...approved, ...env })).join(),
      ).toMatch(message);
  });
  it("refuses the mock connector with real data, unknown and unimplemented capabilities and fault injection", () => {
    expect(
      problems(() =>
        loadWorkerConfig({ ...pilotWorker, CONNECTOR_KIND: "mock" }),
      ).join(),
    ).toMatch(/refuses the mock connector/);
    expect(
      problems(() =>
        loadWorkerConfig({
          ...pilotWorker,
          CONNECTOR_CAPABILITIES: "referral.teleport",
        }),
      ).join(),
    ).toMatch(/unknown capability/);
    expect(
      problems(() =>
        loadWorkerConfig({
          ...pilotWorker,
          CONNECTOR_CAPABILITIES: "referral.create",
        }),
      ).join(),
    ).toMatch(/not implemented/);
    expect(
      problems(() =>
        loadWorkerConfig({
          ...pilotWorker,
          CONNECTOR_FAULT_MODE: "committed-timeout",
        }),
      ).join(),
    ).toMatch(/fault injection/);
  });
  it("an empty capability list means every implemented capability", () =>
    expect(
      loadWorkerConfig({
        NODE_ENV: "development",
        WORKER_DATABASE_URL: "postgres://access_worker:x@localhost/access",
        IDENTIFIER_HASH_KEY: "07".repeat(32),
        CONNECTOR_KIND: "mock",
        CONNECTOR_CAPABILITIES: "",
      }).connector.capabilities,
    ).toEqual([
      "patient.lookup",
      "referral.create",
      "referral.status.read",
      "appointment.status.read",
    ]));
  it("never accepts the migration credential", () =>
    expect(
      problems(() =>
        loadWorkerConfig({
          ...pilotWorker,
          MIGRATION_DATABASE_URL: "postgres://owner:x@db/postgres",
        }),
      ).join(),
    ).toMatch(/must not be configured/));
});
