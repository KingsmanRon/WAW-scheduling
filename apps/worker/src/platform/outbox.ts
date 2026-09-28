import type pg from "pg";
import type { OutboxEventType } from "@access/contracts";
import { tenantTx, type DbClient } from "@access/db";
import { errorFields, log, type Metrics } from "@access/observability";

export interface OutboxEvent {
  tenant_id: string;
  /** bigint identity, as text. */
  id: string;
  practice_id: string | null;
  event_type: OutboxEventType;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  correlation_id: string;
  attempts: number;
  created_at: Date;
}
/** Handlers write only to the database, inside the event's transaction. */
export type OutboxHandler = (c: DbClient, event: OutboxEvent) => Promise<void>;
/** Every event type names its handlers explicitly (possibly none). */
export type OutboxRoutes = Record<OutboxEventType, readonly OutboxHandler[]>;

export interface OutboxRouterOptions {
  maxAttempts: number;
  /** Events per tenant per run. */
  batchSize: number;
  metrics?: Metrics;
}

/** Retry backoff for a failed handler: 10 s doubling, capped at 15 min. */
export function outboxBackoffSeconds(attempts: number): number {
  return Math.min(900, 10 * 2 ** Math.max(0, attempts - 1));
}
function failureCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/i.test(code))
    return `HANDLER_${code.toUpperCase()}`;
  return "HANDLER_ERROR";
}

/**
 * Transactional outbox consumer. One event per transaction: the event row is
 * locked (SKIP LOCKED, so workers share the load), its handlers run inside a
 * savepoint and it is marked PROCESSED in the same commit - the side effects
 * (delivery plans, integration events, offers) happen exactly once. Events of
 * one aggregate are processed in order: a later event waits while an earlier
 * one is still pending or backing off. A failing handler rolls back to the
 * savepoint and the event retries with backoff; after maxAttempts it is
 * FAILED (alerted, and re-queueable by an operator: see RUNBOOK.md).
 */
export class OutboxRouter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly routes: OutboxRoutes,
    private readonly options: OutboxRouterOptions,
  ) {}

  async run(tenantId: string): Promise<number> {
    let processed = 0;
    for (let i = 0; i < this.options.batchSize; i++) {
      const handled = await tenantTx(
        tenantId,
        (c) => this.processNext(c, tenantId),
        this.pool,
      );
      if (!handled) break;
      processed++;
    }
    return processed;
  }

  private async processNext(c: DbClient, tenantId: string): Promise<boolean> {
    const next = await c.query<OutboxEvent>(
      `SELECT o.tenant_id, o.id::text AS id, o.practice_id, o.event_type, o.aggregate_type, o.aggregate_id,
              o.payload, o.correlation_id, o.attempts, o.created_at
         FROM platform.outbox_events o
        WHERE o.tenant_id=$1 AND o.status='PENDING' AND o.available_at<=now()
          AND NOT EXISTS (SELECT 1 FROM platform.outbox_events e
                           WHERE e.tenant_id=o.tenant_id AND e.aggregate_id=o.aggregate_id AND e.id<o.id
                             AND e.status IN ('PENDING','PROCESSING'))
        ORDER BY o.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [tenantId],
    );
    const event = next.rows[0];
    if (!event) return false;
    const handlers = this.routes[event.event_type] ?? [];
    const started = Date.now();
    await c.query("SAVEPOINT outbox_handler");
    try {
      for (const handler of handlers) await handler(c, event);
      await c.query("RELEASE SAVEPOINT outbox_handler");
      await c.query(
        `UPDATE platform.outbox_events SET status='PROCESSED', processed_at=now(), attempts=attempts+1,
                lease_until=NULL, last_error_code=NULL
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, event.id],
      );
      this.options.metrics?.inc("outbox_events_processed_total", {
        event_type: event.event_type,
      });
      this.options.metrics?.observe(
        "outbox_event_latency_seconds",
        (Date.now() - new Date(event.created_at).getTime()) / 1000,
        { event_type: event.event_type },
      );
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT outbox_handler");
      const attempts = event.attempts + 1;
      const final = attempts >= this.options.maxAttempts;
      const code = failureCode(e);
      await c.query(
        final
          ? `UPDATE platform.outbox_events SET status='FAILED', attempts=$3, last_error_code=$4, lease_until=NULL
              WHERE tenant_id=$1 AND id=$2`
          : `UPDATE platform.outbox_events SET attempts=$3, last_error_code=$4, lease_until=NULL,
                    available_at=now()+make_interval(secs => $5)
              WHERE tenant_id=$1 AND id=$2`,
        final
          ? [tenantId, event.id, attempts, code]
          : [
              tenantId,
              event.id,
              attempts,
              code,
              outboxBackoffSeconds(attempts),
            ],
      );
      this.options.metrics?.inc(
        final ? "outbox_events_failed_total" : "outbox_events_retried_total",
        { event_type: event.event_type },
      );
      log(
        final ? "error" : "warn",
        final ? "outbox_event_failed" : "outbox_event_retry",
        {
          tenant_id: tenantId,
          practice_id: event.practice_id,
          event_id: event.id,
          event_type: event.event_type,
          attempts,
          code,
          ...errorFields(e),
        },
      );
    }
    this.options.metrics?.observe(
      "outbox_handler_seconds",
      (Date.now() - started) / 1000,
      { event_type: event.event_type },
    );
    return true;
  }
}
