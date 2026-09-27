import type { OutboxEventType } from "@access/contracts";
import type { DbClient } from "./runtime.js";

/**
 * Transactional outbox and audit trail for the scheduling platform. Both are
 * written with the domain mutation in one transaction: the event exists if
 * and only if the change committed.
 */
export interface OutboxEventInput {
  tenantId: string;
  practiceId: string | null;
  eventType: OutboxEventType;
  aggregateType: string;
  aggregateId: string;
  /** Identifiers, statuses and instants only; never names or free text. */
  payload: Record<string, unknown>;
  correlationId: string;
  availableAt?: Date;
}
export async function enqueueOutboxEvent(
  c: DbClient,
  e: OutboxEventInput,
): Promise<string> {
  const row = await c.query<{ id: string }>(
    `INSERT INTO platform.outbox_events(tenant_id,practice_id,event_type,aggregate_type,aggregate_id,payload,correlation_id,available_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,coalesce($8,now())) RETURNING id::text`,
    [
      e.tenantId,
      e.practiceId,
      e.eventType,
      e.aggregateType,
      e.aggregateId,
      JSON.stringify(e.payload),
      e.correlationId,
      e.availableAt ?? null,
    ],
  );
  return row.rows[0]!.id;
}

export type AuditActorType =
  "STAFF" | "PATIENT" | "SYSTEM" | "INTEGRATION" | "OPERATOR";
export interface AuditActor {
  type: AuditActorType;
  id: string;
  role?: string | null;
}
/** Request metadata recorded for staff actions (never request bodies). */
export interface AuditRequestMeta {
  requestId?: string | undefined;
  correlationId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}
export interface AuditEventInput {
  tenantId: string;
  practiceId: string | null;
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId: string;
  channel?: string | null;
  /** {before, after} of the administrative fields that changed. */
  changes?: { before?: unknown; after?: unknown };
  reason?: string | null;
  request?: AuditRequestMeta;
}
const IP = /^[0-9a-fA-F:.]{2,45}$/;
export async function recordAuditEvent(
  c: DbClient,
  e: AuditEventInput,
): Promise<void> {
  const ip = e.request?.ip && IP.test(e.request.ip) ? e.request.ip : null;
  await c.query(
    `INSERT INTO platform.audit_events(tenant_id,practice_id,actor_type,actor_id,actor_role,action,resource_type,resource_id,
                                       channel,changes,reason,request_id,correlation_id,ip_address,user_agent)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::inet,$15)`,
    [
      e.tenantId,
      e.practiceId,
      e.actor.type,
      e.actor.id,
      e.actor.role ?? null,
      e.action,
      e.resourceType,
      e.resourceId,
      e.channel ?? null,
      JSON.stringify(e.changes ?? {}),
      e.reason ?? null,
      e.request?.requestId?.slice(0, 100) ?? null,
      e.request?.correlationId ?? null,
      ip,
      e.request?.userAgent?.slice(0, 300) ?? null,
    ],
  );
}
