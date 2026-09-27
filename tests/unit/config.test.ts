import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadApiConfig,
  loadWorkerConfig,
} from "../../packages/config/src/index.js";

const key = randomBytes(32).toString("hex");
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
    });
    expect(config.auth.mode).toBe("synthetic");
    expect(config.profile).toBe("local");
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
  };
  it("client-pilot REAL uses no connector (manual destination) and validates", () =>
    expect(loadWorkerConfig(pilotWorker).connector.capabilities).toEqual([]));
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
        CONNECTOR_KIND: "mock",
        CONNECTOR_CAPABILITIES: "",
      }).connector.capabilities,
    ).toEqual([
      "patient.lookup",
      "referral.create",
      "referral.status.read",
      "appointment.availability.read",
      "appointment.hold",
      "appointment.create",
      "appointment.reschedule",
      "appointment.cancel",
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
