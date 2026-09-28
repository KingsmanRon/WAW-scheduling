import type pg from "pg";
import {
  AnthropicIntentClassifier,
  OutboundDispatcher,
  channelMessageHandler,
  type IntentClassifier,
  type OutboundOptions,
} from "@access/access";
import type { WorkerConfig } from "@access/config";
import {
  SmtpSender,
  WhatsAppCloudClient,
  resolveSecret,
} from "@access/integrations";
import {
  NotificationDispatcher,
  type NotificationTransports,
  type PlanEnvironment,
} from "@access/notifications";
import type { Metrics } from "@access/observability";
import { IdentifierHasher } from "@access/patients";
import { IntegrationDispatcher } from "./integrations.js";
import { OutboxRouter, type OutboxRoutes } from "./outbox.js";
import { extendRoutes, platformRoutes } from "./routes.js";
import { JobRunner, type Job } from "./runner.js";
import { Sweeps } from "./sweeps.js";

export * from "./outbox.js";
export * from "./routes.js";
export * from "./integrations.js";
export * from "./sweeps.js";
export * from "./runner.js";
export * from "./health.js";

/** A Graph API client for one practice's WhatsApp connection. */
export function whatsAppClients(
  config: WorkerConfig,
  env: NodeJS.ProcessEnv = process.env,
): (connection: {
  config: { phone_number_id: string };
  secretRef: string | null;
}) => WhatsAppCloudClient {
  // Only a local fixture of the Graph API may be plain http.
  const allowInsecure =
    config.profile === "local" &&
    !config.whatsapp.graphBaseUrl.startsWith("https://");
  return (connection) =>
    new WhatsAppCloudClient({
      baseUrl: config.whatsapp.graphBaseUrl,
      apiVersion: config.whatsapp.apiVersion,
      accessToken: resolveSecret("WHATSAPP_CLOUD", connection.secretRef, env),
      phoneNumberId: connection.config.phone_number_id,
      timeoutMs: config.whatsapp.timeoutMs,
      policy: { allowInsecure },
    });
}

/** Real provider adapters, configured from the environment. */
export function createTransports(
  config: WorkerConfig,
  env: NodeJS.ProcessEnv = process.env,
): NotificationTransports {
  return {
    whatsapp: whatsAppClients(config, env),
    email: config.smtp ? new SmtpSender(config.smtp) : null,
  };
}

export function describeWorkerMetrics(metrics: Metrics): void {
  metrics
    .describe("outbox_events_processed_total", "Outbox events handled, by type")
    .describe(
      "outbox_events_retried_total",
      "Outbox handler failures that will retry",
    )
    .describe(
      "outbox_events_failed_total",
      "Outbox events that exhausted their attempts",
    )
    .describe(
      "outbox_event_latency_seconds",
      "Time from outbox write to handling",
    )
    .describe("outbox_handler_seconds", "Outbox handler duration")
    .describe("outbox_pending", "Outbox events waiting (all tenants)")
    .describe("outbox_failed", "Outbox events in FAILED (all tenants)")
    .describe(
      "outbox_oldest_pending_seconds",
      "Age of the oldest waiting outbox event",
    )
    .describe(
      "notifications_sent_total",
      "Notifications accepted by the provider",
    )
    .describe(
      "notifications_retried_total",
      "Notification attempts that will retry",
    )
    .describe(
      "notifications_failed_total",
      "Notifications that failed permanently",
    )
    .describe(
      "notifications_skipped_total",
      "Notifications not sent, by reason",
    )
    .describe(
      "notifications_cancelled_total",
      "Planned notifications withdrawn before sending",
    )
    .describe("notification_send_seconds", "Provider call duration")
    .describe("notifications_pending", "Deliveries due now (all tenants)")
    .describe(
      "notifications_failed_24h",
      "Deliveries failed in the last 24 hours",
    )
    .describe(
      "integration_events_delivered_total",
      "Integration events acknowledged",
    )
    .describe(
      "integration_events_retried_total",
      "Integration attempts that will retry",
    )
    .describe(
      "integration_events_failed_total",
      "Integration events that failed permanently",
    )
    .describe("integration_delivery_seconds", "Integration call duration")
    .describe(
      "integration_events_pending",
      "Integration events due now (all tenants)",
    )
    .describe(
      "integration_events_failed_24h",
      "Integration events failed in the last 24 hours",
    )
    .describe("holds_expired_total", "Lapsed holds recorded as expired")
    .describe(
      "reminders_reconciled_total",
      "Missing reminders planned by reconciliation",
    )
    .describe("worker_job_seconds", "Background job cycle duration")
    .describe("worker_job_items_total", "Items handled by background jobs")
    .describe("worker_job_errors_total", "Background job failures")
    .describe(
      "channel_messages_sent_total",
      "Conversation replies accepted by WhatsApp",
    )
    .describe(
      "channel_messages_retried_total",
      "Conversation replies that will retry",
    )
    .describe(
      "channel_messages_failed_total",
      "Conversation replies that failed",
    )
    .describe(
      "intent_classifier_requests_total",
      "Free-text classifications, by outcome",
    )
    .describe("intent_classifier_seconds", "Intent classifier call duration");
}

