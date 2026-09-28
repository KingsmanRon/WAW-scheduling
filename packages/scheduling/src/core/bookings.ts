import { randomUUID } from "node:crypto";
import type { HoldPurpose } from "@access/contracts";
import type { DbClient } from "@access/db";
import { checkSlot } from "../domain/availability.js";
import { SchedulingError } from "../domain/errors.js";
import {
  assertBookingEligibility,
  assertPatientChangeAllowed,
} from "../domain/policy.js";
import { assertTransition } from "../domain/state-machine.js";
import { MINUTE_MS, localDateOf } from "../domain/time.js";
import type { CommandContext } from "./context.js";
import {
  appendAppointmentEvent,
  appointmentFacts,
  audit,
  emit,
} from "./effects.js";
import {
  databaseNow,
  loadAppointmentType,
  loadEligiblePairs,
  loadLocation,
  loadPatientFacts,
  loadPractice,
  loadScheduleContext,
  lockPractitioners,
  lockReferral,
  patientHasOverlap,
  readAppointment,
  readHold,
  timingOf,
  type AppointmentRow,
  type AppointmentTypeRow,
  type HoldRow,
  type LocationRow,
  type PracticeSettings,
  type PractitionerRow,
} from "./repository.js";

/**
 * The only code that creates appointments or holds, and the only code that
 * confirms, releases, expires or reschedules them. Every channel reaches it:
 * the API for staff, the access layer for WhatsApp, the worker for waitlist
 * offers and hold expiry.
 *
 * Lock order (every command, so concurrent commands cannot deadlock):
 *   practitioners (by id) -> referral -> waitlist entry -> waitlist offers
 *   -> slot holds -> appointments (a replacement before the appointment it
 *   replaces).
 * Under those locks the rules are re-checked against committed data; the
 * database exclusion constraint remains the last line of defence against a
 * double booking (translated to SLOT_UNAVAILABLE).
 */

export interface BookingTarget {
  patientId: string;
  appointmentTypeId: string;
  practitionerId: string;
  locationId: string;
  start: Date;
  referralId?: string | null | undefined;
}
export interface BookInput extends BookingTarget {
  notes?: string | null | undefined;
  overrideAvailability?: boolean | undefined;
  waitlistEntryId?: string | null | undefined;
}
export interface HoldInput extends BookingTarget {
  purpose?: HoldPurpose;
  /** The confirmed appointment a RESCHEDULE hold would replace. */
  rescheduleOfId?: string | null | undefined;
  waitlistEntryId?: string | null | undefined;
  /** Internal callers only (waitlist offers); the API uses the practice default. */
  ttlSeconds?: number | undefined;
  notes?: string | null | undefined;
}

interface Prepared {
  now: Date;
  practice: PracticeSettings;
  type: AppointmentTypeRow;
  practitioner: PractitionerRow;
  location: LocationRow;
  end: Date;
}

/**
 * Validate a booking target under the practitioner lock the caller already
 * holds: eligibility, referral, availability and conflicts.
 */
