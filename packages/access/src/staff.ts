import { randomUUID } from "node:crypto";
import {
  AppError,
  recordAuditEvent,
  type AuditActor,
  type AuditRequestMeta,
  type DbClient,
} from "@access/db";

/**
 * Staff side of patient conversations: the reception queue (conversations
 * handed over by the assistant), the thread, replies within WhatsApp's
 * 24-hour window, and resolving (handing back to the assistant or closing).
 */
export interface StaffContext {
  tenantId: string;
  practiceId: string;
  actor: AuditActor;
  request?: AuditRequestMeta;
}
export interface ConversationSummary {
  id: string;
  channel: string;
  participant_address: string;
  patient: { id: string; display_name: string; patient_number: string } | null;
  status: string;
  needs_staff_reason: string | null;
  state: string;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  within_service_window: boolean;
  version: number;
  updated_at: Date;
}
const SUMMARY = `v.id, v.channel, v.participant_address, v.status, v.needs_staff_reason, v.state, v.last_inbound_at,
  v.last_outbound_at, v.version, v.updated_at,
  (v.last_inbound_at IS NOT NULL AND v.last_inbound_at > now() - interval '24 hours') AS within_service_window,
  CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id,
       'display_name', coalesce(p.preferred_name, p.given_name) || ' ' || p.family_name,
       'patient_number', p.patient_number) END AS patient`;

export async function listConversations(
  c: DbClient,
  ctx: StaffContext,
  q: { status?: string; before?: Date; limit: number },
): Promise<ConversationSummary[]> {
  const r = await c.query<ConversationSummary>(
    `SELECT ${SUMMARY}
       FROM messaging.channel_conversations v
       LEFT JOIN directory.patients p ON p.tenant_id=v.tenant_id AND p.practice_id=v.practice_id AND p.id=v.patient_id
      WHERE v.tenant_id=$1 AND v.practice_id=$2 AND ($3::text IS NULL OR v.status=$3)
        AND ($4::timestamptz IS NULL OR v.updated_at < $4)
      ORDER BY v.updated_at DESC, v.id DESC LIMIT $5`,
    [ctx.tenantId, ctx.practiceId, q.status ?? null, q.before ?? null, q.limit],
  );
  return r.rows;
}

async function summary(
  c: DbClient,
  ctx: StaffContext,
  id: string,
  lock = false,
): Promise<ConversationSummary> {
  const r = await c.query<ConversationSummary>(
    `SELECT ${SUMMARY}
       FROM messaging.channel_conversations v
       LEFT JOIN directory.patients p ON p.tenant_id=v.tenant_id AND p.practice_id=v.practice_id AND p.id=v.patient_id
      WHERE v.tenant_id=$1 AND v.practice_id=$2 AND v.id=$3 ${lock ? "FOR UPDATE OF v" : ""}`,
    [ctx.tenantId, ctx.practiceId, id],
  );
  if (!r.rows[0])
    throw new AppError(404, "CONVERSATION_NOT_FOUND", "conversation not found");
  return r.rows[0];
}

export async function getConversation(
  c: DbClient,
  ctx: StaffContext,
  id: string,
): Promise<{
  conversation: ConversationSummary;
  messages: {
    id: string;
    direction: string;
    message_type: string;
    body: string | null;
    options: unknown;
    status: string;
    sent_by: string | null;
    created_at: Date;
    redacted: boolean;
  }[];
}> {
  const conversation = await summary(c, ctx, id);
  const messages = await c.query(
    `SELECT id, direction, message_type, body,
            CASE WHEN direction='OUTBOUND' THEN payload ELSE NULL END AS options,
            status, sent_by, created_at, redacted_at IS NOT NULL AS redacted
       FROM messaging.channel_messages
      WHERE tenant_id=$1 AND practice_id=$2 AND conversation_id=$3
      ORDER BY created_at DESC, id DESC LIMIT 100`,
    [ctx.tenantId, ctx.practiceId, id],
  );
  return {
    conversation,
    messages: messages.rows.reverse(),
  };
}

