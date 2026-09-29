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

/**
 * Key for the HMAC digests of national ID and passport numbers
 * (directory.patient_identifiers). Rotating it requires re-hashing, so the
 * key id is stored with every digest.
 */
function identifierHashKey(
  env: Env,
  c: Common,
  problems: string[],
): { key: Buffer; keyId: string } {
  const hex = env.IDENTIFIER_HASH_KEY ?? "";
  const keyId = env.IDENTIFIER_HASH_KEY_ID ?? "k1";
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(keyId))
    problems.push(
      "IDENTIFIER_HASH_KEY_ID must be 1-40 characters of A-Z a-z 0-9 _ . -",
    );
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    problems.push("IDENTIFIER_HASH_KEY must be 64 hexadecimal characters");
    return { key: Buffer.alloc(32), keyId };
  }
  const key = Buffer.from(hex, "hex");
  if (c.profile !== "local" && new Set(key).size < 8)
    problems.push(
      "IDENTIFIER_HASH_KEY looks like a placeholder, not a random key",
    );
  if (
    env.ARTIFACT_ENCRYPTION_KEY &&
    env.ARTIFACT_ENCRYPTION_KEY.toLowerCase() === hex.toLowerCase() &&
    c.profile !== "local"
  )
    problems.push(
      "IDENTIFIER_HASH_KEY must differ from ARTIFACT_ENCRYPTION_KEY",
    );
  return { key, keyId };
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
  identifierHash: { key: Buffer; keyId: string };
  /** Bearer token protecting GET /metrics (required in secure profiles). */
  metricsToken: string | undefined;
  /** Local profile only: EMR webhooks to http:// or private addresses. */
  integrations: { allowPrivateTargets: boolean };
  /**
   * WhatsApp webhook credentials (the platform's Meta app). Both unset: the
   * WhatsApp channel is off and its webhook answers 404.
   */
  whatsapp: { appSecret: string; verifyToken: string } | null;
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

/**
 * What /health reports as the build: BUILD_ID when set, else the commit
 * Railway deployed from GitHub, else Railway's deployment id (CLI deploys).
 */
function buildId(env: Env): string {
  return (
    env.BUILD_ID ||
    env.RAILWAY_GIT_COMMIT_SHA ||
    env.RAILWAY_DEPLOYMENT_ID ||
    "dev"
  );
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
    buildId: buildId(env),
    identifierHash: identifierHashKey(env, c, problems),
    metricsToken: env.METRICS_TOKEN || undefined,
    integrations: {
      allowPrivateTargets: env.INTEGRATION_ALLOW_PRIVATE_TARGETS === "true",
    },
    whatsapp: whatsappWebhook(env, problems),
  };
  if (config.metricsToken !== undefined && config.metricsToken.length < 32)
    problems.push("METRICS_TOKEN must be at least 32 characters");
  if (c.secure && !config.metricsToken)
    problems.push(`${c.profile} requires METRICS_TOKEN to protect /metrics`);
  if (config.integrations.allowPrivateTargets && c.profile !== "local")
    problems.push(
      "INTEGRATION_ALLOW_PRIVATE_TARGETS is only permitted in the local profile",
    );
  if (problems.length) throw new ConfigError(problems);
  return config;
}

