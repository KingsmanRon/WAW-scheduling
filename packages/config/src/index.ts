import { CAPABILITIES, type Capability } from "@access/contracts";

/**
 * Startup configuration validation. Every runtime loads its configuration
 * through this module and refuses to start on any violation; the checks are
 * pure so the fail-closed rules are unit tested.
 */
export const PROFILES = [
  "local",
  "synthetic-staging",
  "client-pilot",
  "production",
] as const;
export type Profile = (typeof PROFILES)[number];
export type DataMode = "SYNTHETIC" | "REAL";
/** Profiles held to production security boundaries. */
export const SECURE_PROFILES: readonly Profile[] = [
  "client-pilot",
  "production",
];

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n - ${problems.join("\n - ")}`);
  }
}
type Env = Record<string, string | undefined>;

interface Common {
  profile: Profile;
  dataMode: DataMode;
  nodeEnv: string;
  secure: boolean;
  databaseSsl: "require" | undefined;
  databaseCaCertPath: string | undefined;
  databaseCaCert: string | undefined;
}
function common(env: Env, problems: string[]): Common {
  const nodeEnv = env.NODE_ENV ?? "development";
  const profileRaw =
    env.ACCESS_DEPLOYMENT_PROFILE ??
    (["development", "test"].includes(nodeEnv) ? "local" : undefined);
  if (!profileRaw)
    problems.push(
      "ACCESS_DEPLOYMENT_PROFILE is required outside development/test",
    );
  const profile = (PROFILES as readonly string[]).includes(profileRaw ?? "")
    ? (profileRaw as Profile)
    : (problems.push(
        `ACCESS_DEPLOYMENT_PROFILE must be one of ${PROFILES.join(", ")}`,
      ),
      "production");
  const dataModeRaw = env.ACCESS_DATA_MODE ?? "SYNTHETIC";
  if (!["SYNTHETIC", "REAL"].includes(dataModeRaw))
    problems.push("ACCESS_DATA_MODE must be SYNTHETIC or REAL");
  const dataMode: DataMode = dataModeRaw === "REAL" ? "REAL" : "SYNTHETIC";
  const secure = SECURE_PROFILES.includes(profile);
  if (dataMode === "REAL" && !secure)
    problems.push(
      `ACCESS_DATA_MODE=REAL is only permitted in ${SECURE_PROFILES.join(" or ")} profiles`,
    );
  if (secure && nodeEnv !== "production")
    problems.push(`${profile} requires NODE_ENV=production`);
  if (secure && env.DATABASE_SSL !== "require")
    problems.push(
      `${profile} requires DATABASE_SSL=require (TLS to PostgreSQL)`,
    );
  if (
    env.DATABASE_CA_CERT &&
    !env.DATABASE_CA_CERT.includes("-----BEGIN CERTIFICATE-----")
  )
    problems.push("DATABASE_CA_CERT must be a PEM certificate");
  if (secure && env.ALLOW_SYNTHETIC_TENANT_CONTEXT === "true")
    problems.push(`${profile} refuses ALLOW_SYNTHETIC_TENANT_CONTEXT`);
  return {
    profile,
    dataMode,
    nodeEnv,
    secure,
    databaseSsl: env.DATABASE_SSL === "require" ? "require" : undefined,
    databaseCaCertPath: env.DATABASE_CA_CERT_PATH,
    databaseCaCert: env.DATABASE_CA_CERT,
  };
}

function databaseUrl(
  env: Env,
  key: "API_DATABASE_URL" | "WORKER_DATABASE_URL",
  expectedUser: string,
  c: Common,
  problems: string[],
): string {
  const value = env[key];
  const fallbackAllowed = c.profile === "local" && !value;
  const url = value ?? (fallbackAllowed ? env.DATABASE_URL : undefined);
  if (!url) {
    problems.push(`${key} is required`);
    return "";
  }
  if (env.MIGRATION_DATABASE_URL && url === env.MIGRATION_DATABASE_URL)
    problems.push(`${key} must not reuse the migration credential`);
  if (c.profile !== "local") {
    try {
      const user = decodeURIComponent(new URL(url).username);
      if (user !== expectedUser && !user.startsWith(`${expectedUser}.`))
        problems.push(`${key} must log in as ${expectedUser}`);
    } catch {
      problems.push(`${key} is not a valid URL`);
    }
  }
  if (c.secure && env.MIGRATION_DATABASE_URL)
    problems.push(
      `MIGRATION_DATABASE_URL must not be configured on the ${key === "API_DATABASE_URL" ? "API" : "worker"}`,
    );
  return url;
}

function encryptionKey(env: Env, c: Common, problems: string[]): Buffer {
  const hex = env.ARTIFACT_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    problems.push("ARTIFACT_ENCRYPTION_KEY must be 64 hexadecimal characters");
    return Buffer.alloc(32);
  }
  const key = Buffer.from(hex, "hex");
  if (c.profile !== "local" && new Set(key).size < 8)
    problems.push(
      "ARTIFACT_ENCRYPTION_KEY looks like a placeholder, not a random key",
    );
  return key;
}

export interface AuthConfig {
  mode: "jwt" | "synthetic";
  issuer?: string;
  audience?: string;
  jwksUrl?: string;
  hsSecret?: string;
}
function auth(env: Env, c: Common, problems: string[]): AuthConfig {
  const legacySynthetic = env.ALLOW_SYNTHETIC_TENANT_CONTEXT === "true";
  const mode =
    env.ACCESS_AUTH_MODE ??
    (legacySynthetic || c.profile === "local" ? "synthetic" : "jwt");
  if (mode !== "jwt" && mode !== "synthetic") {
    problems.push("ACCESS_AUTH_MODE must be jwt or synthetic");
    return { mode: "jwt" };
  }
  if (mode === "synthetic") {
    if (c.secure || c.dataMode === "REAL")
      problems.push(
        "synthetic tenant context is a development bridge and is refused in client-pilot, production and REAL data mode",
      );
    return { mode };
  }
  const issuer = env.AUTH_JWT_ISSUER;
  const audience = env.AUTH_JWT_AUDIENCE;
  const jwksUrl = env.AUTH_JWKS_URL;
  const hsSecret = env.AUTH_JWT_SECRET;
  if (!issuer)
    problems.push("AUTH_JWT_ISSUER is required for JWT authentication");
  if (!audience)
    problems.push("AUTH_JWT_AUDIENCE is required for JWT authentication");
  if (!jwksUrl && !hsSecret)
    problems.push(
      "AUTH_JWKS_URL or AUTH_JWT_SECRET is required for JWT authentication",
    );
  if (hsSecret && hsSecret.length < 32)
    problems.push("AUTH_JWT_SECRET must be at least 32 characters");
  if (c.secure) {
    if (issuer && !issuer.startsWith("https://"))
      problems.push("AUTH_JWT_ISSUER must be https in secure profiles");
    if (jwksUrl && !jwksUrl.startsWith("https://"))
      problems.push("AUTH_JWKS_URL must be https in secure profiles");
  }
  return {
    mode,
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
    ...(jwksUrl ? { jwksUrl } : {}),
    ...(hsSecret ? { hsSecret } : {}),
  };
}

export interface StorageConfig {
  kind: "local" | "supabase";
  root: string;
  supabaseUrl?: string;
  bucket?: string;
  serviceKey?: string;
  retentionDays: number;
}
export interface ScannerConfig {
  kind: "mock" | "clamav";
  host?: string;
  port?: number;
  timeoutMs: number;
}
export interface ApiConfig extends Common {
  runtime: "api";
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  encryptionKey: Buffer;
  auth: AuthConfig;
  storage: StorageConfig;
  scanner: ScannerConfig;
  extraction: { fixturesAllowed: boolean };
  buildId: string;
}

function positiveInt(
  env: Env,
  key: string,
  fallback: number,
  max: number,
  problems: string[],
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    problems.push(`${key} must be an integer between 0 and ${max}`);
    return fallback;
  }
  return n;
}

export function loadApiConfig(env: Env = process.env): ApiConfig {
  const problems: string[] = [];
  const c = common(env, problems);
  const databaseUrlValue = databaseUrl(
    env,
    "API_DATABASE_URL",
    "access_request",
    c,
    problems,
  );
  const corsOrigins = (env.CONSOLE_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (c.secure) {
    if (!env.CONSOLE_ORIGIN) problems.push("CONSOLE_ORIGIN is required");
    for (const origin of corsOrigins)
      if (origin === "*" || !/^https:\/\/[^*\s]+$/.test(origin))
        problems.push(
          `CONSOLE_ORIGIN ${origin} must be an explicit https origin`,
        );
  } else if (corsOrigins.includes("*"))
    problems.push("CONSOLE_ORIGIN must not be a wildcard");
  const storageKind = env.ARTIFACT_STORE ?? "local";
  if (storageKind !== "local" && storageKind !== "supabase")
    problems.push("ARTIFACT_STORE must be local or supabase");
  const storage: StorageConfig = {
    kind: storageKind === "supabase" ? "supabase" : "local",
    root: env.ARTIFACT_ROOT ?? "./data/artifacts",
    retentionDays: positiveInt(
      env,
      "ARTIFACT_RETENTION_DAYS",
      2555,
      36500,
      problems,
    ),
    ...(env.SUPABASE_URL ? { supabaseUrl: env.SUPABASE_URL } : {}),
    ...(env.SUPABASE_STORAGE_BUCKET
      ? { bucket: env.SUPABASE_STORAGE_BUCKET }
      : {}),
    ...(env.SUPABASE_SERVICE_ROLE_KEY
      ? { serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }
      : {}),
  };
  if (storage.kind === "supabase") {
    if (!storage.supabaseUrl?.startsWith("https://") && c.secure)
      problems.push("SUPABASE_URL must be https");
    if (!storage.supabaseUrl)
      problems.push("SUPABASE_URL is required for ARTIFACT_STORE=supabase");
    if (!storage.bucket || !/^[a-z0-9][a-z0-9_-]{2,62}$/.test(storage.bucket))
      problems.push("SUPABASE_STORAGE_BUCKET must name the private bucket");
    if (!storage.serviceKey)
      problems.push(
        "SUPABASE_SERVICE_ROLE_KEY is required server-side for ARTIFACT_STORE=supabase",
      );
  }
  const scannerKind = env.ARTIFACT_SCANNER ?? "mock";
  if (scannerKind !== "mock" && scannerKind !== "clamav")
    problems.push("ARTIFACT_SCANNER must be mock or clamav");
  const scanner: ScannerConfig = {
    kind: scannerKind === "clamav" ? "clamav" : "mock",
    timeoutMs: positiveInt(env, "CLAMAV_TIMEOUT_MS", 30_000, 300_000, problems),
    ...(env.CLAMAV_HOST ? { host: env.CLAMAV_HOST } : {}),
    ...(env.CLAMAV_PORT ? { port: Number(env.CLAMAV_PORT) } : {}),
  };
  if (scanner.kind === "clamav" && !scanner.host)
    problems.push("CLAMAV_HOST is required for ARTIFACT_SCANNER=clamav");
  if (c.dataMode === "REAL") {
    if (storage.kind === "local")
      problems.push(
        "REAL data mode refuses the local artifact store; use ARTIFACT_STORE=supabase",
      );
    if (scanner.kind === "mock")
      problems.push(
        "REAL data mode refuses the mock scanner; use ARTIFACT_SCANNER=clamav",
      );
  }
  if (c.secure && storage.kind === "local")
    problems.push(
      `${c.profile} requires managed artifact storage (ARTIFACT_STORE=supabase)`,
    );
  if (c.secure && scanner.kind === "mock")
    problems.push(
      `${c.profile} requires a production scanner (ARTIFACT_SCANNER=clamav)`,
    );
  const config: ApiConfig = {
    ...c,
    runtime: "api",
    port: positiveInt(env, "PORT", 3001, 65535, problems),
    databaseUrl: databaseUrlValue,
    corsOrigins,
    encryptionKey: encryptionKey(env, c, problems),
    auth: auth(env, c, problems),
    storage,
    scanner,
    extraction: { fixturesAllowed: c.dataMode === "SYNTHETIC" && !c.secure },
    buildId: env.BUILD_ID ?? "dev",
  };
  if (problems.length) throw new ConfigError(problems);
  return config;
}

export interface WorkerConfig extends Common {
  runtime: "worker";
  databaseUrl: string;
  connector: {
    kind: "mock" | "none";
    capabilities: Capability[];
    faultMode: string;
  };
  dispatchMaxAttempts: number;
  dispatchRetrySeconds: number;
  reconcileMaxAttempts: number;
  reconcileBaseSeconds: number;
  pollMs: number;
  tenantIds: string[] | undefined;
}
/** Capabilities each connector implementation has actually qualified. */
export const CONNECTOR_IMPLEMENTED: Record<
  "mock" | "none",
  readonly Capability[]
> = {
  mock: [
    "patient.lookup",
    "referral.create",
    "referral.status.read",
    "appointment.availability.read",
    "appointment.hold",
    "appointment.create",
    "appointment.reschedule",
    "appointment.cancel",
    "appointment.status.read",
  ],
  none: [],
};
export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const problems: string[] = [];
  const c = common(env, problems);
  const databaseUrlValue = databaseUrl(
    env,
    "WORKER_DATABASE_URL",
    "access_worker",
    c,
    problems,
  );
  const kindRaw = env.CONNECTOR_KIND ?? "mock";
  if (kindRaw !== "mock" && kindRaw !== "none")
    problems.push(
      "CONNECTOR_KIND must be mock or none (no qualified real connector exists yet)",
    );
  const kind = kindRaw === "none" ? "none" : "mock";
  if (kind === "mock" && c.dataMode === "REAL")
    problems.push(
      "REAL data mode refuses the mock connector; use CONNECTOR_KIND=none with the manual destination workflow",
    );
  const requested = (
    env.CONNECTOR_CAPABILITIES || CONNECTOR_IMPLEMENTED[kind].join(",")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const capabilities: Capability[] = [];
  for (const cap of requested) {
    if (!(CAPABILITIES as readonly string[]).includes(cap))
      problems.push(`CONNECTOR_CAPABILITIES: unknown capability ${cap}`);
    else if (!CONNECTOR_IMPLEMENTED[kind].includes(cap as Capability))
      problems.push(
        `CONNECTOR_CAPABILITIES: ${cap} is not implemented by connector ${kind}`,
      );
    else capabilities.push(cap as Capability);
  }
  const tenantIds = env.WORKER_TENANT_IDS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const config: WorkerConfig = {
    ...c,
    runtime: "worker",
    databaseUrl: databaseUrlValue,
    connector: {
      kind,
      capabilities,
      faultMode: env.CONNECTOR_FAULT_MODE ?? "success",
    },
    dispatchMaxAttempts: Math.max(
      1,
      positiveInt(env, "DISPATCH_MAX_ATTEMPTS", 5, 50, problems),
    ),
    dispatchRetrySeconds: positiveInt(
      env,
      "DISPATCH_RETRY_SECONDS",
      5,
      3600,
      problems,
    ),
    reconcileMaxAttempts: Math.max(
      1,
      positiveInt(env, "RECONCILE_MAX_ATTEMPTS", 5, 50, problems),
    ),
    reconcileBaseSeconds: positiveInt(
      env,
      "RECONCILE_BASE_SECONDS",
      5,
      3600,
      problems,
    ),
    pollMs: Math.max(
      50,
      positiveInt(env, "WORKER_POLL_MS", 250, 60_000, problems),
    ),
    tenantIds: tenantIds?.length ? tenantIds : undefined,
  };
  if (
    c.secure &&
    env.CONNECTOR_FAULT_MODE &&
    env.CONNECTOR_FAULT_MODE !== "success"
  )
    problems.push(
      "CONNECTOR_FAULT_MODE fault injection is refused in secure profiles",
    );
  if (problems.length) throw new ConfigError(problems);
  return config;
}