async function prepareBooking(
  c: DbClient,
  ctx: CommandContext,
  target: BookingTarget,
  locked: Map<string, PractitionerRow>,
  options: {
    override: boolean;
    excludeIds: string[];
    waitlistEntryId?: string | null | undefined;
  },
): Promise<Prepared> {
  if (
    options.override &&
    (ctx.actor.type !== "STAFF" || !ctx.mayOverrideAvailability)
  )
    throw new SchedulingError("OVERRIDE_NOT_PERMITTED");
  if (target.start.getUTCSeconds() || target.start.getUTCMilliseconds())
    throw new SchedulingError(
      "NOT_ON_SLOT_GRID",
      "Appointment times are whole minutes.",
    );
  const now = await databaseNow(c);
  const practice = await loadPractice(c, ctx);
  const type = await loadAppointmentType(c, ctx, target.appointmentTypeId);
  const practitioner = locked.get(target.practitionerId)!;
  const location = await loadLocation(c, ctx, target.locationId);
  const patient = await loadPatientFacts(
    c,
    ctx,
    target.patientId,
    target.practitionerId,
  );
  const referral = target.referralId
    ? await lockReferral(c, ctx, target.referralId, options.excludeIds)
    : null;
  if (options.waitlistEntryId)
    await lockOpenWaitlistEntry(c, ctx, options.waitlistEntryId, target);
  const end = new Date(+target.start + type.durationMinutes * MINUTE_MS);
  assertBookingEligibility({
    actor: ctx.actor.type,
    appointmentType: {
      active: type.active,
      requiresReferral: type.requiresReferral,
      newPatientAllowed: type.newPatientAllowed,
      followUpOnly: type.followUpOnly,
      patientBookable: type.patientBookable,
      allowsPractitioner: type.practitionerIds.includes(practitioner.id),
      allowsLocation: type.locationIds.includes(location.id),
    },
    practitioner,
    location,
    patient,
    appointmentDate: localDateOf(target.start, location.timezone),
    referral: referral
      ? {
          patientMatches: referral.patientId === target.patientId,
          status: referral.status,
          appointmentTypeMatches:
            referral.appointmentTypeId === null
              ? null
              : referral.appointmentTypeId === type.id,
          validUntil: referral.validUntil,
          maxAppointments: referral.maxAppointments,
          appointmentsUsed: referral.appointmentsUsed,
        }
      : null,
    referralVerificationRequired: practice.referralVerificationRequired,
  });
  await expireStaleHolds(c, ctx, { practitionerId: practitioner.id });
  const pairs = await loadEligiblePairs(c, ctx, type, {
    practitionerId: practitioner.id,
    locationId: location.id,
    patientChannel: ctx.actor.type === "PATIENT",
  });
  const schedule = await loadScheduleContext(
    c,
    ctx,
    pairs,
    new Date(+target.start - 24 * 60 * MINUTE_MS),
    new Date(+end + 24 * 60 * MINUTE_MS),
  );
  const check = checkSlot(
    {
      actor: ctx.actor.type,
      now,
      timing: timingOf(type, practice),
      excludeAppointmentIds: options.excludeIds,
      override: options.override,
    },
    schedule,
    {
      practitionerId: practitioner.id,
      locationId: location.id,
      start: target.start,
    },
  );
  if (!check.ok)
    throw new SchedulingError(check.code, undefined, {
      practitioner_id: practitioner.id,
      location_id: location.id,
      start: target.start.toISOString(),
    });
  if (
    await patientHasOverlap(
      c,
      ctx,
      target.patientId,
      target.start,
      end,
      options.excludeIds,
    )
  )
    throw new SchedulingError("PATIENT_SCHEDULE_CONFLICT");
  return { now, practice, type, practitioner, location, end };
}

async function insertAppointment(
  c: DbClient,
  ctx: CommandContext,
  p: Prepared,
  target: BookingTarget,
  a: {
    id: string;
    status: "HELD" | "CONFIRMED";
    holdExpiresAt?: Date | null;
    rescheduledFromId?: string | null;
    waitlistEntryId?: string | null;
    notes?: string | null;
    override: boolean;
  },
): Promise<void> {
  await c.query(
    `INSERT INTO scheduling.appointments(tenant_id,practice_id,id,patient_id,practitioner_id,location_id,appointment_type_id,status,
        starts_at,ends_at,timezone,duration_minutes,buffer_before_minutes,buffer_after_minutes,occupied,source_channel,
        booked_by_actor_type,booked_by_actor_id,booked_by_role,referral_id,waitlist_entry_id,hold_expires_at,
        override_availability,notes,rescheduled_from_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'empty',$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      a.id,
      target.patientId,
      target.practitionerId,
      target.locationId,
      target.appointmentTypeId,
      a.status,
      target.start,
      p.end,
      p.location.timezone,
      p.type.durationMinutes,
      p.type.bufferBeforeMinutes,
      p.type.bufferAfterMinutes,
      ctx.channel,
      ctx.actor.type,
      ctx.actor.id,
      ctx.actor.role,
      target.referralId ?? null,
      a.waitlistEntryId ?? null,
      a.holdExpiresAt ?? null,
      a.override,
      a.notes ?? null,
      a.rescheduledFromId ?? null,
    ],
  );
  await c.query(
    `INSERT INTO scheduling.appointment_participants(tenant_id,practice_id,id,appointment_id,participant_type,patient_id,practitioner_id)
     VALUES($1,$2,$3,$4,'PATIENT',$5,NULL),($1,$2,$6,$4,'PRACTITIONER',NULL,$7)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      randomUUID(),
      a.id,
      target.patientId,
      randomUUID(),
      target.practitionerId,
    ],
  );
}

function facts(id: string, status: string, target: BookingTarget, end: Date) {
  return appointmentFacts({
    id,
    status,
    practitionerId: target.practitionerId,
    locationId: target.locationId,
    appointmentTypeId: target.appointmentTypeId,
    patientId: target.patientId,
    startsAt: target.start,
    endsAt: end,
  });
}