/** The configured free-text classifier, if any (off by default). */
export function createIntentClassifier(
  config: WorkerConfig,
  metrics: Metrics,
): IntentClassifier | undefined {
  const c = config.intentClassifier;
  if (!c) return undefined;
  return new AnthropicIntentClassifier({
    apiKey: c.apiKey,
    model: c.model,
    timeoutMs: c.timeoutMs,
    maxPerMinute: c.maxPerMinute,
    metrics,
  });
}

export interface PlatformWorker {
  runner: JobRunner;
  outbox: OutboxRouter;
  outbound: OutboundDispatcher;
  routes: OutboxRoutes;
  notifications: NotificationDispatcher;
  integrations: IntegrationDispatcher;
  sweeps: Sweeps;
}

/**
 * The scheduling platform's background work: outbox routing, notification
 * delivery, integration delivery and housekeeping, as jobs over tenants.
 */
export function createPlatformWorker(
  pool: pg.Pool,
  config: WorkerConfig,
  metrics: Metrics,
  deps: {
    transports?: NotificationTransports;
    /** Session (conversation) message sender; defaults to the Graph API. */
    sessions?: OutboundOptions["sender"];
    routes?: (plan: PlanEnvironment) => OutboxRoutes;
    now?: () => Date;
    classifier?: IntentClassifier;
    /** Where connection secrets are looked up (default process.env). */
    env?: NodeJS.ProcessEnv;
  } = {},
): PlatformWorker {
  const env = deps.env ?? process.env;
  const transports = deps.transports ?? createTransports(config, env);
  const now = deps.now ?? (() => new Date());
  const plan: PlanEnvironment = {
    emailConfigured: transports.email !== null,
    allowList: config.notifications.allowList,
    now,
  };
  // The access layer answers patient conversations (WhatsApp).
  const classifier = deps.classifier ?? createIntentClassifier(config, metrics);
  const conversations = channelMessageHandler({
    hasher: new IdentifierHasher(
      config.identifierHash.key,
      config.identifierHash.keyId,
    ),
    now,
    searchDays: config.accessLayer.searchDays,
    maxSearchPages: config.accessLayer.maxSearchPages,
    ...(classifier ? { classifier } : {}),
  });
  const routes = extendRoutes((deps.routes ?? platformRoutes)(plan), {
    CHANNEL_MESSAGE_RECEIVED: [conversations],
  });
  const outbound = new OutboundDispatcher(pool, {
    sender: deps.sessions ?? whatsAppClients(config, env),
    leaseSeconds: 60,
    batchSize: 20,
    metrics,
  });
  const router = new OutboxRouter(pool, routes, {
    maxAttempts: config.outboxMaxAttempts,
    batchSize: 50,
    metrics,
  });
  const notifications = new NotificationDispatcher(pool, transports, {
    leaseSeconds: config.notifications.leaseSeconds,
    batchSize: config.notifications.batchSize,
    allowList: config.notifications.allowList,
    now,
    metrics,
  });
  const integrations = new IntegrationDispatcher(pool, {
    leaseSeconds: Math.max(
      60,
      Math.ceil(config.integrations.timeoutMs / 1000) * 3,
    ),
    batchSize: 5,
    timeoutMs: config.integrations.timeoutMs,
    policy: { allowInsecure: config.integrations.allowPrivateTargets },
    env,
    metrics,
  });
  const sweeps = new Sweeps(pool, {
    retention: config.retention,
    plan,
    metrics,
  });
  const jobs: Job[] = [
    { name: "outbox", everyMs: 0, run: (t) => router.run(t) },
    { name: "channel_outbound", everyMs: 0, run: (t) => outbound.run(t) },
    { name: "notifications", everyMs: 0, run: (t) => notifications.run(t) },
    { name: "integrations", everyMs: 0, run: (t) => integrations.run(t) },
    { name: "hold_expiry", everyMs: 15_000, run: (t) => sweeps.expireHolds(t) },
    {
      name: "reminder_reconciliation",
      everyMs: 10 * 60_000,
      run: (t) => sweeps.reconcileReminders(t),
    },
    {
      name: "idempotency_purge",
      everyMs: 10 * 60_000,
      run: (t) => sweeps.purgeIdempotencyKeys(t),
    },
    {
      name: "webhook_receipt_purge",
      everyMs: 60 * 60_000,
      run: (t) => sweeps.purgeWebhookReceipts(t),
    },
    {
      name: "retention",
      everyMs: 60 * 60_000,
      run: (t) => sweeps.redactExpiredContent(t),
    },
    {
      name: "queue_stats",
      everyMs: 30_000,
      run: async () => 0,
      after: (tenants) => sweeps.queueStats(tenants),
    },
  ];
  const runner = new JobRunner(pool, jobs, {
    tenantIds: config.tenantIds,
    metrics,
  });
  return {
    runner,
    outbox: router,
    outbound,
    routes,
    notifications,
    integrations,
    sweeps,
  };
}
