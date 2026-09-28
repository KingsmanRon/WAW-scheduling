import type { CancellationReasonCode } from "@access/contracts";
import type { DbClient } from "@access/db";
import { SchedulingError } from "../domain/errors.js";
import { assertPatientChangeAllowed } from "../domain/policy.js";
import {
  APPOINTMENT_ACTIONS,
  assertActionTiming,
  assertTransition,
  type AppointmentActionName,
} from "../domain/state-machine.js";
import { releaseHold } from "./bookings.js";
import type { CommandContext } from "./context.js";
import {
  appendAppointmentEvent,
  appointmentFacts,
  audit,
  emit,
  type AppointmentEventType,
} from "./effects.js";
import {
  databaseNow,
  loadPractice,
  lockPractitioners,
  readAppointment,
  type AppointmentRow,
} from "./repository.js";

/**
 * Lifecycle changes of a booked appointment. Each is an explicit action whose
 * transition is validated by the state machine (and again by the database
 * trigger); nothing assigns a status directly.
 */

function assertVersion(a: AppointmentRow, expected: number | undefined) {
  if (expected !== undefined && a.version !== expected)
    throw new SchedulingError("VERSION_CONFLICT", undefined, {
      current_version: a.version,
    });
}

const ACTION_EFFECTS = {
  check_in: {
    column: "checked_in",
    event: "CHECKED_IN",
    outbox: "PATIENT_CHECKED_IN",
    audit: "appointment.checked_in",
  },
  start: {
    column: "started",
    event: "STARTED",
    outbox: "APPOINTMENT_STARTED",
    audit: "appointment.started",
  },
  complete: {
    column: "completed",
    event: "COMPLETED",
    outbox: "APPOINTMENT_COMPLETED",
    audit: "appointment.completed",
  },
  no_show: {
    column: "no_show",
    event: "NO_SHOW",
    outbox: "APPOINTMENT_NO_SHOW",
    audit: "appointment.no_show",
  },
} as const;

export type LifecycleAction = Exclude<AppointmentActionName, "cancel">;

export async function performAction(
  c: DbClient,
  ctx: CommandContext,
  appointmentId: string,
  action: LifecycleAction,
  input: { expectedVersion?: number | undefined } = {},
): Promise<string> {
  const peek = await readAppointment(c, ctx, appointmentId, false);
  // A late arrival re-occupies the slot: serialise with bookings for it.
  if (action === "check_in" && peek.status === "NO_SHOW")
    await lockPractitioners(c, ctx, [peek.practitionerId]);
  const a = await readAppointment(c, ctx, appointmentId, true);
  assertVersion(a, input.expectedVersion);
  const now = await databaseNow(c);
  assertActionTiming({
    action,
    from: a.status,
    startsAt: a.startsAt,
    timezone: a.timezone,
    now,
  });
  const effect = ACTION_EFFECTS[action];
  const to = APPOINTMENT_ACTIONS[action];
  await c.query(
    `UPDATE scheduling.appointments
        SET status=$4, ${effect.column}_at=now(), ${effect.column}_by=$5, version=version+1
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, a.id, to, ctx.actor.id],
  );
  const eventType: AppointmentEventType =
    action === "check_in" && a.status === "NO_SHOW"
      ? "LATE_ARRIVAL"
      : effect.event;
  await appendAppointmentEvent(c, ctx, {
    appointmentId: a.id,
    eventType,
    from: a.status,
    to,
  });
  const f = appointmentFacts({ ...a, status: to });
  await emit(c, ctx, effect.outbox, { type: "appointment", id: a.id }, f);
  await audit(c, ctx, {
    action: effect.audit,
    resourceType: "appointment",
    resourceId: a.id,
    before: { status: a.status },
    after: { status: to },
  });
  return a.id;
}

export async function cancelAppointment(
  c: DbClient,
  ctx: CommandContext,
  appointmentId: string,
  input: {
    reasonCode: CancellationReasonCode;
    note?: string | null | undefined;
    expectedVersion?: number | undefined;
  },
): Promise<string> {
  const peek = await readAppointment(c, ctx, appointmentId, false);
  if (peek.status === "HELD") {
    // Cancelling a held slot is releasing its hold.
    const hold = await c.query<{ id: string }>(
      "SELECT id FROM scheduling.slot_holds WHERE tenant_id=$1 AND practice_id=$2 AND appointment_id=$3",
      [ctx.tenantId, ctx.practiceId, appointmentId],
    );
    await releaseHold(c, ctx, hold.rows[0]!.id);
    return appointmentId;
  }
  // Lock order: holds before appointments. Replacement holds of this
  // appointment are released with it.
  const replacements = await c.query<{ id: string }>(
    `SELECT id FROM scheduling.slot_holds
      WHERE tenant_id=$1 AND practice_id=$2 AND reschedule_of_id=$3 AND status='ACTIVE' ORDER BY id FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId, appointmentId],
  );
  const a = await readAppointment(c, ctx, appointmentId, true);
  assertVersion(a, input.expectedVersion);
  assertTransition(a.status, "CANCELLED");
  const practice = await loadPractice(c, ctx);
  const now = await databaseNow(c);
  assertPatientChangeAllowed({
    actor: ctx.actor.type,
    startsAt: a.startsAt,
    now,
    cutoffMinutes: practice.patientChangeCutoffMinutes,
  });
  for (const r of replacements.rows)
    await releaseHold(c, ctx, r.id, { internal: true });
  await c.query(
    `UPDATE scheduling.appointments
        SET status='CANCELLED', cancelled_at=now(), cancelled_by=$4, cancellation_reason_code=$5,
            cancellation_note=$6, version=version+1
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [
      ctx.tenantId,
      ctx.practiceId,
      a.id,
      ctx.actor.id,
      input.reasonCode,
      input.note ?? null,
    ],
  );
  await appendAppointmentEvent(c, ctx, {
    appointmentId: a.id,
    eventType: "CANCELLED",
    from: a.status,
    to: "CANCELLED",
    reasonCode: input.reasonCode,
  });
  const f = appointmentFacts({ ...a, status: "CANCELLED" });
  await emit(
    c,
    ctx,
    "APPOINTMENT_CANCELLED",
    { type: "appointment", id: a.id },
    {
      ...f,
      reason_code: input.reasonCode,
      // Where the cancellation was made (a WhatsApp conversation confirms
      // it there; other channels get a notification).
      channel: ctx.channel,
      // A future slot was freed: the waitlist may offer it.
      slot_freed: +a.startsAt > +now,
    },
  );
  await audit(c, ctx, {
    action: "appointment.cancelled",
    resourceType: "appointment",
    resourceId: a.id,
    before: { status: a.status },
    after: { status: "CANCELLED", reason_code: input.reasonCode },
    reason: input.note ?? null,
  });
  return a.id;
}

/** Administrative note (never clinical content). */
export async function updateNotes(
  c: DbClient,
  ctx: CommandContext,
  appointmentId: string,
  input: { notes: string | null; expectedVersion?: number | undefined },
): Promise<string> {
  const a = await readAppointment(c, ctx, appointmentId, true);
  assertVersion(a, input.expectedVersion);
  await c.query(
    `UPDATE scheduling.appointments SET notes=$4, version=version+1
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, a.id, input.notes],
  );
  await appendAppointmentEvent(c, ctx, {
    appointmentId: a.id,
    eventType: "NOTE_UPDATED",
    from: a.status,
    to: a.status,
  });
  return a.id;
}