/** Direct booking (e.g. receptionist on the phone, walk-in): CONFIRMED at once. */
export async function bookAppointment(
  c: DbClient,
  ctx: CommandContext,
  input: BookInput,
): Promise<string> {
  const locked = await lockPractitioners(c, ctx, [input.practitionerId]);
  const override = input.overrideAvailability === true;
  const p = await prepareBooking(c, ctx, input, locked, {
    override,
    excludeIds: [],
    waitlistEntryId: input.waitlistEntryId,
  });
  const id = randomUUID();
  await insertAppointment(c, ctx, p, input, {
    id,
    status: "CONFIRMED",
    waitlistEntryId: input.waitlistEntryId ?? null,
    notes: input.notes ?? null,
    override,
  });
  if (input.waitlistEntryId)
    await closeWaitlistEntry(c, ctx, input.waitlistEntryId, id);
  await appendAppointmentEvent(c, ctx, {
    appointmentId: id,
    eventType: "CONFIRMED",
    from: null,
    to: "CONFIRMED",
    details: override ? { override_availability: true } : {},
  });
  const f = facts(id, "CONFIRMED", input, p.end);
  await emit(
    c,
    ctx,
    "APPOINTMENT_CONFIRMED",
    { type: "appointment", id },
    {
      ...f,
      source_channel: ctx.channel,
      referral_id: input.referralId ?? null,
    },
  );
  await audit(c, ctx, {
    action: "appointment.created",
    resourceType: "appointment",
    resourceId: id,
    after: { ...f, source_channel: ctx.channel },
  });
  if (override)
    await audit(c, ctx, {
      action: "appointment.availability_overridden",
      resourceType: "appointment",
      resourceId: id,
      after: f,
    });
  return id;
}

/**
 * Temporarily reserve a slot for a patient: a HELD appointment plus its slot
 * hold, expiring after the practice's hold time. The hold blocks the slot for
 * every channel until it is confirmed, released or expires.
 */
