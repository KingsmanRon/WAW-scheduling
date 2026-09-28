import {
  ConfigError,
  loadWorkerConfig,
  type WorkerConfig,
} from "@access/config";
import { createPool, verifyRuntimeIdentity } from "@access/db";
import {
  Metrics,
  configureLogging,
  errorFields,
  log,
} from "@access/observability";
import {
  CapabilityGate,
  FAULT_MODES,
  MockConnector,
  NoConnector,
  type Connector,
  type FaultMode,
} from "./connector.js";
import { Dispatcher } from "./dispatcher.js";
import {
  createPlatformWorker,
  describeWorkerMetrics,
  startHealthServer,
} from "./platform/index.js";

let config: WorkerConfig;
try {
  config = loadWorkerConfig();
} catch (e) {
  process.stderr.write(
    `${e instanceof ConfigError ? e.message : "configuration failed"}\n`,
  );
  process.exit(78);
}
configureLogging({
  service: "access-worker",
  environment: config.profile,
  build: config.buildId,
});
const pool = createPool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl,
  caCertPath: config.databaseCaCertPath,
  caCert: config.databaseCaCert,
  applicationName: "access-worker",
});
if (config.profile !== "local")
  await verifyRuntimeIdentity(pool, "access_worker");

// Referral pipeline: destination submission, read-back and timers.
const fault = config.connector.faultMode as FaultMode;
if (!FAULT_MODES.includes(fault))
  throw new Error("CONNECTOR_FAULT_MODE unknown");
const connector: Connector =
  config.connector.kind === "mock"
    ? new MockConnector({
        fault,
        appointmentOutcome: (process.env.MOCK_APPOINTMENT_OUTCOME ??
          "NONE") as never,
      })
    : new NoConnector();
const gate = new CapabilityGate(connector, config.connector.capabilities);
const referrals = new Dispatcher(pool, connector, gate, {
  maxDispatch: config.dispatchMaxAttempts,
  retrySeconds: config.dispatchRetrySeconds,
  maxReconcile: config.reconcileMaxAttempts,
  reconcileBaseSeconds: config.reconcileBaseSeconds,
  tenantIds: config.tenantIds,
});

// Scheduling platform: outbox, notifications, integrations, housekeeping.
const metrics = new Metrics();
describeWorkerMetrics(metrics);
const platform = createPlatformWorker(pool, config, metrics);

let lastCycle = Date.now();
// A cycle can legitimately take a while (provider timeouts); a loop that has
// not completed one in five minutes is stuck.
const stalledAfterMs = Math.max(300_000, config.pollMs * 20);
const server = await startHealthServer({
  port: config.port,
  metrics,
  metricsToken: config.metricsToken,
  build: config.buildId,
  live: () => Date.now() - lastCycle < stalledAfterMs,
  ready: async () => {
    await pool.query("SELECT 1");
    return true;
  },
});
log("info", "worker_started", {
  profile: config.profile,
  data_mode: config.dataMode,
  delay_ms: config.pollMs,
  port: config.port,
  capability: gate.list().join(","),
});

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log("info", "worker_stopping", { status: signal });
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

let lastSweep = 0;
while (!stopping) {
  try {
    const referralWork = await referrals.tick();
    await referrals.reconcile();
    await referrals.pollOutcomes();
    if (Date.now() - lastSweep > 60_000) {
      await referrals.sweepTimers();
      lastSweep = Date.now();
    }
    const platformWork = await platform.runner.tick();
    lastCycle = Date.now();
    if (!referralWork && !platformWork && !stopping)
      await new Promise((r) => setTimeout(r, config.pollMs));
  } catch (e) {
    metrics.inc("worker_job_errors_total", { job: "loop" });
    log("error", "worker_tick_failed", errorFields(e));
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
}
// Leases held by an interrupted cycle simply expire; nothing else to undo.
await new Promise<void>((r) => server.close(() => r()));
await pool.end();
log("info", "worker_stopped", {});
process.exit(0);
