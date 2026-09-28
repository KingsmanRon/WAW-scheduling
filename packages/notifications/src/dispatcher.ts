import type pg from "pg";
import type { NotificationChannel, NotificationType } from "@access/contracts";
import { tenantTx, type DbClient } from "@access/db";
import {
  DeliveryFailure,
  retryDelaySeconds,
  whatsAppConnectionConfigSchema,
  type WhatsAppConnectionConfig,
} from "@access/integrations";
import { errorFields, log, type Metrics } from "@access/observability";
import {
  NOTIFICATION_CATALOGUE,
  formatDeadline,
  formatWhen,
  type MessageFacts,
} from "./catalogue.js";
import { loadRecipientData, templateFor } from "./planner.js";
import {
  resolveChannel,
  type Recipient,
  type SkipReason,
} from "./selection.js";

/** Ports to the providers (implemented with @access/integrations). */
export interface TemplateMessage {
  to: string;
  name: string;
  language: string;
  bodyParams: string[];
  buttonPayloads?: string[];
  callbackData?: string;
}
export interface TemplateSender {
  sendTemplate(message: TemplateMessage): Promise<{ messageId: string }>;
}
export interface EmailSender {
  send(message: {
    to: string;
    subject: string;
    text: string;
    reference: string;
  }): Promise<{ messageId: string }>;
}
export interface WhatsAppConnection {
  id: string;
  config: WhatsAppConnectionConfig;
  secretRef: string | null;
}
export interface NotificationTransports {
  /** Throws DeliveryFailure(CONFIGURATION) when the connection is unusable. */
  whatsapp(connection: WhatsAppConnection): TemplateSender;
  email: EmailSender | null;
}
export interface DispatcherOptions {
  leaseSeconds: number;
  batchSize: number;
  allowList: ReadonlySet<string> | null;
  now?: () => Date;
  metrics?: Metrics;
  random?: () => number;
}

/** How long before the appointment each type still makes sense. */
const LATEST_LEAD_MS: Record<NotificationType, number> = {
  APPOINTMENT_CONFIRMATION: 15 * 60_000,
  APPOINTMENT_RESCHEDULED: 15 * 60_000,
  APPOINTMENT_CANCELLED: 0,
  APPOINTMENT_REMINDER_24H: 2 * 3600_000,
  APPOINTMENT_REMINDER_NEAR_TERM: 5 * 60_000,
  WAITLIST_OFFER: 0,
};

interface Claimed {
  practice_id: string;
  id: string;
  attempt_count: number;
  max_attempts: number;
}
interface DeliveryRow {
  id: string;
  practice_id: string;
  notification_type: NotificationType;
  channel: NotificationChannel;
  patient_id: string;
  appointment_id: string | null;
  waitlist_offer_id: string | null;
  appointment_starts_at: Date | null;
  attempt_count: number;
  max_attempts: number;
  given_name: string;
  preferred_name: string | null;
  patient_status: string;
  practice_name: string;
  practice_timezone: string;
  appointment_status: string | null;
  appointment_start: Date | null;
  appointment_practitioner: string | null;
  appointment_location: string | null;
  appointment_timezone: string | null;
  offer_status: string | null;
  offer_start: Date | null;
  offer_expires: Date | null;
  offer_practitioner: string | null;
  offer_location: string | null;
  offer_timezone: string | null;
}
type Prepared =
  | {
      kind: "send";
      row: DeliveryRow;
      recipient: Recipient;
      facts: MessageFacts;
      template: { name: string; language: string };
      connection: WhatsAppConnection | null;
    }
  | { kind: "skip"; reason: SkipReason }
  | { kind: "cancel"; reason: "OFFER_CLOSED" }
  | { kind: "gone" };

/**
 * Sends due notification deliveries. Each delivery is claimed with a lease
 * (attempt counted), re-validated against current facts in its own
 * transaction, sent outside any transaction, and its outcome recorded only
 * if this worker still holds the claim. Permanent refusals never retry;
 * everything else retries with backoff up to the delivery's max_attempts.
 *
 * Delivery is at-least-once in one narrow case: a worker that dies after
 * the provider accepted a message but before recording it. The WhatsApp
 * callback data (delivery id) lets the status webhook record the send, and
 * a re-claim waits for the lease (and ambiguous backoff) first, so the
 * common case never repeats a message.
 */
