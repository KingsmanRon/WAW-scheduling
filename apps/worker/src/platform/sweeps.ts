import { randomUUID } from "node:crypto";
import type pg from "pg";
import { tenantTx } from "@access/db";
import {
  planAppointmentMessages,
  type PlanEnvironment,
} from "@access/notifications";
import { log, type Metrics } from "@access/observability";
import {
  SYSTEM_SCHEDULING_ACTOR,
  expireStaleHolds,
  inPracticeTransaction,
  type CommandContext,
} from "@access/scheduling";

export interface SweepOptions {
  retention: {
    deliveryContentDays: number;
    channelMessageDays: number;
    integrationPayloadDays: number;
  };
  plan: PlanEnvironment;
  metrics?: Metrics;
}

/**
 * Periodic housekeeping. Every sweep is idempotent and bounded per run, and
 * none is needed for correctness of reads: an expired hold, for example,
 * already stops blocking availability the moment it lapses; the sweep only
 * records the expiry (history, outbox, audit).
 */
export class Sweeps {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: SweepOptions,
  ) {}

  private async practices(tenantId: string): Promise<string[]> {
    const r = await tenantTx(
      tenantId,
      (c) =>
        c.query<{ id: string }>(
          "SELECT id FROM directory.practices WHERE tenant_id=$1 AND status='ACTIVE' ORDER BY id",
          [tenantId],
        ),
      this.pool,
    );
    return r.rows.map((p) => p.id);
  }

  /** Record lapsed holds as EXPIRED through the Scheduling Core. */
  async expireHolds(tenantId: string): Promise<number> {
    let expired = 0;
    for (const practiceId of await this.practices(tenantId)) {
      const ctx: CommandContext = {
        tenantId,
        practiceId,
        actor: SYSTEM_SCHEDULING_ACTOR,
        channel: "INTERNAL",
        correlationId: randomUUID(),
      };
      expired += await inPracticeTransaction(this.pool, ctx, (c) =>
        expireStaleHolds(c, ctx, { limit: 200 }),
      );
    }
    if (expired) this.options.metrics?.inc("holds_expired_total", {}, expired);
    return expired;
  }

  /** Idempotency keys past their replay window. */
  async purgeIdempotencyKeys(tenantId: string): Promise<number> {
    const r = await tenantTx(
      tenantId,
      (c) =>
        c.query(
          `DELETE FROM platform.idempotency_keys
            WHERE tenant_id=$1 AND ctid IN (SELECT ctid FROM platform.idempotency_keys
                                             WHERE tenant_id=$1 AND expires_at<=now() LIMIT 1000)`,
          [tenantId],
        ),
      this.pool,
    );
    return r.rowCount ?? 0;
  }

  /** Provider webhook de-duplication receipts older than 30 days. */
  async purgeWebhookReceipts(tenantId: string): Promise<number> {
    const r = await tenantTx(
      tenantId,
      (c) =>
        c.query(
          `DELETE FROM integration.webhook_receipts
            WHERE tenant_id=$1 AND ctid IN (SELECT ctid FROM integration.webhook_receipts
                                             WHERE tenant_id=$1 AND received_at < now() - interval '30 days' LIMIT 1000)`,
          [tenantId],
        ),
      this.pool,
    );
    return r.rowCount ?? 0;
  }

  /**
   * Retention: message content, recipient addresses and integration
   * payloads are operational data, removed (and the removal recorded) once
   * their retention period has passed. Status, times and identifiers stay
   * for audit and reporting.
   */
  async redactExpiredContent(tenantId: string): Promise<number> {
    const { retention } = this.options;
    return tenantTx(
      tenantId,
      async (c) => {
        const deliveries = await c.query(
          `UPDATE messaging.notification_deliveries
              SET template_params=NULL, recipient_address=NULL, last_error_detail=NULL, redacted_at=now(),
                  version=version+1
            WHERE (tenant_id, practice_id, id) IN (
                  SELECT tenant_id, practice_id, id FROM messaging.notification_deliveries
                   WHERE tenant_id=$1 AND redacted_at IS NULL
                     AND status IN ('SENT','DELIVERED','READ','FAILED','CANCELLED','SKIPPED')
                     AND created_at < now() - make_interval(days => $2)
                   LIMIT 500)`,
          [tenantId, retention.deliveryContentDays],
        );
        const messages = await c.query(
          `UPDATE messaging.channel_messages SET body=NULL, payload=NULL, redacted_at=now()
            WHERE (tenant_id, practice_id, id) IN (
                  SELECT tenant_id, practice_id, id FROM messaging.channel_messages
                   WHERE tenant_id=$1 AND redacted_at IS NULL
                     AND status IN ('PROCESSED','FAILED','SENT','DELIVERED','READ')
                     AND created_at < now() - make_interval(days => $2)
                   LIMIT 500)`,
          [tenantId, retention.channelMessageDays],
        );
        const events = await c.query(
          `UPDATE integration.events SET payload=NULL, last_error_detail=NULL, redacted_at=now()
            WHERE (tenant_id, practice_id, id) IN (
                  SELECT tenant_id, practice_id, id FROM integration.events
                   WHERE tenant_id=$1 AND redacted_at IS NULL AND completed_at IS NOT NULL
                     AND completed_at < now() - make_interval(days => $2)
                   LIMIT 500)`,
          [tenantId, retention.integrationPayloadDays],
        );
        const n =
          (deliveries.rowCount ?? 0) +
          (messages.rowCount ?? 0) +
          (events.rowCount ?? 0);
        if (n)
          log("info", "retention_redacted", {
            tenant_id: tenantId,
            count: n,
          });
        return n;
      },
      this.pool,
    );
  }

  /**
   * Reconciliation: confirmed appointments in the next two days that are
   * missing a reminder their practice's settings call for (an outbox event
   * that failed, or a reminder switched on after booking) get it planned.
   * Planning is idempotent, so this can never duplicate a message.
   */
  async reconcileReminders(tenantId: string): Promise<number> {
    const due = await tenantTx(
      tenantId,
      (c) =>
        c.query<{ practice_id: string; id: string }>(
          `SELECT a.practice_id, a.id FROM scheduling.appointments a
             JOIN directory.practices p ON p.tenant_id=a.tenant_id AND p.id=a.practice_id
            WHERE a.tenant_id=$1 AND a.status='CONFIRMED' AND p.status='ACTIVE'
              AND a.starts_at > now() + interval '10 minutes' AND a.starts_at <= now() + interval '49 hours'
              AND ((p.reminder_24h_enabled AND a.starts_at - interval '24 hours' > now() + interval '5 minutes'
                    AND NOT EXISTS (SELECT 1 FROM messaging.notification_deliveries d
                                     WHERE d.tenant_id=a.tenant_id AND d.practice_id=a.practice_id
                                       AND d.appointment_id=a.id AND d.notification_type='APPOINTMENT_REMINDER_24H'
                                       AND d.appointment_starts_at=a.starts_at))
                OR (p.near_term_reminder_minutes IS NOT NULL
                    AND a.starts_at - make_interval(mins => p.near_term_reminder_minutes) > now() + interval '5 minutes'
                    AND NOT EXISTS (SELECT 1 FROM messaging.notification_deliveries d
                                     WHERE d.tenant_id=a.tenant_id AND d.practice_id=a.practice_id
                                       AND d.appointment_id=a.id AND d.notification_type='APPOINTMENT_REMINDER_NEAR_TERM'
                                       AND d.appointment_starts_at=a.starts_at)))
            ORDER BY a.starts_at LIMIT 200`,
          [tenantId],
        ),
      this.pool,
    );
    let planned = 0;
    for (const a of due.rows)
      planned += await tenantTx(
        tenantId,
        (c) =>
          planAppointmentMessages(
            c,
            { tenantId, practiceId: a.practice_id, sourceEventId: null },
            this.options.plan,
            a.id,
            "CONFIRMED",
            null,
            false,
          ),
        this.pool,
      );
    if (planned) {
      this.options.metrics?.inc("reminders_reconciled_total", {}, planned);
      log("warn", "reminders_reconciled", {
        tenant_id: tenantId,
        count: planned,
      });
    }
    return planned;
  }

  /** Queue depth and age, summed over the tenants passed in. */
  async queueStats(tenantIds: readonly string[]): Promise<void> {
    const totals = {
      outbox_pending: 0,
      outbox_failed: 0,
      outbox_oldest_pending_seconds: 0,
      notifications_pending: 0,
      notifications_failed_24h: 0,
      integration_events_pending: 0,
      integration_events_failed_24h: 0,
    };
    for (const tenantId of tenantIds) {
      const r = await tenantTx(
        tenantId,
        (c) =>
          c.query<{
            outbox_pending: number;
            outbox_failed: number;
            outbox_oldest: number | null;
            notifications_pending: number;
            notifications_failed: number;
            integration_pending: number;
            integration_failed: number;
          }>(
            `SELECT
               (SELECT count(*)::int FROM platform.outbox_events WHERE tenant_id=$1 AND status IN ('PENDING','PROCESSING')) AS outbox_pending,
               (SELECT count(*)::int FROM platform.outbox_events WHERE tenant_id=$1 AND status='FAILED') AS outbox_failed,
               (SELECT extract(epoch FROM now()-min(created_at))::float8 FROM platform.outbox_events
                 WHERE tenant_id=$1 AND status IN ('PENDING','PROCESSING')) AS outbox_oldest,
               (SELECT count(*)::int FROM messaging.notification_deliveries
                 WHERE tenant_id=$1 AND status IN ('PENDING','PROCESSING') AND next_attempt_at<=now()) AS notifications_pending,
               (SELECT count(*)::int FROM messaging.notification_deliveries
                 WHERE tenant_id=$1 AND status='FAILED' AND failed_at > now() - interval '24 hours') AS notifications_failed,
               (SELECT count(*)::int FROM integration.events
                 WHERE tenant_id=$1 AND status IN ('PENDING','PROCESSING') AND next_attempt_at<=now()) AS integration_pending,
               (SELECT count(*)::int FROM integration.events
                 WHERE tenant_id=$1 AND status='FAILED' AND completed_at > now() - interval '24 hours') AS integration_failed`,
            [tenantId],
          ),
        this.pool,
      );
      const s = r.rows[0]!;
      totals.outbox_pending += s.outbox_pending;
      totals.outbox_failed += s.outbox_failed;
      totals.outbox_oldest_pending_seconds = Math.max(
        totals.outbox_oldest_pending_seconds,
        s.outbox_oldest ?? 0,
      );
      totals.notifications_pending += s.notifications_pending;
      totals.notifications_failed_24h += s.notifications_failed;
      totals.integration_events_pending += s.integration_pending;
      totals.integration_events_failed_24h += s.integration_failed;
    }
    for (const [name, value] of Object.entries(totals))
      this.options.metrics?.set(name, value);
  }
}