export async function createHold(
  c: DbClient,
  ctx: CommandContext,
  input: HoldInput,
): Promise<{ holdId: string; appointmentId: string; expiresAt: Date }> {
  const purpose = input.purpose ?? "BOOKING";
  if ((purpose === "RESCHEDULE") !== Boolean(input.rescheduleOfId))
    throw new SchedulingError(
      "INVALID_TRANSITION",
      "A reschedule hold names the appointment it replaces.",
    );
  const original = input.rescheduleOfId
    ? await readAppointment(c, ctx, input.rescheduleOfId, false)
    : null;
  const locked = await lockPractitioners(c, ctx, [
    input.practitionerId,
    ...(original ? [original.practitionerId] : []),
  ]);
  const target: BookingTarget = original
    ? {
        ...input,
        patientId: original.patientId,
        appointmentTypeId: original.appointmentTypeId,
        referralId: original.referralId,
      }
    : input;
  const p = await prepareBooking(c, ctx, target, locked, {
    override: false,
    excludeIds: original ? [original.id] : [],
    waitlistEntryId: original ? null : input.waitlistEntryId,
  });
  if (original) {
    // Lock order: holds after the referral (taken in prepareBooking).
    await expireStaleHolds(c, ctx, { rescheduleOfId: original.id });
    const pending = await c.query(
      `SELECT id FROM scheduling.slot_holds
        WHERE tenant_id=$1 AND practice_id=$2 AND reschedule_of_id=$3 AND status='ACTIVE' FOR UPDATE`,
      [ctx.tenantId, ctx.practiceId, original.id],
    );
    if (pending.rowCount)
      throw new SchedulingError(
        "INVALID_TRANSITION",
        "The appointment is already being rescheduled.",
      );
    const current = await readAppointment(c, ctx, original.id, true);
    if (current.status !== "CONFIRMED")
      throw new SchedulingError(
        "INVALID_TRANSITION",
        "Only a confirmed appointment can be rescheduled.",
      );
    assertPatientChangeAllowed({
      actor: ctx.actor.type,
      startsAt: current.startsAt,
      now: p.now,
      cutoffMinutes: p.practice.patientChangeCutoffMinutes,
    });
  }
  const ttl = input.ttlSeconds ?? p.practice.holdTtlSeconds;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 7 * 24 * 3600)
    throw new RangeError("hold TTL out of range");
  const expiresAt = new Date(+p.now + ttl * 1000);
  const appointmentId = randomUUID();
  const holdId = randomUUID();
  await insertAppointment(c, ctx, p, target, {
    id: appointmentId,
    status: "HELD",
    holdExpiresAt: expiresAt,
    rescheduledFromId: original?.id ?? null,
    waitlistEntryId: input.waitlistEntryId ?? null,
    notes: input.notes ?? null,
    override: false,
  });
  await c.query(
    `INSERT INTO scheduling.slot_holds(tenant_id,practice_id,id,appointment_id,patient_id,practitioner_id,location_id,
        appointment_type_id,starts_at,ends_at,expires_at,status,purpose,reschedule_of_id,owner_channel,owner_actor_type,
        owner_actor_id,owner_session_ref)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE',$12,$13,$14,$15,$16,$17)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      holdId,
      appointmentId,
      target.patientId,
      target.practitionerId,
      target.locationId,
      target.appointmentTypeId,
      target.start,
      p.end,
      expiresAt,
      purpose,
      original?.id ?? null,
      ctx.channel,
      ctx.actor.type,
      ctx.actor.id,
      ctx.sessionRef ?? null,
    ],
  );
  await appendAppointmentEvent(c, ctx, {
    appointmentId,
    eventType: "HELD",
    from: null,
    to: "HELD",
    details: {
      hold_id: holdId,
      expires_at: expiresAt.toISOString(),
      purpose,
      ...(original ? { reschedule_of: original.id } : {}),
    },
  });
  return { holdId, appointmentId, expiresAt };
}

function assertHoldUsable(hold: HoldRow, now: Date) {
  if (
    hold.status === "EXPIRED" ||
    (hold.status === "ACTIVE" && hold.expiresAt <= now)
  )
    throw new SchedulingError("HOLD_EXPIRED", undefined, {
      hold_id: hold.id,
      expired_at: hold.expiresAt.toISOString(),
    });
  if (hold.status !== "ACTIVE")
    throw new SchedulingError("HOLD_NOT_ACTIVE", undefined, {
      hold_id: hold.id,
      status: hold.status,
    });
}

/**
 * Who may act on a hold. Staff share the practice's staff holds; a patient
 * channel only its own conversation's holds. Waitlist offer holds are
 * confirmed through the waitlist (which checks the offer's patient).
 */
function assertHoldOwner(
  ctx: CommandContext,
  hold: HoldRow,
  action: "confirm" | "release",
  internal: boolean,
) {
  if (internal) return;
  if (ctx.actor.type === "STAFF") {
    if (action === "release" || hold.ownerActorType === "STAFF") return;
  } else if (
    ctx.actor.type === "PATIENT" &&
    hold.ownerActorType === "PATIENT" &&
    hold.ownerSessionRef !== null &&
    hold.ownerSessionRef === ctx.sessionRef
  )
    return;
  throw new SchedulingError("HOLD_NOT_OWNED");
}

/**
 * Consume a hold: its HELD appointment becomes CONFIRMED atomically with the
 * hold becoming CONSUMED. A RESCHEDULE hold also moves the original to
 * RESCHEDULED, linked both ways. Expired holds can never be consumed (checked
 * here and by the database trigger).
 */
export async function confirmHold(
  c: DbClient,
  ctx: CommandContext,
  holdId: string,
  input: { notes?: string | null | undefined } = {},
  options: { internal?: boolean } = {},
): Promise<string> {
  const peek = await readHold(c, ctx, holdId, false);
  const peekAppointment = await readAppointment(
    c,
    ctx,
    peek.appointmentId,
    false,
  );
  const original = peek.rescheduleOfId
    ? await readAppointment(c, ctx, peek.rescheduleOfId, false)
    : null;
  await lockPractitioners(c, ctx, [
    peek.practitionerId,
    ...(original ? [original.practitionerId] : []),
  ]);
  const practice = await loadPractice(c, ctx);
  const referral = peekAppointment.referralId
    ? await lockReferral(c, ctx, peekAppointment.referralId, [
        peek.appointmentId,
      ])
    : null;
  if (peekAppointment.waitlistEntryId)
    await lockOpenWaitlistEntry(
      c,
      ctx,
      peekAppointment.waitlistEntryId,
      peekAppointment,
    );
  const hold = await readHold(c, ctx, holdId, true);
  const now = await databaseNow(c);
  assertHoldUsable(hold, now);
  assertHoldOwner(ctx, hold, "confirm", options.internal === true);
  const appointment = await readAppointment(c, ctx, hold.appointmentId, true);
  assertTransition(appointment.status, "CONFIRMED");
  // Rules are re-evaluated at commit: configuration may have changed while
  // the slot was held.
  const type = await loadAppointmentType(c, ctx, appointment.appointmentTypeId);
  const location = await loadLocation(c, ctx, appointment.locationId);
  const locked = await lockPractitioners(c, ctx, [appointment.practitionerId]);
  const patient = await loadPatientFacts(
    c,
    ctx,
    appointment.patientId,
    appointment.practitionerId,
  );
  assertBookingEligibility({
    actor: options.internal ? "SYSTEM" : ctx.actor.type,
    appointmentType: {
      active: type.active,
      requiresReferral: type.requiresReferral,
      newPatientAllowed: type.newPatientAllowed,
      followUpOnly: type.followUpOnly,
      patientBookable: type.patientBookable,
      allowsPractitioner: type.practitionerIds.includes(
        appointment.practitionerId,
      ),
      allowsLocation: type.locationIds.includes(appointment.locationId),
    },
    practitioner: locked.get(appointment.practitionerId)!,
    location,
    patient,
    appointmentDate: localDateOf(appointment.startsAt, appointment.timezone),
    referral: referral
      ? {
          patientMatches: referral.patientId === appointment.patientId,
          status: referral.status,
          appointmentTypeMatches:
            referral.appointmentTypeId === null
              ? null
              : referral.appointmentTypeId === type.id,
          validUntil: referral.validUntil,
          maxAppointments: referral.maxAppointments,
          appointmentsUsed: referral.appointmentsUsed,
        }
      : null,
    referralVerificationRequired: practice.referralVerificationRequired,
  });
  await c.query(
    `UPDATE scheduling.slot_holds SET status='CONSUMED', closed_at=now(), close_reason='CONSUMED'
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, hold.id],
  );
  await c.query(
    `UPDATE scheduling.appointments SET status='CONFIRMED', confirmed_at=now(), notes=coalesce($4,notes), version=version+1
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, appointment.id, input.notes ?? null],
  );
  const f = appointmentFacts({ ...appointment, status: "CONFIRMED" });
  if (appointment.waitlistEntryId)
    await closeWaitlistEntry(
      c,
      ctx,
      appointment.waitlistEntryId,
      appointment.id,
    );
  if (hold.purpose === "RESCHEDULE" && hold.rescheduleOfId) {
    const previous = await readAppointment(c, ctx, hold.rescheduleOfId, true);
    assertTransition(previous.status, "RESCHEDULED");
    assertPatientChangeAllowed({
      actor: options.internal ? "SYSTEM" : ctx.actor.type,
      startsAt: previous.startsAt,
      now,
      cutoffMinutes: practice.patientChangeCutoffMinutes,
    });
    await markRescheduled(c, ctx, previous, appointment.id);
    await appendAppointmentEvent(c, ctx, {
      appointmentId: appointment.id,
      eventType: "RESCHEDULED_FROM",
      from: "HELD",
      to: "CONFIRMED",
      details: { rescheduled_from: previous.id, hold_id: hold.id },
    });
    await emit(
      c,
      ctx,
      "APPOINTMENT_RESCHEDULED",
      { type: "appointment", id: appointment.id },
      {
        ...f,
        previous_appointment_id: previous.id,
        previous_starts_at: previous.startsAt.toISOString(),
        previous_practitioner_id: previous.practitionerId,
        source_channel: ctx.channel,
      },
    );
    await audit(c, ctx, {
      action: "appointment.rescheduled",
      resourceType: "appointment",
      resourceId: previous.id,
      before: appointmentFacts(previous),
      after: f,
    });
  } else {
    await appendAppointmentEvent(c, ctx, {
      appointmentId: appointment.id,
      eventType: "CONFIRMED",
      from: "HELD",
      to: "CONFIRMED",
      details: { hold_id: hold.id },
    });
    await emit(
      c,
      ctx,
      "APPOINTMENT_CONFIRMED",
      { type: "appointment", id: appointment.id },
      {
        ...f,
        source_channel: appointment.sourceChannel,
        // Where the patient or staff confirmed it (a waitlist offer is
        // held by the system and accepted through a channel).
        confirmed_via: ctx.channel,
        referral_id: appointment.referralId,
        waitlist_entry_id: appointment.waitlistEntryId,
      },
    );
    await audit(c, ctx, {
      action: "appointment.created",
      resourceType: "appointment",
      resourceId: appointment.id,
      after: {
        ...f,
        source_channel: appointment.sourceChannel,
        hold_id: hold.id,
      },
    });
  }
  return appointment.id;
}

/**
 * A booking for a waitlisted patient must match their open entry. Lock
 * order: after the practitioner and referral, before offers, holds and
 * appointments.
 */
async function lockOpenWaitlistEntry(
  c: DbClient,
  ctx: CommandContext,
  entryId: string,
  target: { patientId: string; appointmentTypeId: string },
): Promise<void> {
  const r = await c.query<{
    patient_id: string;
    appointment_type_id: string;
    status: string;
  }>(
    `SELECT patient_id, appointment_type_id, status FROM scheduling.waitlist_entries
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId, entryId],
  );
  const e = r.rows[0];
  if (
    !e ||
    e.patient_id !== target.patientId ||
    e.appointment_type_id !== target.appointmentTypeId
  )
    throw new SchedulingError("WAITLIST_ENTRY_NOT_FOUND");
  if (e.status !== "ACTIVE" && e.status !== "OFFERED")
    throw new SchedulingError("WAITLIST_ENTRY_CLOSED");
}

