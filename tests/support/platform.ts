import { randomUUID } from "node:crypto";
import { loadWorkerConfig } from "../../packages/config/src/index.js";
import { Metrics } from "@access/observability";
import { setNotificationPreferences } from "../../packages/notifications/src/index.js";
import {
  createPlatformWorker,
  createTransports,
  type PlatformWorker,
} from "../../apps/worker/src/platform/index.js";
import type { NotificationTransports } from "../../packages/notifications/src/index.js";
import type { OutboxRoutes } from "../../apps/worker/src/platform/outbox.js";
import type { PlanEnvironment } from "../../packages/notifications/src/index.js";
import { ownerPool, workerPool } from "./harness.js";
import { run, staffCtx, type TestPractice } from "./scheduling.js";

export const WHATSAPP_TOKEN = "fixture-whatsapp-access-token-0123456789";
export const PHONE_NUMBER_ID = "1098765432";

export interface TestPlatform extends PlatformWorker {
  metrics: Metrics;
  /** Run outbox, notifications and integrations until nothing is left. */
  drain(): Promise<number>;
}

/** The worker's platform jobs for one tenant, wired as in production. */
export function testPlatform(
  tenantId: string,
  options: {
    graphUrl?: string;
    smtp?: { url: string; from: string };
    allowList?: string[];
    env?: Record<string, string>;
    outboxMaxAttempts?: number;
    transports?: NotificationTransports;
    routes?: (plan: PlanEnvironment) => OutboxRoutes;
  } = {},
): TestPlatform {
  const config = loadWorkerConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused.invalid/unused",
    WORKER_TENANT_IDS: tenantId,
    WHATSAPP_GRAPH_BASE_URL: options.graphUrl ?? "http://127.0.0.1:9",
    WHATSAPP_TIMEOUT_MS: "1500",
    INTEGRATION_ALLOW_PRIVATE_TARGETS: "true",
    INTEGRATION_TIMEOUT_MS: "1500",
    NOTIFICATION_RECIPIENT_ALLOWLIST: (options.allowList ?? []).join(","),
    ...(options.outboxMaxAttempts
      ? { OUTBOX_MAX_ATTEMPTS: String(options.outboxMaxAttempts) }
      : {}),
    ...(options.smtp
      ? {
          SMTP_URL: options.smtp.url,
          SMTP_FROM: options.smtp.from,
          SMTP_REQUIRE_TLS: "false",
        }
      : {}),
  });
  const env = { WHATSAPP_TEST_TOKEN: WHATSAPP_TOKEN, ...options.env };
  const metrics = new Metrics();
  const platform = createPlatformWorker(workerPool(), config, metrics, {
    transports: options.transports ?? createTransports(config, env),
    env,
    ...(options.routes ? { routes: options.routes } : {}),
  });
  return {
    ...platform,
    metrics,
    async drain() {
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const n =
          (await platform.outbox.run(tenantId)) +
          (await platform.notifications.run(tenantId)) +
          (await platform.integrations.run(tenantId));
        total += n;
        if (!n) break;
      }
      return total;
    },
  };
}

/** Connect the practice to WhatsApp as the operator would. */
export async function connectWhatsApp(
  p: Pick<TestPractice, "tenantId" | "practiceId">,
  config: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await ownerPool().query(
    `INSERT INTO integration.connections(tenant_id, practice_id, id, provider, name, status, config, secret_ref, created_by)
     VALUES($1,$2,$3,'WHATSAPP_CLOUD','Practice WhatsApp','ACTIVE',$4,'WHATSAPP_TEST_TOKEN','operator:test')`,
    [
      p.tenantId,
      p.practiceId,
      id,
      JSON.stringify({ phone_number_id: PHONE_NUMBER_ID, ...config }),
    ],
  );
  return id;
}

/** Record consent as reception staff would. */
export async function consent(
  p: TestPractice,
  patientId: string,
  prefs: {
    whatsapp?: boolean;
    email?: boolean;
    reminders?: boolean;
    preferred?: "WHATSAPP" | "EMAIL" | null;
  },
): Promise<void> {
  const ctx = staffCtx(p);
  await run(ctx, async (c) => {
    const current = await c.query<{ version: number }>(
      "SELECT version FROM messaging.notification_preferences WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3",
      [p.tenantId, p.practiceId, patientId],
    );
    await setNotificationPreferences(
      c,
      { tenantId: p.tenantId, practiceId: p.practiceId, actor: ctx.actor },
      patientId,
      {
        whatsappOptIn: prefs.whatsapp ?? false,
        emailOptIn: prefs.email ?? false,
        remindersEnabled: prefs.reminders ?? true,
        preferredChannel: prefs.preferred ?? null,
        expectedVersion: current.rows[0]?.version,
      },
    );
  });
}

export interface DeliveryRow {
  id: string;
  notification_type: string;
  channel: string;
  status: string;
  skip_reason: string | null;
  cancel_reason: string | null;
  attempt_count: number;
  last_error_code: string | null;
  provider_message_id: string | null;
  appointment_id: string | null;
  scheduled_for: Date;
  next_attempt_at: Date;
  recipient_address: string | null;
  template_params: string[] | null;
  template_name: string;
}
export async function deliveries(
  p: Pick<TestPractice, "tenantId" | "practiceId">,
  where = "TRUE",
  params: unknown[] = [],
): Promise<DeliveryRow[]> {
  const r = await ownerPool().query<DeliveryRow>(
    `SELECT id, notification_type, channel, status, skip_reason, cancel_reason, attempt_count, last_error_code,
            provider_message_id, appointment_id, scheduled_for, next_attempt_at, recipient_address, template_params,
            template_name
       FROM messaging.notification_deliveries
      WHERE tenant_id=$1 AND practice_id=$2 AND ${where}
      ORDER BY created_at, notification_type`,
    [p.tenantId, p.practiceId, ...params],
  );
  return r.rows;
}
/** Make planned deliveries due now (reminders are scheduled in the future). */
export async function makeDue(
  p: Pick<TestPractice, "tenantId" | "practiceId">,
  where = "status='PENDING'",
): Promise<void> {
  await ownerPool().query(
    `UPDATE messaging.notification_deliveries SET next_attempt_at=now()-interval '1 second', version=version+1
      WHERE tenant_id=$1 AND practice_id=$2 AND ${where}`,
    [p.tenantId, p.practiceId],
  );
}

/**
 * Test setup only: change rows as time would (created_at, expiry) without
 * the immutability triggers, as the migration owner.
 */
export async function asTimePasses(
  statements: [string, unknown[]][],
): Promise<void> {
  const c = await ownerPool().connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    for (const [sql, params] of statements) await c.query(sql, params);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
