import type pg from "pg";
import { tenantTx } from "@access/db";
import {
  DeliveryFailure,
  retryDelaySeconds,
  whatsAppConnectionConfigSchema,
  type ListRow,
  type ReplyButton,
  type SentMessage,
  type WhatsAppConnectionConfig,
} from "@access/integrations";
import { errorFields, log, type Metrics } from "@access/observability";

/** What the dispatcher needs from a WhatsApp client (session messages). */
export interface SessionSender {
  sendText(input: {
    to: string;
    body: string;
    callbackData?: string;
  }): Promise<SentMessage>;
  sendButtons(input: {
    to: string;
    body: string;
    buttons: ReplyButton[];
    callbackData?: string;
  }): Promise<SentMessage>;
  sendList(input: {
    to: string;
    body: string;
    buttonLabel: string;
    sectionTitle: string;
    rows: ListRow[];
    callbackData?: string;
  }): Promise<SentMessage>;
}
export interface SessionConnection {
  id: string;
  config: WhatsAppConnectionConfig;
  secretRef: string | null;
}
export interface OutboundOptions {
  /** Builds a client for a connection (throws DeliveryFailure when unusable). */
  sender(connection: SessionConnection): SessionSender;
  leaseSeconds: number;
  batchSize: number;
  metrics?: Metrics;
  random?: () => number;
}
interface Claimed {
  practice_id: string;
  id: string;
  attempt_count: number;
}
type Payload =
  | { kind: "text" }
  | { kind: "buttons"; buttons: ReplyButton[] }
  | { kind: "list"; button: string; section: string; rows: ListRow[] };

/** Session messages may be retried this often before they fail. */
const MAX_ATTEMPTS = 5;
/** WhatsApp's customer service window for free-form messages. */
const SERVICE_WINDOW_MS = 24 * 3600_000;

/**
 * Sends conversation replies (assistant and staff) in order per
 * conversation: a message waits while an earlier one of the same
 * conversation is still pending, so replies never arrive out of order.
 * Free-form messages are only sent inside WhatsApp's 24-hour window.
 */