/** A staff reply: free text, only inside the 24-hour service window. */
export async function staffReply(
  c: DbClient,
  ctx: StaffContext,
  id: string,
  body: string,
): Promise<{ message_id: string }> {
  const conversation = await summary(c, ctx, id, true);
  if (!conversation.within_service_window)
    throw new AppError(
      422,
      "OUTSIDE_SERVICE_WINDOW",
      "WhatsApp only allows free-text replies within 24 hours of the patient's last message; phone the patient instead",
    );
  const messageId = randomUUID();
  await c.query(
    `INSERT INTO messaging.channel_messages(tenant_id, practice_id, id, conversation_id, direction, provider, message_type,
        body, payload, status, sent_by, next_attempt_at, correlation_id)
     VALUES($1,$2,$3,$4,'OUTBOUND','WHATSAPP_CLOUD','TEXT',$5,'{"kind":"text"}','PENDING',$6,now(),$7)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      messageId,
      id,
      body,
      ctx.actor.id,
      randomUUID(),
    ],
  );
  await recordAuditEvent(c, {
    tenantId: ctx.tenantId,
    practiceId: ctx.practiceId,
    actor: ctx.actor,
    action: "conversation.replied",
    resourceType: "conversation",
    resourceId: id,
    channel: "WHATSAPP",
    changes: { after: { message_id: messageId } },
    ...(ctx.request ? { request: ctx.request } : {}),
  });
  return { message_id: messageId };
}

/**
 * Resolve a conversation: hand it back to the assistant (ACTIVE) or close
 * it, optionally linking the patient staff have identified.
 */
export async function resolveConversation(
  c: DbClient,
  ctx: StaffContext,
  id: string,
  input: {
    /** Omitted: only the patient link changes and reception keeps it. */
    status?: "ACTIVE" | "CLOSED";
    patientId?: string | null;
    expectedVersion: number;
  },
): Promise<ConversationSummary> {
  const before = await summary(c, ctx, id, true);
  if (before.version !== input.expectedVersion)
    throw new AppError(
      409,
      "VERSION_CONFLICT",
      "The conversation has changed since it was loaded. Check it and try again.",
    );
  if (input.patientId) {
    const p = await c.query(
      "SELECT 1 FROM directory.patients WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='ACTIVE'",
      [ctx.tenantId, ctx.practiceId, input.patientId],
    );
    if (!p.rowCount)
      throw new AppError(404, "PATIENT_NOT_FOUND", "patient not found");
  }
  if (input.status === undefined && input.patientId === undefined)
    throw new AppError(
      400,
      "VALIDATION_FAILED",
      "a status or a patient is required",
    );
  if (input.status === undefined)
    // Linking only: the conversation stays where it is (with reception).
    await c.query(
      `UPDATE messaging.channel_conversations
          SET patient_id=$4::uuid, version=version+1, updated_at=now()
        WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
      [ctx.tenantId, ctx.practiceId, id, input.patientId ?? null],
    );
  else
    await c.query(
      `UPDATE messaging.channel_conversations
          SET status=$4, needs_staff_reason=NULL, state='IDLE', state_data='{}', state_expires_at=NULL,
              patient_id=CASE WHEN $5::boolean THEN $6::uuid ELSE patient_id END,
              resolved_by=$7, version=version+1, updated_at=now()
        WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
      [
        ctx.tenantId,
        ctx.practiceId,
        id,
        input.status,
        input.patientId !== undefined,
        input.patientId ?? null,
        ctx.actor.id,
      ],
    );
  const after = await summary(c, ctx, id);
  await recordAuditEvent(c, {
    tenantId: ctx.tenantId,
    practiceId: ctx.practiceId,
    actor: ctx.actor,
    action:
      input.status === undefined
        ? "conversation.patient_linked"
        : "conversation.resolved",
    resourceType: "conversation",
    resourceId: id,
    channel: "WHATSAPP",
    changes: {
      before: {
        status: before.status,
        reason: before.needs_staff_reason,
        patient_id: before.patient?.id ?? null,
      },
      after: { status: after.status, patient_id: after.patient?.id ?? null },
    },
    ...(ctx.request ? { request: ctx.request } : {}),
  });
  return after;
}
