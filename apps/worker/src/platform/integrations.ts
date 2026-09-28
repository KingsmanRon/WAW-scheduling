import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { OutboxEventType } from "@access/contracts";
import { tenantTx } from "@access/db";
import {
  DeliveryFailure,
  deliverWebhook,
  emrWebhookConfigSchema,
  resolveSecret,
  retryDelaySeconds,
  type EmrEventType,
  type TargetPolicy,
} from "@access/integrations";
import { errorFields, log, type Metrics } from "@access/observability";
import type { OutboxHandler } from "./outbox.js";

/** Appointment facts that leave the platform. Never names or free text. */
const APPOINTMENT_FIELDS = [
  "appointment_id",
  "status",
  "practitioner_id",
  "location_id",
  "appointment_type_id",
  "starts_at",
  "ends_at",
  "source_channel",
  "channel",
  "previous_appointment_id",
  "previous_starts_at",
  "previous_practitioner_id",
  "reason_code",
] as const;

export const OUTBOX_TO_EMR: Partial<Record<OutboxEventType, EmrEventType>> = {
  APPOINTMENT_CONFIRMED: "appointment.confirmed",
  APPOINTMENT_RESCHEDULED: "appointment.rescheduled",
  APPOINTMENT_CANCELLED: "appointment.cancelled",
  PATIENT_CHECKED_IN: "appointment.checked_in",
  APPOINTMENT_STARTED: "appointment.started",
  APPOINTMENT_COMPLETED: "appointment.completed",
  APPOINTMENT_NO_SHOW: "appointment.no_show",
};

/**
 * Outbox handler: queue one outbound integration event per active EMR
 * webhook connection subscribed to this event type. Runs in the outbox
 * transaction; the dedup key makes it exactly-once per connection.
 */