/**
 * The waitlisted patient is booked: their entry closes (BOOKED), the offer
 * behind this appointment (if any) is accepted and any other offer still
 * pending for the entry is withdrawn, its slot released.
 */
async function closeWaitlistEntry(
  c: DbClient,
  ctx: CommandContext,
  entryId: string,
  appointmentId: string,
): Promise<void> {
  const offers = await c.query<{
    id: string;
    appointment_id: string;
    practitioner_id: string;
    location_id: string;
    starts_at: Date;
    future: boolean;
  }>(
    `SELECT id, appointment_id, practitioner_id, location_id, starts_at, starts_at > now() AS future
       FROM scheduling.waitlist_offers
      WHERE tenant_id=$1 AND practice_id=$2 AND waitlist_entry_id=$3 AND status='PENDING'
      ORDER BY id FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId, entryId],
  );
  for (const o of offers.rows) {
    const accepted = o.appointment_id === appointmentId;
    if (!accepted) {
      const hold = await c.query<{ id: string }>(
        `SELECT id FROM scheduling.slot_holds
          WHERE tenant_id=$1 AND practice_id=$2 AND appointment_id=$3 AND status='ACTIVE'`,
        [ctx.tenantId, ctx.practiceId, o.appointment_id],
      );
      if (hold.rows[0])
        await releaseHold(c, ctx, hold.rows[0].id, { internal: true });
      // The slot this patient no longer needs goes to the next one.
      if (o.future)
        await emit(
          c,
          ctx,
          "WAITLIST_SLOT_AVAILABLE",
          { type: "practitioner", id: o.practitioner_id },
          {
            practitioner_id: o.practitioner_id,
            location_id: o.location_id,
            starts_at: o.starts_at.toISOString(),
          },
        );
    }
    await c.query(
      `UPDATE scheduling.waitlist_offers
          SET status=$4, responded_at=CASE WHEN $4='ACCEPTED' THEN now() END, response_channel=$5,
              version=version+1, updated_at=now()
        WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
      [
        ctx.tenantId,
        ctx.practiceId,
        o.id,
        accepted ? "ACCEPTED" : "WITHDRAWN",
        accepted
          ? ctx.actor.type === "SYSTEM"
            ? "SYSTEM"
            : ctx.channel
          : null,
      ],
    );
  }
  await c.query(
    `UPDATE scheduling.waitlist_entries
        SET status='BOOKED', booked_appointment_id=$4, closed_at=now(), closed_by=$5, version=version+1, updated_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, entryId, appointmentId, ctx.actor.id],
  );
  await audit(c, ctx, {
    action: "waitlist.entry_booked",
    resourceType: "waitlist_entry",
    resourceId: entryId,
    after: { status: "BOOKED", appointment_id: appointmentId },
  });
}

async function markRescheduled(
  c: DbClient,
  ctx: CommandContext,
  previous: AppointmentRow,
  replacementId: string,
) {
  await c.query(
    `UPDATE scheduling.appointments
        SET status='RESCHEDULED', rescheduled_to_id=$4, rescheduled_at=now(), rescheduled_by=$5, version=version+1
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, previous.id, replacementId, ctx.actor.id],
  );
  await appendAppointmentEvent(c, ctx, {
    appointmentId: previous.id,
    eventType: "RESCHEDULED",
    from: previous.status,
    to: "RESCHEDULED",
    details: { rescheduled_to: replacementId },
  });
}