function whatsappWebhook(env: Env, problems: string[]): ApiConfig["whatsapp"] {
  const appSecret = env.WHATSAPP_APP_SECRET;
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN;
  if (!appSecret && !verifyToken) return null;
  if (!appSecret || !verifyToken) {
    problems.push(
      "WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN must be set together",
    );
    return null;
  }
  if (appSecret.length < 16)
    problems.push(
      "WHATSAPP_APP_SECRET looks too short to be a Meta app secret",
    );
  if (!/^[\w-]{16,200}$/.test(verifyToken))
    problems.push(
      "WHATSAPP_VERIFY_TOKEN must be 16-200 letters, digits, _ or -",
    );
  return { appSecret, verifyToken };
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
  /** Health, readiness and metrics HTTP port (Railway sets PORT). */
  port: number;
  buildId: string;
  metricsToken: string | undefined;
  whatsapp: { graphBaseUrl: string; apiVersion: string; timeoutMs: number };
  smtp: {
    url: string;
    from: string;
    requireTls: boolean;
    timeoutMs: number;
  } | null;
  notifications: {
    /**
     * Synthetic-data environments message only these recipients (E.164
     * numbers, e-mail addresses); null means no restriction (REAL data).
     */
    allowList: ReadonlySet<string> | null;
    leaseSeconds: number;
    batchSize: number;
  };
  integrations: { allowPrivateTargets: boolean; timeoutMs: number };
  /** Patient self-registration from channels hashes identifiers too. */
  identifierHash: { key: Buffer; keyId: string };
  accessLayer: { searchDays: number; maxSearchPages: number };
  /** Optional LLM understanding of free text; null: deterministic only. */
  intentClassifier: {
    provider: "anthropic";
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxPerMinute: number;
  } | null;
  outboxMaxAttempts: number;
  retention: {
    deliveryContentDays: number;
    channelMessageDays: number;
    integrationPayloadDays: number;
  };
}
const E164 = /^\+[1-9][0-9]{6,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function recipientAllowList(
  env: Env,
  c: Common,
  problems: string[],
): ReadonlySet<string> | null {
  const raw = env.NOTIFICATION_RECIPIENT_ALLOWLIST;
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.includes("@") ? s.toLowerCase() : s));
  for (const e of entries)
    if (!E164.test(e) && !EMAIL.test(e))
      problems.push(
        "NOTIFICATION_RECIPIENT_ALLOWLIST entries must be E.164 numbers or e-mail addresses",
      );
  // Synthetic patients may carry real people's numbers by accident: only
  // explicitly listed test recipients are ever messaged.
  if (c.dataMode === "SYNTHETIC") return new Set(entries);
  return raw === undefined || raw === "" ? null : new Set(entries);
}
function smtpConfig(
  env: Env,
  c: Common,
  problems: string[],
): WorkerConfig["smtp"] {
  const url = env.SMTP_URL;
  const from = env.SMTP_FROM;
  if (!url && !from) return null;
  if (!url || !from) {
    problems.push("SMTP_URL and SMTP_FROM must be set together");
    return null;
  }
  if (!/^smtps?:\/\//.test(url))
    problems.push("SMTP_URL must use smtp:// or smtps://");
  if (!/<[^@\s]+@[^@\s]+>$|^[^@\s<>]+@[^@\s<>]+$/.test(from.trim()))
    problems.push('SMTP_FROM must be an address or "Name <address>"');
  const requireTls = env.SMTP_REQUIRE_TLS !== "false";
  if (!requireTls && c.profile !== "local")
    problems.push(
      "SMTP_REQUIRE_TLS=false is only permitted in the local profile",
    );
  return {
    url,
    from: from.trim(),
    requireTls,
    timeoutMs: positiveInt(env, "SMTP_TIMEOUT_MS", 15_000, 120_000, problems),
  };
}
function intentClassifierConfig(
  env: Env,
  c: Common,
  problems: string[],
): WorkerConfig["intentClassifier"] {
  const provider = env.INTENT_CLASSIFIER || "off";
  if (provider === "off") return null;
  if (provider !== "anthropic") {
    problems.push("INTENT_CLASSIFIER must be off or anthropic");
    return null;
  }
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  if (apiKey.length < 20)
    problems.push("INTENT_CLASSIFIER=anthropic requires ANTHROPIC_API_KEY");
  const model = env.INTENT_CLASSIFIER_MODEL || "claude-opus-5";
  if (!/^claude-[a-z0-9.-]{1,64}$/.test(model))
    problems.push("INTENT_CLASSIFIER_MODEL must be a Claude model id");
  // Patient messages would leave the platform for a processor abroad
  // (POPIA section 72): real data needs the operator's explicit approval.
  if (
    c.dataMode === "REAL" &&
    env.INTENT_CLASSIFIER_PROCESSOR_APPROVED !== "true"
  )
    problems.push(
      "INTENT_CLASSIFIER with REAL data requires INTENT_CLASSIFIER_PROCESSOR_APPROVED=true (see SECURITY.md)",
    );
  return {
    provider: "anthropic",
    apiKey,
    model,
    timeoutMs: Math.max(
      500,
      positiveInt(env, "INTENT_CLASSIFIER_TIMEOUT_MS", 4000, 15_000, problems),
    ),
    maxPerMinute: Math.max(
      1,
      positiveInt(
        env,
        "INTENT_CLASSIFIER_MAX_PER_MINUTE",
        120,
        10_000,
        problems,
      ),
    ),
  };
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
    port: positiveInt(env, "PORT", 8081, 65535, problems),
    buildId: buildId(env),
    metricsToken: env.METRICS_TOKEN || undefined,
    whatsapp: {
      graphBaseUrl: (
        env.WHATSAPP_GRAPH_BASE_URL ?? "https://graph.facebook.com"
      ).replace(/\/+$/, ""),
      apiVersion: env.WHATSAPP_API_VERSION ?? "v23.0",
      timeoutMs: positiveInt(
        env,
        "WHATSAPP_TIMEOUT_MS",
        10_000,
        60_000,
        problems,
      ),
    },
    smtp: smtpConfig(env, c, problems),
    notifications: {
      allowList: recipientAllowList(env, c, problems),
      leaseSeconds: Math.max(
        15,
        positiveInt(env, "NOTIFICATION_LEASE_SECONDS", 60, 900, problems),
      ),
      batchSize: Math.max(
        1,
        positiveInt(env, "NOTIFICATION_BATCH_SIZE", 10, 200, problems),
      ),
    },
    integrations: {
      allowPrivateTargets: env.INTEGRATION_ALLOW_PRIVATE_TARGETS === "true",
      timeoutMs: positiveInt(
        env,
        "INTEGRATION_TIMEOUT_MS",
        10_000,
        60_000,
        problems,
      ),
    },
    identifierHash: identifierHashKey(env, c, problems),
    accessLayer: {
      searchDays: Math.max(
        1,
        positiveInt(env, "CHANNEL_SEARCH_DAYS", 7, 31, problems),
      ),
      maxSearchPages: Math.max(
        1,
        positiveInt(env, "CHANNEL_SEARCH_PAGES", 4, 12, problems),
      ),
    },
    intentClassifier: intentClassifierConfig(env, c, problems),
    outboxMaxAttempts: Math.max(
      1,
      positiveInt(env, "OUTBOX_MAX_ATTEMPTS", 10, 50, problems),
    ),
    retention: {
      deliveryContentDays: Math.max(
        7,
        positiveInt(
          env,
          "NOTIFICATION_CONTENT_RETENTION_DAYS",
          90,
          3650,
          problems,
        ),
      ),
      channelMessageDays: Math.max(
        7,
        positiveInt(env, "CHANNEL_MESSAGE_RETENTION_DAYS", 90, 3650, problems),
      ),
      integrationPayloadDays: Math.max(
        1,
        positiveInt(
          env,
          "INTEGRATION_PAYLOAD_RETENTION_DAYS",
          30,
          3650,
          problems,
        ),
      ),
    },
  };
  if (!/^v\d{1,3}\.\d{1,2}$/.test(config.whatsapp.apiVersion))
    problems.push("WHATSAPP_API_VERSION must look like v23.0");
  if (
    c.profile !== "local" &&
    !config.whatsapp.graphBaseUrl.startsWith("https://")
  )
    problems.push(
      "WHATSAPP_GRAPH_BASE_URL must be https outside the local profile",
    );
  if (config.integrations.allowPrivateTargets && c.profile !== "local")
    problems.push(
      "INTEGRATION_ALLOW_PRIVATE_TARGETS is only permitted in the local profile",
    );
  if (config.metricsToken !== undefined && config.metricsToken.length < 32)
    problems.push("METRICS_TOKEN must be at least 32 characters");
  if (c.secure && !config.metricsToken)
    problems.push(`${c.profile} requires METRICS_TOKEN to protect /metrics`);
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
