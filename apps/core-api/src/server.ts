import { ConfigError, loadApiConfig, type ApiConfig } from "@access/config";
import { createPool, verifyRuntimeIdentity } from "@access/db";
import { log } from "@access/observability";
import { buildApp } from "./app.js";
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
      : new SyntheticAuthenticator(),
  corsOrigins: config.corsOrigins,
  info: {
    profile: config.profile,
    dataMode: config.dataMode,
    buildId: config.buildId,
  },
});
await app.listen({ host: "0.0.0.0", port: config.port });
log("info", "api_started", {
  profile: config.profile,
  data_mode: config.dataMode,
  auth_mode: config.auth.mode,
  port: config.port,
  build: config.buildId,
});