/** Give a held slot back. The HELD appointment is cancelled (HOLD_RELEASED). */
export async function releaseHold(
  c: DbClient,
  ctx: CommandContext,
  holdId: string,
  options: { internal?: boolean; reason?: "OFFER_DECLINED" } = {},
): Promise<void> {
  const hold = await readHold(c, ctx, holdId, true);
  const now = await databaseNow(c);
  if (hold.status !== "ACTIVE")
    throw new SchedulingError("HOLD_NOT_ACTIVE", undefined, {
      hold_id: hold.id,
      status: hold.status,
    });
  if (hold.expiresAt <= now) {
    // Already lapsed: record the expiry rather than a release.
    await expireHold(c, ctx, hold);
    return;
  }
  assertHoldOwner(ctx, hold, "release", options.internal === true);
  const closeReason =
    options.reason ??
    (ctx.actor.type === "STAFF" && hold.ownerActorType !== "STAFF"
      ? "RELEASED_BY_STAFF"
      : "RELEASED_BY_OWNER");
  await c.query(
    `UPDATE scheduling.slot_holds SET status='RELEASED', closed_at=now(), close_reason=$4
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, hold.id, closeReason],
  );
  const reasonCode =
    options.reason === "OFFER_DECLINED"
      ? "WAITLIST_OFFER_DECLINED"
      : "HOLD_RELEASED";
  await c.query(
    `UPDATE scheduling.appointments
        SET status='CANCELLED', cancelled_at=now(), cancelled_by=$4, cancellation_reason_code=$5, version=version+1
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [
      ctx.tenantId,
      ctx.practiceId,
      hold.appointmentId,
      ctx.actor.id,
      reasonCode,
    ],
  );
  await appendAppointmentEvent(c, ctx, {
    appointmentId: hold.appointmentId,
    eventType: "HOLD_RELEASED",
    from: "HELD",
    to: "CANCELLED",
    reasonCode: closeReason,
    details: { hold_id: hold.id },
  });
  await emit(
    c,
    ctx,
    "HOLD_RELEASED",
    { type: "slot_hold", id: hold.id },
    {
      hold_id: hold.id,
      appointment_id: hold.appointmentId,
      purpose: hold.purpose,
      owner_session_ref: hold.ownerSessionRef,
      practitioner_id: hold.practitionerId,
      starts_at: hold.startsAt.toISOString(),
      close_reason: closeReason,
    },
  );
}

