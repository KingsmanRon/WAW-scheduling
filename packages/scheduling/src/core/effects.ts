import type { OutboxEventType } from "@access/contracts";
import {
  enqueueOutboxEvent,
  recordAuditEvent,
  type DbClient,
} from "@access/db";
import type { AppointmentStatus } from "../domain/state-machine.js";
import type { CommandContext } from "./context.js";

/**
 * The three records every consequential scheduling change writes, inside the
 * same transaction as the change itself:
 *
 * - appointment_events: the appointment's own history, shown to staff;
 * - outbox_events: the trigger for asynchronous work (notifications,
 *   waitlist, integrations) - processed after commit, never able to undo it;
 * - audit_events: the immutable accountability record (who, what, from
 *   where), separate from application logs.
 */
export type AppointmentEventType =
  | "HELD"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "STARTED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "RESCHEDULED"
  | "RESCHEDULED_FROM"
  | "EXPIRED"
  | "HOLD_RELEASED"
  | "LATE_ARRIVAL"
  | "NOTE_UPDATED";

export async function appendAppointmentEvent(
  c: DbClient,
  ctx: CommandContext,
  e: {
    appointmentId: string;
    eventType: AppointmentEventType;
    from: AppointmentStatus | null;
    to: AppointmentStatus;
    reasonCode?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await c.query(
    `INSERT INTO scheduling.appointment_events(tenant_id,practice_id,appointment_id,event_type,from_status,to_status,
                                               actor_type,actor_id,actor_role,channel,reason_code,details,correlation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      e.appointmentId,
      e.eventType,
      e.from,
      e.to,
      ctx.actor.type,
      ctx.actor.id,
      ctx.actor.role,
      ctx.actor.type === "SYSTEM" ? "SYSTEM" : ctx.channel,
      e.reasonCode ?? null,
      JSON.stringify(e.details ?? {}),
      ctx.correlationId,
    ],
  );
}

export async function emit(
  c: DbClient,
  ctx: CommandContext,
  eventType: OutboxEventType,
  aggregate: { type: string; id: string },
  payload: Record<string, unknown>,
): Promise<string> {
  return enqueueOutboxEvent(c, {
    tenantId: ctx.tenantId,
    practiceId: ctx.practiceId,
    eventType,
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    payload,
    correlationId: ctx.correlationId,
  });
}

export async function audit(
  c: DbClient,
  ctx: CommandContext,
  a: {
    action: string;
    resourceType: string;
    resourceId: string;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
  },
): Promise<void> {
  await recordAuditEvent(c, {
    tenantId: ctx.tenantId,
    practiceId: ctx.practiceId,
    actor: { type: ctx.actor.type, id: ctx.actor.id, role: ctx.actor.role },
    action: a.action,
    resourceType: a.resourceType,
    resourceId: a.resourceId,
    channel: ctx.actor.type === "SYSTEM" ? "SYSTEM" : ctx.channel,
    changes: {
      ...(a.before !== undefined ? { before: a.before } : {}),
      ...(a.after !== undefined ? { after: a.after } : {}),
    },
    reason: a.reason ?? null,
    request: { ...ctx.request, correlationId: ctx.correlationId },
  });
}

/** Non-sensitive description of an appointment for events and audit. */
export function appointmentFacts(a: {
  id: string;
  status: string;
  practitionerId: string;
  locationId: string;
  appointmentTypeId: string;
  patientId: string;
  startsAt: Date;
  endsAt: Date;
}): Record<string, unknown> {
  return {
    appointment_id: a.id,
    status: a.status,
    patient_id: a.patientId,
    practitioner_id: a.practitionerId,
    location_id: a.locationId,
    appointment_type_id: a.appointmentTypeId,
    starts_at: a.startsAt.toISOString(),
    ends_at: a.endsAt.toISOString(),
  };
}
