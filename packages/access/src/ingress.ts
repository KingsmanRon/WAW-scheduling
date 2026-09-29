import { randomUUID } from "node:crypto";
import type pg from "pg";
import { enqueueOutboxEvent, practiceTx, type DbClient } from "@access/db";
import type {
  InboundMessage,
  ParsedWebhook,
  StatusUpdate,
} from "@access/integrations";
import { log } from "@access/observability";

/**
 * Channel ingress (the webhook controller's only collaborator): route each
 * notification to its practice by the operator-provisioned phone number id,
 * de-duplicate, store the normalised message, and queue it for the access
 * layer. No business decision is taken here; conversations are answered by
 * the worker.
 */
export interface IngressResult {
  received: number;
  duplicates: number;
  statuses: number;
  unrouted: number;
}
interface Route {
  tenant_id: string;
  practice_id: string;
  connection_id: string;
}

async function routeFor(
  pool: pg.Pool,
  phoneNumberId: string,
): Promise<Route | null> {
  // The route directory is readable without tenant context (it holds
  // identifiers only); everything after runs in the practice's context.
  const r = await pool.query<Route>(
    `SELECT tenant_id, practice_id, connection_id FROM integration.channel_routes
      WHERE provider='WHATSAPP_CLOUD' AND route_key=$1 AND active`,
    [phoneNumberId],
  );
  return r.rows[0] ?? null;
}

export async function ingestWhatsApp(
  pool: pg.Pool,
  parsed: ParsedWebhook,
): Promise<IngressResult> {
  const result: IngressResult = {
    received: 0,
    duplicates: 0,
    statuses: 0,
    unrouted: 0,
  };
  const byNumber = new Map<
    string,
    { messages: InboundMessage[]; statuses: StatusUpdate[] }
  >();
  for (const m of parsed.messages) {
    const g = byNumber.get(m.phoneNumberId) ?? { messages: [], statuses: [] };
    g.messages.push(m);
    byNumber.set(m.phoneNumberId, g);
  }
  for (const s of parsed.statuses) {
    const g = byNumber.get(s.phoneNumberId) ?? { messages: [], statuses: [] };
    g.statuses.push(s);
    byNumber.set(s.phoneNumberId, g);
  }
  for (const [phoneNumberId, group] of byNumber) {
    const route = await routeFor(pool, phoneNumberId);
    if (!route) {
      result.unrouted += group.messages.length + group.statuses.length;
      log("warn", "whatsapp_unrouted", {
        count: group.messages.length + group.statuses.length,
      });
      continue;
    }
    // Counted per attempt: practiceTx may re-run the work after a deadlock.
    const counted = await practiceTx(
      { tenantId: route.tenant_id, practiceId: route.practice_id },
      async (c) => {
        const n = { received: 0, duplicates: 0, statuses: 0, unrouted: 0 };
        const connection = await c.query(
          `SELECT 1 FROM integration.connections WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='ACTIVE'`,
          [route.tenant_id, route.practice_id, route.connection_id],
        );
        if (!connection.rowCount) {
          n.unrouted += group.messages.length + group.statuses.length;
          return n;
        }
        for (const m of group.messages)
          if (await recordInbound(c, route, m)) n.received++;
          else n.duplicates++;
        for (const s of group.statuses)
          if (await applyStatus(c, route, s)) n.statuses++;
        return n;
      },
      pool,
    );
    result.received += counted.received;
    result.duplicates += counted.duplicates;
    result.statuses += counted.statuses;
    result.unrouted += counted.unrouted;
  }
  return result;
}

/** Store one inbound message (once) and queue it for the access layer. */
async function recordInbound(
  c: DbClient,
  route: Route,
  m: InboundMessage,
): Promise<boolean> {
  const seen = await c.query(
    `SELECT 1 FROM messaging.channel_messages WHERE provider='WHATSAPP_CLOUD' AND provider_message_id=$1`,
    [m.providerMessageId],
  );
  if (seen.rowCount) return false;
  const conversation = await c.query<{ id: string }>(
    `INSERT INTO messaging.channel_conversations(tenant_id, practice_id, id, channel, connection_id, participant_address,
                                                 last_inbound_at)
     VALUES($1,$2,$3,'WHATSAPP',$4,$5,$6)
     ON CONFLICT (tenant_id, practice_id, connection_id, participant_address)
     DO UPDATE SET last_inbound_at=GREATEST(messaging.channel_conversations.last_inbound_at, excluded.last_inbound_at),
                   updated_at=now(), version=messaging.channel_conversations.version+1
     RETURNING id`,
    [
      route.tenant_id,
      route.practice_id,
      randomUUID(),
      route.connection_id,
      m.from,
      m.timestamp,
    ],
  );
  const conversationId = conversation.rows[0]!.id;
  const messageId = randomUUID();
  const correlationId = randomUUID();
  const inserted = await c.query(
    `INSERT INTO messaging.channel_messages(tenant_id, practice_id, id, conversation_id, direction, provider,
        provider_message_id, message_type, body, payload, status, provider_timestamp, correlation_id)
     VALUES($1,$2,$3,$4,'INBOUND','WHATSAPP_CLOUD',$5,$6,$7,$8,'RECEIVED',$9,$10)
     ON CONFLICT (provider, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING`,
    [
      route.tenant_id,
      route.practice_id,
      messageId,
      conversationId,
      m.providerMessageId,
      m.kind,
      m.text,
      JSON.stringify({
        reply_id: m.replyId,
        provider_type: m.providerType,
        context_id: m.contextMessageId,
      }),
      m.timestamp,
      correlationId,
    ],
  );
  if (!inserted.rowCount) return false;
  await enqueueOutboxEvent(c, {
    tenantId: route.tenant_id,
    practiceId: route.practice_id,
    eventType: "CHANNEL_MESSAGE_RECEIVED",
    aggregateType: "conversation",
    aggregateId: conversationId,
    payload: { conversation_id: conversationId, message_id: messageId },
    correlationId,
  });
  return true;
}

