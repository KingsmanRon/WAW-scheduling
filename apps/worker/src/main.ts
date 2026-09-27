import {
  ConfigError,
  loadWorkerConfig,
  type WorkerConfig,
} from "@access/config";
import { createPool, verifyRuntimeIdentity } from "@access/db";
import { errorFields, log } from "@access/observability";
import {
  CapabilityGate,
  FAULT_MODES,
  MockConnector,
  NoConnector,
  type Connector,
  type FaultMode,
} from "./connector.js";
import { Dispatcher } from "./dispatcher.js";

let config: WorkerConfig;
try {
  config = loadWorkerConfig();
} catch (e) {
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
  applicationName: "access-worker",
});
if (config.profile !== "local")
  await verifyRuntimeIdentity(pool, "access_worker");
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
const dispatcher = new Dispatcher(pool, connector, gate, {
  maxDispatch: config.dispatchMaxAttempts,
  retrySeconds: config.dispatchRetrySeconds,
  maxReconcile: config.reconcileMaxAttempts,
  reconcileBaseSeconds: config.reconcileBaseSeconds,
  tenantIds: config.tenantIds,
});
log("info", "worker_started", {
  profile: config.profile,
  data_mode: config.dataMode,
  delay_ms: config.pollMs,
  capability: gate.list().join(","),
});
let lastSweep = 0;
for (;;) {
  try {
    const worked = await dispatcher.tick();
    await dispatcher.reconcile();
    await dispatcher.pollOutcomes();
    if (Date.now() - lastSweep > 60_000) {
      await dispatcher.sweepTimers();
      lastSweep = Date.now();
    }
    if (!worked) await new Promise((r) => setTimeout(r, config.pollMs));
  } catch (e) {
    log("error", "worker_tick_failed", errorFields(e));
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
}