export function emrFanOut(type: EmrEventType): OutboxHandler {
  return async (c, e) => {
    if (!e.practice_id) return;
    const connections = await c.query<{ id: string; config: unknown }>(
      `SELECT id, config FROM integration.connections
        WHERE tenant_id=$1 AND practice_id=$2 AND provider='EMR_WEBHOOK' AND status='ACTIVE' ORDER BY id`,
      [e.tenant_id, e.practice_id],
    );
    if (!connections.rowCount) return;
    const patientId =
      typeof e.payload.patient_id === "string" ? e.payload.patient_id : null;
    const patient = patientId
      ? (
          await c.query<{ patient_number: string }>(
            `SELECT patient_number FROM directory.patients WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
            [e.tenant_id, e.practice_id, patientId],
          )
        ).rows[0]
      : undefined;
    const facts: Record<string, unknown> = {};
    for (const f of APPOINTMENT_FIELDS)
      if (e.payload[f] !== undefined && e.payload[f] !== null)
        facts[f] = e.payload[f];
    for (const connection of connections.rows) {
      const config = emrWebhookConfigSchema.safeParse(connection.config);
      if (!config.success) {
        log("warn", "integration_connection_invalid", {
          tenant_id: e.tenant_id,
          practice_id: e.practice_id,
          connection_id: connection.id,
        });
        continue;
      }
      if (!config.data.event_types.includes(type)) continue;
      const issuer = config.data.patient_identifier_issuer;
      const externalIds =
        issuer && patientId
          ? (
              await c.query<{ value: string }>(
                `SELECT value FROM directory.patient_identifiers
                  WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 AND system='EXTERNAL'
                    AND issuer=$4 AND removed_at IS NULL ORDER BY created_at`,
                [e.tenant_id, e.practice_id, patientId, issuer],
              )
            ).rows.map((r) => ({ issuer, value: r.value }))
          : [];
      const id = randomUUID();
      const body = {
        id,
        type,
        occurred_at: new Date(e.created_at).toISOString(),
        practice_id: e.practice_id,
        data: {
          ...facts,
          patient: patientId
            ? {
                id: patientId,
                patient_number: patient?.patient_number ?? null,
                external_ids: externalIds,
              }
            : null,
        },
      };
      await c.query(
        `INSERT INTO integration.events(tenant_id, practice_id, id, connection_id, direction, event_type, source_event_id,
                                        dedup_key, payload, status, next_attempt_at)
         VALUES($1,$2,$3,$4,'OUTBOUND',$5,$6,$7,$8,'PENDING',now())
         ON CONFLICT (tenant_id, practice_id, connection_id, dedup_key) DO NOTHING`,
        [
          e.tenant_id,
          e.practice_id,
          id,
          connection.id,
          type,
          e.id,
          `outbox:${e.id}`,
          JSON.stringify(body),
        ],
      );
    }
  };
}

export interface IntegrationDispatcherOptions {
  leaseSeconds: number;
  batchSize: number;
  timeoutMs: number;
  policy: TargetPolicy;
  env?: NodeJS.ProcessEnv;
  metrics?: Metrics;
  random?: () => number;
}
interface Claimed {
  practice_id: string;
  id: string;
  attempt_count: number;
  max_attempts: number;
}

/**
 * Delivers outbound integration events (EMR webhooks) with a lease per
 * attempt, bounded retries and permanent-failure detection. Receivers
 * de-duplicate on the event id, so a retry after an unclear outcome is safe.
 */
export class IntegrationDispatcher {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: IntegrationDispatcherOptions,
  ) {}

  async run(tenantId: string): Promise<number> {
    const claimed = await tenantTx(
      tenantId,
      (c) =>
        c.query<Claimed>(
          `WITH due AS (
             SELECT tenant_id, practice_id, id FROM integration.events
              WHERE tenant_id=$1 AND direction='OUTBOUND'
                AND ((status='PENDING' AND next_attempt_at<=now()) OR (status='PROCESSING' AND lease_until<now()))
              ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
           UPDATE integration.events e
              SET status='PROCESSING', lease_until=now()+make_interval(secs => $3), attempt_count=e.attempt_count+1
             FROM due WHERE e.tenant_id=due.tenant_id AND e.practice_id=due.practice_id AND e.id=due.id
           RETURNING e.practice_id, e.id, e.attempt_count, e.max_attempts`,
          [tenantId, this.options.batchSize, this.options.leaseSeconds],
        ),
      this.pool,
    );
    for (const item of claimed.rows) await this.deliver(tenantId, item);
    return claimed.rowCount ?? 0;
  }

  private async deliver(tenantId: string, item: Claimed): Promise<void> {
    const loaded = await tenantTx(
      tenantId,
      (c) =>
        c.query<{
          event_type: string;
          payload: unknown;
          connection_status: string;
          config: unknown;
          secret_ref: string | null;
        }>(
          `SELECT e.event_type, e.payload, k.status AS connection_status, k.config, k.secret_ref
             FROM integration.events e
             JOIN integration.connections k
               ON k.tenant_id=e.tenant_id AND k.practice_id=e.practice_id AND k.id=e.connection_id
            WHERE e.tenant_id=$1 AND e.practice_id=$2 AND e.id=$3 AND e.status='PROCESSING' AND e.attempt_count=$4`,
          [tenantId, item.practice_id, item.id, item.attempt_count],
        ),
      this.pool,
    );
    const row = loaded.rows[0];
    if (!row) return;
    try {
      if (row.connection_status !== "ACTIVE")
        throw new DeliveryFailure("PERMANENT", "CONNECTION_DISABLED");
      if (row.payload === null)
        throw new DeliveryFailure("PERMANENT", "PAYLOAD_REDACTED");
      const config = emrWebhookConfigSchema.safeParse(row.config);
      if (!config.success)
        throw new DeliveryFailure("CONFIGURATION", "CONNECTION_CONFIG_INVALID");
      const secret = resolveSecret(
        "EMR_WEBHOOK",
        row.secret_ref,
        this.options.env ?? process.env,
      );
      const started = Date.now();
      const result = await deliverWebhook({
        url: config.data.url,
        secret,
        eventId: item.id,
        eventType: row.event_type,
        body: JSON.stringify(row.payload),
        timeoutMs: this.options.timeoutMs,
        policy: this.options.policy,
      });
      this.options.metrics?.observe(
        "integration_delivery_seconds",
        (Date.now() - started) / 1000,
        { provider: "EMR_WEBHOOK" },
      );
      await tenantTx(
        tenantId,
        (c) =>
          c.query(
            `UPDATE integration.events
                SET status='DELIVERED', completed_at=now(), lease_until=NULL, response_status=$5,
                    external_reference=$6, last_error_code=NULL, last_error_detail=NULL
              WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='PROCESSING' AND attempt_count=$4`,
            [
              tenantId,
              item.practice_id,
              item.id,
              item.attempt_count,
              result.status,
              result.reference,
            ],
          ),
        this.pool,
      );
      this.options.metrics?.inc("integration_events_delivered_total", {
        provider: "EMR_WEBHOOK",
      });
      log("info", "integration_event_delivered", {
        tenant_id: tenantId,
        practice_id: item.practice_id,
        event_id: item.id,
        event_type: row.event_type,
        http_status: result.status,
        attempts: item.attempt_count,
      });
    } catch (e) {
      const failure =
        e instanceof DeliveryFailure
          ? e
          : new DeliveryFailure("TRANSIENT", "UNEXPECTED_ERROR");
      if (!(e instanceof DeliveryFailure))
        log("error", "integration_delivery_error", {
          tenant_id: tenantId,
          event_id: item.id,
          ...errorFields(e),
        });
      const final =
        failure.kind === "PERMANENT" || item.attempt_count >= item.max_attempts;
      const delay = retryDelaySeconds(
        item.attempt_count,
        failure,
        this.options.random,
      );
      await tenantTx(
        tenantId,
        (c) =>
          final
            ? c.query(
                `UPDATE integration.events
                    SET status='FAILED', completed_at=now(), lease_until=NULL, last_error_code=$5,
                        last_error_detail=$6, response_status=$7
                  WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='PROCESSING' AND attempt_count=$4`,
                [
                  tenantId,
                  item.practice_id,
                  item.id,
                  item.attempt_count,
                  failure.code,
                  failure.detail,
                  failure.httpStatus,
                ],
              )
            : c.query(
                `UPDATE integration.events
                    SET status='PENDING', next_attempt_at=now()+make_interval(secs => $8), lease_until=NULL,
                        last_error_code=$5, last_error_detail=$6, response_status=$7
                  WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='PROCESSING' AND attempt_count=$4`,
                [
                  tenantId,
                  item.practice_id,
                  item.id,
                  item.attempt_count,
                  failure.code,
                  failure.detail,
                  failure.httpStatus,
                  delay,
                ],
              ),
        this.pool,
      );
      this.options.metrics?.inc(
        final
          ? "integration_events_failed_total"
          : "integration_events_retried_total",
        { provider: "EMR_WEBHOOK", kind: failure.kind },
      );
      log(
        final ? "error" : "warn",
        final ? "integration_event_failed" : "integration_event_retry",
        {
          tenant_id: tenantId,
          practice_id: item.practice_id,
          event_id: item.id,
          event_type: row.event_type,
          code: failure.code,
          failure_kind: failure.kind,
          attempts: item.attempt_count,
          ...(final ? {} : { backoff_ms: delay * 1000 }),
        },
      );
    }
  }
}