const PROVIDER_STATUS: Record<
  StatusUpdate["status"],
  "SENT" | "DELIVERED" | "READ" | "FAILED"
> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};
/** Statuses a record may be in when the provider reports each new status. */
const DELIVERY_FROM: Record<string, string[]> = {
  SENT: ["PENDING", "PROCESSING"],
  DELIVERED: ["PENDING", "PROCESSING", "SENT"],
  READ: ["PENDING", "PROCESSING", "SENT", "DELIVERED"],
  FAILED: ["PENDING", "PROCESSING", "SENT"],
};
const MESSAGE_FROM: Record<string, string[]> = {
  SENT: ["PENDING", "SENDING"],
  DELIVERED: ["PENDING", "SENDING", "SENT"],
  READ: ["PENDING", "SENDING", "SENT", "DELIVERED"],
  FAILED: ["PENDING", "SENDING", "SENT"],
};

/**
 * A provider status callback: move the notification delivery or outbound
 * message forward (never back), once per (message, status). The callback
 * data we attached finds a message whose send was never recorded (worker
 * died after the provider accepted it), which settles it instead of letting
 * it be sent again.
 */
async function applyStatus(
  c: DbClient,
  route: Route,
  s: StatusUpdate,
): Promise<boolean> {
  const receipt = await c.query(
    `INSERT INTO integration.webhook_receipts(tenant_id, provider, receipt_key, practice_id)
     VALUES($1,'WHATSAPP_CLOUD',$2,$3) ON CONFLICT DO NOTHING`,
    [route.tenant_id, `${s.providerMessageId}:${s.status}`, route.practice_id],
  );
  if (!receipt.rowCount) return false;
  const next = PROVIDER_STATUS[s.status];
  const error =
    s.errorCode !== null
      ? `WHATSAPP_${s.errorCode}`
      : next === "FAILED"
        ? "PROVIDER_FAILED"
        : null;
  const target = /^(delivery|message):([0-9a-f-]{36})$/.exec(
    s.callbackData ?? "",
  );
  const deliveryId = target?.[1] === "delivery" ? target[2]! : null;
  const messageId = target?.[1] === "message" ? target[2]! : null;
  if (!messageId) {
    const d = await c.query(
      `UPDATE messaging.notification_deliveries
          SET status=$5, provider_message_id=coalesce(provider_message_id, $4),
              sent_at=coalesce(sent_at, $6),
              delivered_at=CASE WHEN $5 IN ('DELIVERED','READ') THEN coalesce(delivered_at, $6) ELSE delivered_at END,
              read_at=CASE WHEN $5='READ' THEN $6 ELSE read_at END,
              failed_at=CASE WHEN $5='FAILED' THEN $6 ELSE NULL END,
              last_error_code=CASE WHEN $5='FAILED' THEN $7 ELSE last_error_code END,
              lease_until=NULL, version=version+1
        WHERE tenant_id=$1 AND practice_id=$2
          AND (($3::uuid IS NOT NULL AND id=$3) OR ($3::uuid IS NULL AND provider='WHATSAPP_CLOUD' AND provider_message_id=$4))
          AND (provider_message_id IS NULL OR provider_message_id=$4)
          AND status = ANY($8)`,
      [
        route.tenant_id,
        route.practice_id,
        deliveryId,
        s.providerMessageId,
        next,
        s.timestamp,
        error,
        DELIVERY_FROM[next],
      ],
    );
    if (d.rowCount) return true;
    if (deliveryId) return false;
  }
  const m = await c.query(
    `UPDATE messaging.channel_messages
        SET status=$5, provider_message_id=coalesce(provider_message_id, $4),
            sent_at=coalesce(sent_at, $6),
            delivered_at=CASE WHEN $5 IN ('DELIVERED','READ') THEN coalesce(delivered_at, $6) ELSE delivered_at END,
            read_at=CASE WHEN $5='READ' THEN $6 ELSE read_at END,
            failed_at=CASE WHEN $5='FAILED' THEN $6 ELSE failed_at END,
            last_error_code=CASE WHEN $5='FAILED' THEN $7 ELSE last_error_code END,
            lease_until=NULL
      WHERE tenant_id=$1 AND practice_id=$2 AND direction='OUTBOUND'
        AND (($3::uuid IS NOT NULL AND id=$3) OR ($3::uuid IS NULL AND provider_message_id=$4))
        AND (provider_message_id IS NULL OR provider_message_id=$4)
        AND status = ANY($8)`,
    [
      route.tenant_id,
      route.practice_id,
      messageId,
      s.providerMessageId,
      next,
      s.timestamp,
      error,
      MESSAGE_FROM[next],
    ],
  );
  return (m.rowCount ?? 0) > 0;
}