export class OutboundDispatcher {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: OutboundOptions,
  ) {}

  async run(tenantId: string): Promise<number> {
    const claimed = await tenantTx(
      tenantId,
      (c) =>
        c.query<Claimed>(
          `WITH due AS (
             SELECT m.tenant_id, m.practice_id, m.id FROM messaging.channel_messages m
              WHERE m.tenant_id=$1 AND m.direction='OUTBOUND'
                AND ((m.status='PENDING' AND m.next_attempt_at<=now()) OR (m.status='SENDING' AND m.lease_until<now()))
                AND NOT EXISTS (SELECT 1 FROM messaging.channel_messages e
                                 WHERE e.tenant_id=m.tenant_id AND e.practice_id=m.practice_id
                                   AND e.conversation_id=m.conversation_id AND e.direction='OUTBOUND'
                                   AND e.status IN ('PENDING','SENDING')
                                   AND (e.created_at, e.id) < (m.created_at, m.id))
              ORDER BY m.next_attempt_at, m.created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
           UPDATE messaging.channel_messages m
              SET status='SENDING', lease_until=now()+make_interval(secs => $3), attempt_count=m.attempt_count+1
             FROM due WHERE m.tenant_id=due.tenant_id AND m.practice_id=due.practice_id AND m.id=due.id
           RETURNING m.practice_id, m.id, m.attempt_count`,
          [tenantId, this.options.batchSize, this.options.leaseSeconds],
        ),
      this.pool,
    );
    for (const item of claimed.rows) await this.send(tenantId, item);
    return claimed.rowCount ?? 0;
  }

  private async send(tenantId: string, item: Claimed): Promise<void> {
    const r = await tenantTx(
      tenantId,
      (c) =>
        c.query<{
          body: string | null;
          payload: Payload | null;
          participant_address: string;
          last_inbound_at: Date | null;
          connection_id: string;
          connection_status: string;
          config: unknown;
          secret_ref: string | null;
        }>(
          `SELECT m.body, m.payload, v.participant_address, v.last_inbound_at, k.id AS connection_id,
                  k.status AS connection_status, k.config, k.secret_ref
             FROM messaging.channel_messages m
             JOIN messaging.channel_conversations v
               ON v.tenant_id=m.tenant_id AND v.practice_id=m.practice_id AND v.id=m.conversation_id
             JOIN integration.connections k
               ON k.tenant_id=v.tenant_id AND k.practice_id=v.practice_id AND k.id=v.connection_id
            WHERE m.tenant_id=$1 AND m.practice_id=$2 AND m.id=$3 AND m.status='SENDING' AND m.attempt_count=$4`,
          [tenantId, item.practice_id, item.id, item.attempt_count],
        ),
      this.pool,
    );
    const row = r.rows[0];
    if (!row) return;
    try {
      if (row.connection_status !== "ACTIVE")
        throw new DeliveryFailure("PERMANENT", "CONNECTION_DISABLED");
      if (
        !row.last_inbound_at ||
        Date.now() - +row.last_inbound_at > SERVICE_WINDOW_MS
      )
        throw new DeliveryFailure("PERMANENT", "OUTSIDE_SERVICE_WINDOW");
      const config = whatsAppConnectionConfigSchema.safeParse(row.config);
      if (!config.success)
        throw new DeliveryFailure("CONFIGURATION", "CONNECTION_CONFIG_INVALID");
      const sender = this.options.sender({
        id: row.connection_id,
        config: config.data,
        secretRef: row.secret_ref,
      });
      const to = row.participant_address;
      const body = row.body ?? "";
      const callbackData = `message:${item.id}`;
      const payload = row.payload ?? { kind: "text" };
      const sent =
        payload.kind === "buttons"
          ? await sender.sendButtons({
              to,
              body,
              buttons: payload.buttons,
              callbackData,
            })
          : payload.kind === "list"
            ? await sender.sendList({
                to,
                body,
                buttonLabel: payload.button,
                sectionTitle: payload.section,
                rows: payload.rows,
                callbackData,
              })
            : await sender.sendText({ to, body, callbackData });
      await tenantTx(
        tenantId,
        async (c) => {
          await c.query(
            `UPDATE messaging.channel_messages
                SET status='SENT', provider_message_id=$5, sent_at=now(), lease_until=NULL, last_error_code=NULL
              WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='SENDING' AND attempt_count=$4`,
            [
              tenantId,
              item.practice_id,
              item.id,
              item.attempt_count,
              sent.messageId,
            ],
          );
          await c.query(
            `UPDATE messaging.channel_conversations SET last_outbound_at=now(), version=version+1
              WHERE tenant_id=$1 AND practice_id=$2
                AND id=(SELECT conversation_id FROM messaging.channel_messages WHERE tenant_id=$1 AND practice_id=$2 AND id=$3)`,
            [tenantId, item.practice_id, item.id],
          );
        },
        this.pool,
      );
      this.options.metrics?.inc("channel_messages_sent_total", {
        channel: "WHATSAPP",
      });
    } catch (e) {
      const failure =
        e instanceof DeliveryFailure
          ? e
          : new DeliveryFailure("TRANSIENT", "UNEXPECTED_ERROR");
      if (!(e instanceof DeliveryFailure))
        log("error", "channel_message_send_error", {
          tenant_id: tenantId,
          message_id: item.id,
          ...errorFields(e),
        });
      const final =
        failure.kind === "PERMANENT" || item.attempt_count >= MAX_ATTEMPTS;
      await tenantTx(
        tenantId,
        (c) =>
          final
            ? c.query(
                `UPDATE messaging.channel_messages SET status='FAILED', failed_at=now(), lease_until=NULL, last_error_code=$5
                  WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='SENDING' AND attempt_count=$4`,
                [
                  tenantId,
                  item.practice_id,
                  item.id,
                  item.attempt_count,
                  failure.code,
                ],
              )
            : c.query(
                `UPDATE messaging.channel_messages
                    SET status='PENDING', lease_until=NULL, last_error_code=$5,
                        next_attempt_at=now()+make_interval(secs => $6)
                  WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='SENDING' AND attempt_count=$4`,
                [
                  tenantId,
                  item.practice_id,
                  item.id,
                  item.attempt_count,
                  failure.code,
                  // Replies are conversational: retry sooner than notifications.
                  Math.min(
                    120,
                    retryDelaySeconds(
                      item.attempt_count,
                      failure,
                      this.options.random,
                    ) / 6,
                  ),
                ],
              ),
        this.pool,
      );
      this.options.metrics?.inc(
        final
          ? "channel_messages_failed_total"
          : "channel_messages_retried_total",
        { channel: "WHATSAPP", kind: failure.kind },
      );
      log(
        final ? "error" : "warn",
        final ? "channel_message_failed" : "channel_message_retry",
        {
          tenant_id: tenantId,
          practice_id: item.practice_id,
          message_id: item.id,
          code: failure.code,
          failure_kind: failure.kind,
          attempts: item.attempt_count,
        },
      );
    }
  }
}
