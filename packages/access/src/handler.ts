import { randomUUID } from "node:crypto";
import { isRetryableTransactionError, type DbClient } from "@access/db";
import { errorFields, log } from "@access/observability";
import {
  handleInboundMessage,
  type ConversationRow,
  type EngineOptions,
  type InboundMessageRow,
} from "./engine.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Outbox handler for CHANNEL_MESSAGE_RECEIVED: one conversation turn per
 * inbound message, in order (events of one conversation are processed
 * sequentially), inside the event's transaction so the reply, the state and
 * any scheduling change commit together. A message already handled is
 * skipped (idempotent). Unexpected failures hand the conversation to staff
 * instead of leaving the patient without an answer; transient database
 * conflicts are retried by the outbox.
 */
export function channelMessageHandler(options: EngineOptions) {
  return async (
    c: DbClient,
    event: {
      tenant_id: string;
      practice_id: string | null;
      payload: Record<string, unknown>;
    },
  ): Promise<void> => {
    const conversationId = String(event.payload.conversation_id ?? "");
    const messageId = String(event.payload.message_id ?? "");
    if (
      !event.practice_id ||
      !UUID.test(conversationId) ||
      !UUID.test(messageId)
    )
      return;
    const scope = [event.tenant_id, event.practice_id];
    const conversation = await c.query<ConversationRow>(
      `SELECT tenant_id, practice_id, id, connection_id, participant_address, patient_id, status, needs_staff_reason,
              state, state_data, state_expires_at, version
         FROM messaging.channel_conversations WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 FOR UPDATE`,
      [...scope, conversationId],
    );
    const message = await c.query<InboundMessageRow & { status: string }>(
      `SELECT id, message_type, body, payload, correlation_id, status FROM messaging.channel_messages
        WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND direction='INBOUND'`,
      [...scope, messageId],
    );
    const conv = conversation.rows[0];
    const msg = message.rows[0];
    if (!conv || !msg || msg.status !== "RECEIVED") return;
    await c.query("SAVEPOINT conversation_turn");
    try {
      await handleInboundMessage(c, conv, msg, options);
      await c.query("RELEASE SAVEPOINT conversation_turn");
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT conversation_turn");
      if (isRetryableTransactionError(e)) throw e;
      log("error", "conversation_turn_failed", {
        tenant_id: event.tenant_id,
        practice_id: event.practice_id,
        message_id: messageId,
        ...errorFields(e),
      });
      await c.query(
        `UPDATE messaging.channel_conversations
            SET status='NEEDS_STAFF', needs_staff_reason='BOOKING_FAILED', state='IDLE', state_data='{}',
                state_expires_at=NULL, version=version+1, updated_at=now()
          WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
        [...scope, conversationId],
      );
      await c.query(
        `INSERT INTO messaging.channel_messages(tenant_id, practice_id, id, conversation_id, direction, provider, message_type,
            body, payload, status, sent_by, next_attempt_at, correlation_id)
         VALUES($1,$2,$3,$4,'OUTBOUND','WHATSAPP_CLOUD','TEXT',$5,'{"kind":"text"}','PENDING','system:access-layer',now(),$6)`,
        [
          ...scope,
          randomUUID(),
          conversationId,
          "Sorry, something went wrong on our side. A member of our reception team will reply here.",
          msg.correlation_id,
        ],
      );
      await c.query(
        `UPDATE messaging.channel_messages SET status='FAILED', failed_at=now(), last_error_code='TURN_FAILED'
          WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
        [...scope, messageId],
      );
    }
  };
}
