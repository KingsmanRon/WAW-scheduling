import { ConfigError, loadApiConfig, type ApiConfig } from "@access/config";
import { createPool, verifyRuntimeIdentity } from "@access/db";
import { configureLogging, log } from "@access/observability";
import { IdentifierHasher } from "@access/patients";
import { buildApp } from "./app.js";
import { downloadLinkKey } from "./referral-routes.js";
import { JwtAuthenticator, SyntheticAuthenticator } from "./auth.js";
import { IntakeExtractor } from "./extraction.js";
import {
  ClamAvScanner,
  MockSyntheticScanner,
  type ArtifactScanner,
} from "./scanner.js";
import { CaseService } from "./service.js";
import {
  LocalEncryptedArtifactStore,
  SupabaseStorageArtifactStore,
  type ArtifactStore,
} from "./storage.js";

let config: ApiConfig;
try {
  config = loadApiConfig();
} catch (e) {
  // Configuration problems name variables, never values.
  process.stderr.write(
    `${e instanceof ConfigError ? e.message : "configuration failed"}\n`,
  );
  process.exit(78);
}
configureLogging({
  service: "access-api",
  environment: config.profile,
  build: config.buildId,
});
const pool = createPool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl,
  caCertPath: config.databaseCaCertPath,
  caCert: config.databaseCaCert,
  applicationName: "access-api",
});
if (config.profile !== "local")
  await verifyRuntimeIdentity(pool, "access_request");

const artifacts: ArtifactStore =
  config.storage.kind === "supabase"
    ? new SupabaseStorageArtifactStore({
        url: config.storage.supabaseUrl!,
        bucket: config.storage.bucket!,
        serviceKey: config.storage.serviceKey!,
        encryptionKey: config.encryptionKey,
      })
    : new LocalEncryptedArtifactStore(
        config.storage.root,
        config.encryptionKey,
      );
await artifacts.verify();
const scanner: ArtifactScanner =
  config.scanner.kind === "clamav"
    ? new ClamAvScanner({
        host: config.scanner.host!,
        timeoutMs: config.scanner.timeoutMs,
        ...(config.scanner.port ? { port: config.scanner.port } : {}),
      })
    : new MockSyntheticScanner();
if (config.dataMode === "REAL" && !scanner.production)
  throw new Error("REAL data mode requires a production scanner");

const service = new CaseService({
  pool,
  artifacts,
  scanner,
  extractor: new IntakeExtractor({
    fixturesAllowed: config.extraction.fixturesAllowed,
  }),
  retentionDays: config.storage.retentionDays,
});
const app = await buildApp({
  pool,
  service,
  authenticator:
    config.auth.mode === "jwt"
      ? new JwtAuthenticator(config.auth, pool)
      : new SyntheticAuthenticator(pool),
  hasher: new IdentifierHasher(
    config.identifierHash.key,
    config.identifierHash.keyId,
  ),
  metricsToken: config.metricsToken,
  integrationPolicy: {
    allowInsecure: config.integrations.allowPrivateTargets,
  },
  whatsapp: config.whatsapp,
  documents: {
    store: artifacts,
    scanner,
    linkKey: downloadLinkKey(config.encryptionKey),
    retentionDays: config.storage.retentionDays,
  },
  corsOrigins: config.corsOrigins,
  info: {
    profile: config.profile,
    dataMode: config.dataMode,
    buildId: config.buildId,
  },
});
// "::" accepts IPv4 and IPv6 (Railway's private network is IPv6); hosts
// without IPv6 fall back to IPv4 only.
try {
  await app.listen({ host: "::", port: config.port });
} catch (e) {
  const code = (e as { code?: string }).code;
  if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL") throw e;
  await app.listen({ host: "0.0.0.0", port: config.port });
}
log("info", "api_started", {
  profile: config.profile,
  data_mode: config.dataMode,
  auth_mode: config.auth.mode,
  port: config.port,
  build: config.buildId,
});

// On deploy or scale-in the platform sends SIGTERM: stop accepting, let
// in-flight requests finish (their transactions commit or roll back whole),
// then release the pool. A request still running after 25 s is cut off.
let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log("info", "api_stopping", { status: signal });
  setTimeout(() => {
    log("error", "api_stop_timeout", {});
    process.exit(1);
  }, 25_000).unref();
  void app
    .close()
    .then(() => pool.end())
    .then(() => {
      log("info", "api_stopped", {});
      process.exit(0);
    });
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