async function expireHold(c: DbClient, ctx: CommandContext, hold: HoldRow) {
  await c.query(
    `UPDATE scheduling.slot_holds SET status='EXPIRED', closed_at=now(), close_reason='EXPIRED'
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, hold.id],
  );
  await c.query(
    `UPDATE scheduling.appointments SET status='EXPIRED', expired_at=now(), version=version+1
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, hold.appointmentId],
  );
  await appendAppointmentEvent(
    c,
    { ...ctx, actor: { type: "SYSTEM", id: "system:hold-expiry", role: null } },
    {
      appointmentId: hold.appointmentId,
      eventType: "EXPIRED",
      from: "HELD",
      to: "EXPIRED",
      details: { hold_id: hold.id, expires_at: hold.expiresAt.toISOString() },
    },
  );
  await emit(
    c,
    ctx,
    "HOLD_EXPIRED",
    { type: "slot_hold", id: hold.id },
    {
      hold_id: hold.id,
      appointment_id: hold.appointmentId,
      purpose: hold.purpose,
      owner_session_ref: hold.ownerSessionRef,
      practitioner_id: hold.practitionerId,
      starts_at: hold.startsAt.toISOString(),
    },
  );
}

/**
 * Expire lapsed holds, either for one practitioner or replacement holds of
 * one appointment (called under the practitioner lock before a booking, so a
 * lapsed hold never blocks a new booking), or up to `limit` holds of the
 * practice (the worker's sweep; rows another transaction holds are skipped).
 */
export async function expireStaleHolds(
  c: DbClient,
  ctx: CommandContext,
  scope: {
    practitionerId?: string;
    rescheduleOfId?: string;
    limit?: number;
  },
): Promise<number> {
  const due = await c.query(
    `SELECT id,appointment_id,patient_id,practitioner_id,location_id,appointment_type_id,starts_at,ends_at,expires_at,
            status,purpose,reschedule_of_id,owner_channel,owner_actor_type,owner_actor_id,owner_session_ref,created_at,
            closed_at,close_reason
       FROM scheduling.slot_holds
      WHERE tenant_id=$1 AND practice_id=$2 AND status='ACTIVE' AND expires_at <= now()
        AND ($3::uuid IS NULL OR practitioner_id=$3) AND ($4::uuid IS NULL OR reschedule_of_id=$4)
      ORDER BY expires_at, id
      LIMIT $5
      FOR UPDATE ${scope.limit ? "SKIP LOCKED" : ""}`,
    [
      ctx.tenantId,
      ctx.practiceId,
      scope.practitionerId ?? null,
      scope.rescheduleOfId ?? null,
      scope.limit ?? 10_000,
    ],
  );
  for (const r of due.rows)
    await expireHold(c, ctx, {
      id: r.id,
      appointmentId: r.appointment_id,
      patientId: r.patient_id,
      practitionerId: r.practitioner_id,
      locationId: r.location_id,
      appointmentTypeId: r.appointment_type_id,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      expiresAt: r.expires_at,
      status: r.status,
      purpose: r.purpose,
      rescheduleOfId: r.reschedule_of_id,
      ownerChannel: r.owner_channel,
      ownerActorType: r.owner_actor_type,
      ownerActorId: r.owner_actor_id,
      ownerSessionRef: r.owner_session_ref,
      createdAt: r.created_at,
      closedAt: r.closed_at,
      closeReason: r.close_reason,
    });
  return due.rowCount ?? 0;
}