export class NotificationDispatcher {
  private readonly now: () => Date;
  private readonly random: () => number;
  constructor(
    private readonly pool: pg.Pool,
    private readonly transports: NotificationTransports,
    private readonly options: DispatcherOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  /** Process due deliveries of one tenant; returns how many were handled. */
  async run(tenantId: string): Promise<number> {
    const claimed = await tenantTx(
      tenantId,
      (c) =>
        c.query<Claimed>(
          `WITH due AS (
             SELECT tenant_id, practice_id, id FROM messaging.notification_deliveries
              WHERE tenant_id=$1 AND ((status='PENDING' AND next_attempt_at<=now())
                                      OR (status='PROCESSING' AND lease_until<now()))
              ORDER BY next_attempt_at, id
              LIMIT $2 FOR UPDATE SKIP LOCKED)
           UPDATE messaging.notification_deliveries d
              SET status='PROCESSING', lease_until=now()+make_interval(secs => $3),
                  attempt_count=d.attempt_count+1, version=d.version+1
             FROM due WHERE d.tenant_id=due.tenant_id AND d.practice_id=due.practice_id AND d.id=due.id
           RETURNING d.practice_id, d.id, d.attempt_count, d.max_attempts`,
          [tenantId, this.options.batchSize, this.options.leaseSeconds],
        ),
      this.pool,
    );
    for (const item of claimed.rows) await this.process(tenantId, item);
    return claimed.rowCount ?? 0;
  }

  private async process(tenantId: string, item: Claimed): Promise<void> {
    let prepared: Prepared;
    try {
      prepared = await tenantTx(
        tenantId,
        (c) => this.prepare(c, tenantId, item),
        this.pool,
      );
    } catch (e) {
      log("error", "notification_prepare_failed", {
        tenant_id: tenantId,
        practice_id: item.practice_id,
        delivery_id: item.id,
        ...errorFields(e),
      });
      return this.recordFailure(
        tenantId,
        item,
        null,
        new DeliveryFailure("TRANSIENT", "PREPARE_FAILED"),
      );
    }
    if (prepared.kind === "gone") return;
    if (prepared.kind === "skip" || prepared.kind === "cancel") {
      await tenantTx(
        tenantId,
        (c) =>
          prepared.kind === "skip"
            ? c.query(
                `UPDATE messaging.notification_deliveries SET status='SKIPPED', skip_reason=$5, lease_until=NULL,
                        version=version+1
                  WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='PROCESSING' AND attempt_count=$4`,
                [
                  tenantId,
                  item.practice_id,
                  item.id,
                  item.attempt_count,
                  prepared.reason,
                ],
              )
            : c.query(
                `UPDATE messaging.notification_deliveries SET status='CANCELLED', cancel_reason=$5, cancelled_at=now(),
                        lease_until=NULL, version=version+1
                  WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='PROCESSING' AND attempt_count=$4`,
                [
                  tenantId,
                  item.practice_id,
                  item.id,
                  item.attempt_count,
                  prepared.reason,
                ],
              ),
        this.pool,
      );
      this.options.metrics?.inc(
        prepared.kind === "skip"
          ? "notifications_skipped_total"
          : "notifications_cancelled_total",
        { reason: prepared.reason },
      );
      return;
    }
    const { row, recipient, facts, template, connection } = prepared;
    const entry = NOTIFICATION_CATALOGUE[row.notification_type];
    const params = entry.params(facts);
    const started = Date.now();
    try {
      let messageId: string;
      if (recipient.channel === "WHATSAPP") {
        const sender = this.transports.whatsapp(connection!);
        const payloads = entry.buttonPayloads?.(facts);
        ({ messageId } = await sender.sendTemplate({
          to: recipient.address,
          name: template.name,
          language: template.language,
          bodyParams: params,
          ...(payloads ? { buttonPayloads: payloads } : {}),
          callbackData: `delivery:${row.id}`,
        }));
      } else {
        if (!this.transports.email)
          throw new DeliveryFailure("CONFIGURATION", "EMAIL_NOT_CONFIGURED");
        ({ messageId } = await this.transports.email.send({
          to: recipient.address,
          subject: entry.subject(facts),
          text: entry.text(facts),
          reference: row.id,
        }));
      }
      this.options.metrics?.observe(
        "notification_send_seconds",
        (Date.now() - started) / 1000,
        { channel: recipient.channel },
      );
      const recorded = await tenantTx(
        tenantId,
        (c) =>
          c.query(
            `UPDATE messaging.notification_deliveries
                SET status='SENT', provider_message_id=$5, sent_at=now(), lease_until=NULL,
                    template_params=$6, template_name=$7, template_language=$8, recipient_address=$9,
                    recipient_contact_id=$10, connection_id=$11, last_error_code=NULL, last_error_detail=NULL,
                    version=version+1
              WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='PROCESSING' AND attempt_count=$4`,
            [
              tenantId,
              row.practice_id,
              row.id,
              row.attempt_count,
              messageId,
              JSON.stringify(params),
              template.name,
              template.language,
              recipient.address,
              recipient.contactId,
              recipient.connectionId,
            ],
          ),
        this.pool,
      );
      if (!recorded.rowCount)
        // A status callback got there first, or the claim was lost.
        log("warn", "notification_record_skipped", {
          tenant_id: tenantId,
          practice_id: row.practice_id,
          delivery_id: row.id,
        });
      this.options.metrics?.inc("notifications_sent_total", {
        channel: recipient.channel,
        type: row.notification_type,
      });
      log("info", "notification_sent", {
        tenant_id: tenantId,
        practice_id: row.practice_id,
        delivery_id: row.id,
        notification_type: row.notification_type,
        channel: recipient.channel,
        attempts: row.attempt_count,
      });
    } catch (e) {
      const failure =
        e instanceof DeliveryFailure
          ? e
          : new DeliveryFailure("TRANSIENT", "UNEXPECTED_ERROR");
      if (!(e instanceof DeliveryFailure))
        log("error", "notification_send_error", {
          tenant_id: tenantId,
          delivery_id: row.id,
          ...errorFields(e),
        });
      await this.recordFailure(tenantId, item, recipient.channel, failure);
    }
  }

  private async recordFailure(
    tenantId: string,
    item: Claimed,
    channel: NotificationChannel | null,
    failure: DeliveryFailure,
  ): Promise<void> {
    const final =
      failure.kind === "PERMANENT" || item.attempt_count >= item.max_attempts;
    const delay = retryDelaySeconds(item.attempt_count, failure, this.random);
    await tenantTx(
      tenantId,
      (c) =>
        final
          ? c.query(
              `UPDATE messaging.notification_deliveries
                  SET status='FAILED', failed_at=now(), lease_until=NULL, last_error_code=$5, last_error_detail=$6,
                      version=version+1
                WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='PROCESSING' AND attempt_count=$4`,
              [
                tenantId,
                item.practice_id,
                item.id,
                item.attempt_count,
                failure.code,
                failure.detail,
              ],
            )
          : c.query(
              `UPDATE messaging.notification_deliveries
                  SET status='PENDING', next_attempt_at=now()+make_interval(secs => $7), lease_until=NULL,
                      last_error_code=$5, last_error_detail=$6, version=version+1
                WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='PROCESSING' AND attempt_count=$4`,
              [
                tenantId,
                item.practice_id,
                item.id,
                item.attempt_count,
                failure.code,
                failure.detail,
                delay,
              ],
            ),
      this.pool,
    );
    this.options.metrics?.inc(
      final ? "notifications_failed_total" : "notifications_retried_total",
      { channel: channel ?? "UNKNOWN", kind: failure.kind },
    );
    log(
      final ? "error" : "warn",
      final ? "notification_failed" : "notification_retry_scheduled",
      {
        tenant_id: tenantId,
        practice_id: item.practice_id,
        delivery_id: item.id,
        channel,
        code: failure.code,
        failure_kind: failure.kind,
        attempts: item.attempt_count,
        ...(final ? {} : { backoff_ms: delay * 1000 }),
      },
    );
  }

  /** Re-check everything against current facts just before sending. */
  private async prepare(
    c: DbClient,
    tenantId: string,
    item: Claimed,
  ): Promise<Prepared> {
    const r = await c.query<DeliveryRow>(
      `SELECT d.id, d.practice_id, d.notification_type, d.channel, d.patient_id, d.appointment_id,
              d.waitlist_offer_id, d.appointment_starts_at, d.attempt_count, d.max_attempts,
              pt.given_name, pt.preferred_name, pt.status AS patient_status,
              pr.name AS practice_name, pr.timezone AS practice_timezone,
              a.status AS appointment_status, a.starts_at AS appointment_start,
              ap.display_name AS appointment_practitioner, al.name AS appointment_location,
              al.timezone AS appointment_timezone,
              o.status AS offer_status, o.starts_at AS offer_start, o.expires_at AS offer_expires,
              op.display_name AS offer_practitioner, ol.name AS offer_location, ol.timezone AS offer_timezone
         FROM messaging.notification_deliveries d
         JOIN directory.patients pt ON pt.tenant_id=d.tenant_id AND pt.practice_id=d.practice_id AND pt.id=d.patient_id
         JOIN directory.practices pr ON pr.tenant_id=d.tenant_id AND pr.id=d.practice_id
         LEFT JOIN scheduling.appointments a
                ON a.tenant_id=d.tenant_id AND a.practice_id=d.practice_id AND a.id=d.appointment_id
         LEFT JOIN scheduling.practitioners ap
                ON ap.tenant_id=a.tenant_id AND ap.practice_id=a.practice_id AND ap.id=a.practitioner_id
         LEFT JOIN directory.practice_locations al
                ON al.tenant_id=a.tenant_id AND al.practice_id=a.practice_id AND al.id=a.location_id
         LEFT JOIN scheduling.waitlist_offers o
                ON o.tenant_id=d.tenant_id AND o.practice_id=d.practice_id AND o.id=d.waitlist_offer_id
         LEFT JOIN scheduling.practitioners op
                ON op.tenant_id=o.tenant_id AND op.practice_id=o.practice_id AND op.id=o.practitioner_id
         LEFT JOIN directory.practice_locations ol
                ON ol.tenant_id=o.tenant_id AND ol.practice_id=o.practice_id AND ol.id=o.location_id
        WHERE d.tenant_id=$1 AND d.practice_id=$2 AND d.id=$3 AND d.status='PROCESSING' AND d.attempt_count=$4`,
      [tenantId, item.practice_id, item.id, item.attempt_count],
    );
    const row = r.rows[0];
    if (!row) return { kind: "gone" };
    const now = this.now();
    const type = row.notification_type;
    if (row.patient_status === "ARCHIVED")
      return { kind: "skip", reason: "PATIENT_ARCHIVED" };

    let when: Date;
    let timezone: string;
    let practitioner: string;
    let location: string;
    let offerExpires: string | undefined;
    if (type === "WAITLIST_OFFER") {
      if (row.offer_status !== "PENDING")
        return { kind: "cancel", reason: "OFFER_CLOSED" };
      if (+now >= +row.offer_expires!)
        return { kind: "skip", reason: "TOO_LATE" };
      when = new Date(row.offer_start!);
      timezone = row.offer_timezone ?? row.practice_timezone;
      practitioner = row.offer_practitioner ?? "";
      location = row.offer_location ?? "";
      offerExpires = formatDeadline(
        new Date(row.offer_expires!),
        timezone,
        now,
      );
    } else {
      const expected =
        type === "APPOINTMENT_CANCELLED" ? "CANCELLED" : "CONFIRMED";
      if (
        row.appointment_status !== expected ||
        !row.appointment_start ||
        !row.appointment_starts_at ||
        +row.appointment_start !== +row.appointment_starts_at
      )
        return { kind: "skip", reason: "APPOINTMENT_CHANGED" };
      when = new Date(row.appointment_start);
      timezone = row.appointment_timezone ?? row.practice_timezone;
      practitioner = row.appointment_practitioner ?? "";
      location = row.appointment_location ?? "";
    }
    if (+now >= +when - LATEST_LEAD_MS[type])
      return { kind: "skip", reason: "TOO_LATE" };

    const data = await loadRecipientData(
      c,
      { tenantId, practiceId: row.practice_id },
      row.patient_id,
    );
    const resolved = resolveChannel(
      row.channel,
      type,
      data.preferences,
      data.contacts,
      {
        whatsappConnectionId: data.whatsapp?.id ?? null,
        emailConfigured: this.transports.email !== null,
        allowList: this.options.allowList,
      },
    );
    if (!resolved.ok) return { kind: "skip", reason: resolved.reason };
    let connection: WhatsAppConnection | null = null;
    if (resolved.recipient.channel === "WHATSAPP") {
      const config = whatsAppConnectionConfigSchema.safeParse(
        data.whatsapp!.config,
      );
      if (!config.success)
        return { kind: "skip", reason: "CHANNEL_NOT_CONFIGURED" };
      connection = {
        id: data.whatsapp!.id,
        config: config.data,
        secretRef: data.whatsapp!.secret_ref,
      };
    }
    return {
      kind: "send",
      row,
      recipient: resolved.recipient,
      template: templateFor(type, data.whatsapp?.config),
      connection,
      facts: {
        practiceName: row.practice_name,
        patientFirstName: row.preferred_name ?? row.given_name,
        when: formatWhen(when, timezone),
        practitionerName: practitioner,
        locationName: location,
        ...(offerExpires ? { offerExpires } : {}),
        ...(row.waitlist_offer_id ? { offerId: row.waitlist_offer_id } : {}),
      },
    };
  }
}