export interface RescheduleInput {
  start: Date;
  practitionerId?: string | undefined;
  locationId?: string | undefined;
  note?: string | null | undefined;
  expectedVersion?: number | undefined;
  overrideAvailability?: boolean | undefined;
}
/**
 * Move a confirmed appointment in one transaction: the original becomes
 * RESCHEDULED (history kept) and a new CONFIRMED appointment replaces it,
 * linked both ways. The original's own time does not block its replacement.
 */
export async function rescheduleAppointment(
  c: DbClient,
  ctx: CommandContext,
  appointmentId: string,
  input: RescheduleInput,
): Promise<string> {
  const peek = await readAppointment(c, ctx, appointmentId, false);
  const target: BookingTarget = {
    patientId: peek.patientId,
    appointmentTypeId: peek.appointmentTypeId,
    practitionerId: input.practitionerId ?? peek.practitionerId,
    locationId: input.locationId ?? peek.locationId,
    start: input.start,
    referralId: peek.referralId,
  };
  const locked = await lockPractitioners(c, ctx, [
    peek.practitionerId,
    target.practitionerId,
  ]);
  const override = input.overrideAvailability === true;
  const p = await prepareBooking(c, ctx, target, locked, {
    override,
    excludeIds: [peek.id],
  });
  await expireStaleHolds(c, ctx, { rescheduleOfId: peek.id });
  const pending = await c.query(
    `SELECT id FROM scheduling.slot_holds
      WHERE tenant_id=$1 AND practice_id=$2 AND reschedule_of_id=$3 AND status='ACTIVE' FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId, peek.id],
  );
  if (pending.rowCount)
    throw new SchedulingError(
      "INVALID_TRANSITION",
      "The appointment is already being rescheduled through another channel.",
    );
  const original = await readAppointment(c, ctx, appointmentId, true);
  if (
    input.expectedVersion !== undefined &&
    original.version !== input.expectedVersion
  )
    throw new SchedulingError("VERSION_CONFLICT");
  assertTransition(original.status, "RESCHEDULED");
  assertPatientChangeAllowed({
    actor: ctx.actor.type,
    startsAt: original.startsAt,
    now: p.now,
    cutoffMinutes: p.practice.patientChangeCutoffMinutes,
  });
  const id = randomUUID();
  await markRescheduled(c, ctx, original, id);
  await insertAppointment(c, ctx, p, target, {
    id,
    status: "CONFIRMED",
    rescheduledFromId: original.id,
    notes: input.note ?? original.notes,
    override,
  });
  await appendAppointmentEvent(c, ctx, {
    appointmentId: id,
    eventType: "RESCHEDULED_FROM",
    from: null,
    to: "CONFIRMED",
    details: {
      rescheduled_from: original.id,
      ...(override ? { override_availability: true } : {}),
    },
  });
  const f = facts(id, "CONFIRMED", target, p.end);
  await emit(
    c,
    ctx,
    "APPOINTMENT_RESCHEDULED",
    { type: "appointment", id },
    {
      ...f,
      previous_appointment_id: original.id,
      previous_starts_at: original.startsAt.toISOString(),
      previous_practitioner_id: original.practitionerId,
      source_channel: ctx.channel,
    },
  );
  await audit(c, ctx, {
    action: "appointment.rescheduled",
    resourceType: "appointment",
    resourceId: original.id,
    before: appointmentFacts(original),
    after: f,
  });
  if (override)
    await audit(c, ctx, {
      action: "appointment.availability_overridden",
      resourceType: "appointment",
      resourceId: id,
      after: f,
    });
  return id;
}
