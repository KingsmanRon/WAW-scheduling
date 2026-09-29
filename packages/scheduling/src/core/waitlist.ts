import { randomUUID } from "node:crypto";
import type { DbClient } from "@access/db";
import { SchedulingError } from "../domain/errors.js";
import { MINUTE_MS } from "../domain/time.js";
import { confirmHold, createHold, releaseHold } from "./bookings.js";
import type { CommandContext } from "./context.js";
import { audit, emit } from "./effects.js";
import { patientDisplayName } from "./queries.js";
import {
  databaseNow,
  loadAppointmentType,
  loadLocation,
  loadPractice,
  lockPractitioners,
  lockReferral,
  type Scope,
} from "./repository.js";

/**
 * The waitlist: patients waiting for an earlier or any appointment of a
 * type, in a deterministic queue (administrative priority, then first come
 * first served - never clinical triage). When a future slot is freed the
 * worker offers it to the first matching patient: the slot is reserved as a
 * WAITLIST_OFFER hold for the practice's offer time, and nothing is booked
 * unless the patient (or staff on their behalf) accepts. A declined or
 * lapsed offer passes the slot to the next patient.
 *
 * Lock order as in bookings.ts: practitioner -> referral -> waitlist entry
 * -> waitlist offer -> slot hold -> appointment.
 */

/** A patient needs this long after an offer lapses to reach the practice. */
const OFFER_ANSWER_MARGIN_MS = 30 * MINUTE_MS;

export interface WaitlistEntryInput {
  patientId: string;
  appointmentTypeId: string;
  practitionerId?: string | null | undefined;
  locationId?: string | null | undefined;
  /** ISO dates (YYYY-MM-DD) in the practice's time zone. */
  earliestDate: string;
  latestDate: string;
  /** ISO weekdays (1 = Monday); empty: any day. */
  preferredWeekdays?: number[] | undefined;
  /** Minutes after local midnight the appointment may start from / before. */
  preferredStartMinute?: number | null | undefined;
  preferredEndMinute?: number | null | undefined;
  /** 1: raised by staff (administrative only). */
  priority?: 0 | 1 | undefined;
  referralId?: string | null | undefined;
}

export interface WaitlistEntryView {
  id: string;
  status: "ACTIVE" | "OFFERED" | "BOOKED" | "CANCELLED" | "EXPIRED";
  patient: { id: string; display_name: string; patient_number: string };
  appointment_type: { id: string; name: string };
  practitioner: { id: string; display_name: string } | null;
  location: { id: string; name: string } | null;
  earliest_date: string;
  latest_date: string;
  preferred_weekdays: number[];
  preferred_start_minute: number | null;
  preferred_end_minute: number | null;
  priority: number;
  referral_id: string | null;
  source_channel: string;
  booked_appointment_id: string | null;
  pending_offer: {
    id: string;
    starts_at: string;
    expires_at: string;
    practitioner_id: string;
    location_id: string;
  } | null;
  created_at: string;
  closed_at: string | null;
  version: number;
}
export interface WaitlistOfferView {
  id: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "WITHDRAWN";
  appointment_id: string;
  practitioner_id: string;
  location_id: string;
  starts_at: string;
  ends_at: string;
  offered_at: string;
  expires_at: string;
  responded_at: string | null;
  response_channel: string | null;
}

const ENTRY_VIEW = `SELECT e.id, e.status, e.patient_id, p.given_name, p.family_name, p.preferred_name, p.patient_number,
    e.appointment_type_id, t.name AS appointment_type_name, e.practitioner_id, pr.display_name AS practitioner_name,
    e.location_id, l.name AS location_name, e.earliest_date::text AS earliest_date, e.latest_date::text AS latest_date,
    e.preferred_weekdays, e.preferred_start_minute, e.preferred_end_minute, e.priority, e.referral_id,
    e.source_channel, e.booked_appointment_id, e.created_at, e.closed_at, e.version,
    o.id AS offer_id, o.starts_at AS offer_starts_at, o.expires_at AS offer_expires_at,
    o.practitioner_id AS offer_practitioner_id, o.location_id AS offer_location_id
  FROM scheduling.waitlist_entries e
  JOIN directory.patients p ON p.tenant_id=e.tenant_id AND p.practice_id=e.practice_id AND p.id=e.patient_id
  JOIN scheduling.appointment_types t ON t.tenant_id=e.tenant_id AND t.practice_id=e.practice_id AND t.id=e.appointment_type_id
  LEFT JOIN scheduling.practitioners pr ON pr.tenant_id=e.tenant_id AND pr.practice_id=e.practice_id AND pr.id=e.practitioner_id
  LEFT JOIN directory.practice_locations l ON l.tenant_id=e.tenant_id AND l.practice_id=e.practice_id AND l.id=e.location_id
  LEFT JOIN scheduling.waitlist_offers o ON o.tenant_id=e.tenant_id AND o.practice_id=e.practice_id
       AND o.waitlist_entry_id=e.id AND o.status='PENDING'`;

function entryView(r: Record<string, unknown>): WaitlistEntryView {
  const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
  return {
    id: r.id as string,
    status: r.status as WaitlistEntryView["status"],
    patient: {
      id: r.patient_id as string,
      display_name: patientDisplayName({
        given_name: r.given_name as string,
        family_name: r.family_name as string,
        preferred_name: (r.preferred_name as string | null) ?? null,
      }),
      patient_number: r.patient_number as string,
    },
    appointment_type: {
      id: r.appointment_type_id as string,
      name: r.appointment_type_name as string,
    },
    practitioner: r.practitioner_id
      ? {
          id: r.practitioner_id as string,
          display_name: r.practitioner_name as string,
        }
      : null,
    location: r.location_id
      ? { id: r.location_id as string, name: r.location_name as string }
      : null,
    earliest_date: r.earliest_date as string,
    latest_date: r.latest_date as string,
    preferred_weekdays: (r.preferred_weekdays as number[]) ?? [],
    preferred_start_minute: (r.preferred_start_minute as number) ?? null,
    preferred_end_minute: (r.preferred_end_minute as number) ?? null,
    priority: r.priority as number,
    referral_id: (r.referral_id as string) ?? null,
    source_channel: r.source_channel as string,
    booked_appointment_id: (r.booked_appointment_id as string) ?? null,
    pending_offer: r.offer_id
      ? {
          id: r.offer_id as string,
          starts_at: iso(r.offer_starts_at)!,
          expires_at: iso(r.offer_expires_at)!,
          practitioner_id: r.offer_practitioner_id as string,
          location_id: r.offer_location_id as string,
        }
      : null,
    created_at: iso(r.created_at)!,
    closed_at: iso(r.closed_at),
    version: r.version as number,
  };
}

/** Today in the practice's time zone (ISO date). */
async function practiceToday(c: DbClient, s: Scope): Promise<string> {
  const r = await c.query<{ today: string }>(
    `SELECT (now() AT TIME ZONE timezone)::date::text AS today
       FROM directory.practices WHERE tenant_id=$1 AND id=$2`,
    [s.tenantId, s.practiceId],
  );
  if (!r.rows[0]) throw new SchedulingError("PRACTICE_NOT_FOUND");
  return r.rows[0].today;
}

/** Put a patient on the waitlist for an appointment type. */
export async function addToWaitlist(
  c: DbClient,
  ctx: CommandContext,
  input: WaitlistEntryInput,
): Promise<string> {
  const patient = await c.query<{ status: string }>(
    "SELECT status FROM directory.patients WHERE tenant_id=$1 AND practice_id=$2 AND id=$3",
    [ctx.tenantId, ctx.practiceId, input.patientId],
  );
  if (!patient.rows[0]) throw new SchedulingError("PATIENT_NOT_FOUND");
  if (patient.rows[0].status !== "ACTIVE")
    throw new SchedulingError("PATIENT_INACTIVE");
  const type = await loadAppointmentType(c, ctx, input.appointmentTypeId);
  if (!type.active) throw new SchedulingError("APPOINTMENT_TYPE_INACTIVE");
  if (input.practitionerId) {
    await lockPractitioners(c, ctx, [input.practitionerId]);
    if (!type.practitionerIds.includes(input.practitionerId))
      throw new SchedulingError("PRACTITIONER_NOT_ALLOWED");
  }
  if (input.locationId) {
    await loadLocation(c, ctx, input.locationId);
    if (!type.locationIds.includes(input.locationId))
      throw new SchedulingError("LOCATION_NOT_ALLOWED");
  }
  if (input.referralId) {
    const referral = await lockReferral(c, ctx, input.referralId, []);
    if (
      referral.patientId !== input.patientId ||
      (referral.appointmentTypeId !== null &&
        referral.appointmentTypeId !== type.id)
    )
      throw new SchedulingError("REFERRAL_MISMATCH");
    if (referral.status === "REJECTED" || referral.status === "CANCELLED")
      throw new SchedulingError("REFERRAL_NOT_VERIFIED");
  } else if (type.requiresReferral)
    throw new SchedulingError("REFERRAL_REQUIRED");
  const today = await practiceToday(c, ctx);
  if (
    input.latestDate < today ||
    input.latestDate < input.earliestDate ||
    Date.parse(input.latestDate) - Date.parse(input.earliestDate) >
      366 * 24 * 3600_000
  )
    throw new SchedulingError("WAITLIST_WINDOW_INVALID");
  const open = await c.query(
    `SELECT 1 FROM scheduling.waitlist_entries
      WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 AND appointment_type_id=$4
        AND status IN ('ACTIVE','OFFERED')`,
    [ctx.tenantId, ctx.practiceId, input.patientId, type.id],
  );
  if (open.rowCount) throw new SchedulingError("WAITLIST_DUPLICATE");
  const id = randomUUID();
  const weekdays = [...new Set(input.preferredWeekdays ?? [])].sort();
  await c.query(
    `INSERT INTO scheduling.waitlist_entries(tenant_id,practice_id,id,patient_id,appointment_type_id,practitioner_id,
        location_id,earliest_date,latest_date,preferred_weekdays,preferred_start_minute,preferred_end_minute,priority,
        referral_id,source_channel,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::smallint[],$11,$12,$13,$14,$15,$16)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      input.patientId,
      type.id,
      input.practitionerId ?? null,
      input.locationId ?? null,
      input.earliestDate,
      input.latestDate,
      weekdays,
      input.preferredStartMinute ?? null,
      input.preferredEndMinute ?? null,
      input.priority ?? 0,
      input.referralId ?? null,
      ctx.channel,
      ctx.actor.id,
    ],
  );
  await audit(c, ctx, {
    action: "waitlist.entry_created",
    resourceType: "waitlist_entry",
    resourceId: id,
    after: {
      patient_id: input.patientId,
      appointment_type_id: type.id,
      practitioner_id: input.practitionerId ?? null,
      location_id: input.locationId ?? null,
      earliest_date: input.earliestDate,
      latest_date: input.latestDate,
      priority: input.priority ?? 0,
    },
  });
  return id;
}

export async function listWaitlist(
  c: DbClient,
  s: Scope,
  q: {
    status?: WaitlistEntryView["status"] | undefined;
    appointmentTypeId?: string | undefined;
    patientId?: string | undefined;
    limit: number;
  },
): Promise<WaitlistEntryView[]> {
  const r = await c.query(
    `${ENTRY_VIEW}
      WHERE e.tenant_id=$1 AND e.practice_id=$2
        AND (CASE WHEN $3::text IS NULL THEN e.status IN ('ACTIVE','OFFERED') ELSE e.status=$3 END)
        AND ($4::uuid IS NULL OR e.appointment_type_id=$4) AND ($5::uuid IS NULL OR e.patient_id=$5)
      ORDER BY e.priority DESC, e.created_at, e.id LIMIT $6`,
    [
      s.tenantId,
      s.practiceId,
      q.status ?? null,
      q.appointmentTypeId ?? null,
      q.patientId ?? null,
      q.limit,
    ],
  );
  return r.rows.map(entryView);
}

export async function getWaitlistEntry(
  c: DbClient,
  s: Scope,
  id: string,
): Promise<WaitlistEntryView & { offers: WaitlistOfferView[] }> {
  const r = await c.query(
    `${ENTRY_VIEW} WHERE e.tenant_id=$1 AND e.practice_id=$2 AND e.id=$3`,
    [s.tenantId, s.practiceId, id],
  );
  if (!r.rows[0]) throw new SchedulingError("WAITLIST_ENTRY_NOT_FOUND");
  const offers = await c.query(
    `SELECT id, status, appointment_id, practitioner_id, location_id, starts_at, ends_at, offered_at, expires_at,
            responded_at, response_channel
       FROM scheduling.waitlist_offers WHERE tenant_id=$1 AND practice_id=$2 AND waitlist_entry_id=$3
      ORDER BY offered_at DESC, id DESC LIMIT 50`,
    [s.tenantId, s.practiceId, id],
  );
  const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
  return {
    ...entryView(r.rows[0]),
    offers: offers.rows.map((o) => ({
      id: o.id,
      status: o.status,
      appointment_id: o.appointment_id,
      practitioner_id: o.practitioner_id,
      location_id: o.location_id,
      starts_at: iso(o.starts_at)!,
      ends_at: iso(o.ends_at)!,
      offered_at: iso(o.offered_at)!,
      expires_at: iso(o.expires_at)!,
      responded_at: iso(o.responded_at),
      response_channel: o.response_channel ?? null,
    })),
  };
}

interface EntryLock {
  id: string;
  status: WaitlistEntryView["status"];
  version: number;
  patient_id: string;
  latest_date: string;
}
async function lockEntry(
  c: DbClient,
  s: Scope,
  id: string,
): Promise<EntryLock> {
  const r = await c.query<EntryLock>(
    `SELECT id, status, version, patient_id, latest_date::text AS latest_date FROM scheduling.waitlist_entries
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 FOR UPDATE`,
    [s.tenantId, s.practiceId, id],
  );
  if (!r.rows[0]) throw new SchedulingError("WAITLIST_ENTRY_NOT_FOUND");
  return r.rows[0];
}

interface OfferRow {
  id: string;
  status: WaitlistOfferView["status"];
  waitlist_entry_id: string;
  appointment_id: string;
  practitioner_id: string;
  location_id: string;
  starts_at: Date;
  expires_at: Date;
  patient_id: string;
  referral_id: string | null;
  hold_id: string | null;
}
async function readOffer(
  c: DbClient,
  s: Scope,
  offerId: string,
  lock: boolean,
): Promise<OfferRow | undefined> {
  const r = await c.query<OfferRow>(
    `SELECT o.id, o.status, o.waitlist_entry_id, o.appointment_id, o.practitioner_id, o.location_id, o.starts_at,
            o.expires_at, e.patient_id, e.referral_id,
            (SELECT h.id FROM scheduling.slot_holds h
              WHERE h.tenant_id=o.tenant_id AND h.practice_id=o.practice_id AND h.appointment_id=o.appointment_id) AS hold_id
       FROM scheduling.waitlist_offers o
       JOIN scheduling.waitlist_entries e ON e.tenant_id=o.tenant_id AND e.practice_id=o.practice_id AND e.id=o.waitlist_entry_id
      WHERE o.tenant_id=$1 AND o.practice_id=$2 AND o.id=$3 ${lock ? "FOR UPDATE OF o" : ""}`,
    [s.tenantId, s.practiceId, offerId],
  );
  return r.rows[0];
}

/** A patient may only answer their own offers; anyone else sees none. */
function assertAnswerable(ctx: CommandContext, offer: OfferRow | undefined) {
  if (
    !offer ||
    (ctx.actor.type === "PATIENT" &&
      ctx.actor.id !== `patient:${offer.patient_id}`)
  )
    throw new SchedulingError("WAITLIST_OFFER_NOT_FOUND");
  return offer;
}
function assertPending(offer: OfferRow, now: Date) {
  if (offer.status === "EXPIRED" || +offer.expires_at <= +now)
    throw new SchedulingError("WAITLIST_OFFER_EXPIRED");
  if (offer.status !== "PENDING")
    throw new SchedulingError("WAITLIST_OFFER_NOT_PENDING", undefined, {
      status: offer.status,
    });
}

/** Where the entry goes when its offer ends without a booking. */
async function reopenEntry(c: DbClient, ctx: CommandContext, e: EntryLock) {
  const expired = e.latest_date < (await practiceToday(c, ctx));
  await c.query(
    `UPDATE scheduling.waitlist_entries
        SET status=$4, closed_at=CASE WHEN $4='EXPIRED' THEN now() END,
            closed_by=CASE WHEN $4='EXPIRED' THEN 'system:waitlist' END, version=version+1, updated_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='OFFERED'`,
    [ctx.tenantId, ctx.practiceId, e.id, expired ? "EXPIRED" : "ACTIVE"],
  );
}

/**
 * Accept an offer: its held slot becomes the patient's confirmed
 * appointment (through confirmHold, which re-checks every booking rule) and
 * the entry closes as BOOKED.
 */
export async function acceptWaitlistOffer(
  c: DbClient,
  ctx: CommandContext,
  offerId: string,
): Promise<string> {
  const peek = assertAnswerable(ctx, await readOffer(c, ctx, offerId, false));
  await lockPractitioners(c, ctx, [peek.practitioner_id]);
  if (peek.referral_id)
    await lockReferral(c, ctx, peek.referral_id, [peek.appointment_id]);
  await lockEntry(c, ctx, peek.waitlist_entry_id);
  const offer = assertAnswerable(ctx, await readOffer(c, ctx, offerId, true));
  assertPending(offer, await databaseNow(c));
  if (!offer.hold_id) throw new SchedulingError("WAITLIST_OFFER_NOT_FOUND");
  const appointmentId = await confirmHold(
    c,
    ctx,
    offer.hold_id,
    {},
    { internal: true },
  );
  await audit(c, ctx, {
    action: "waitlist.offer_accepted",
    resourceType: "waitlist_offer",
    resourceId: offer.id,
    after: {
      status: "ACCEPTED",
      appointment_id: appointmentId,
      waitlist_entry_id: offer.waitlist_entry_id,
    },
  });
  return appointmentId;
}

/**
 * Decline an offer: the slot is released and passed on to the next patient;
 * the patient stays on the waitlist for other times.
 */
export async function declineWaitlistOffer(
  c: DbClient,
  ctx: CommandContext,
  offerId: string,
): Promise<void> {
  const peek = assertAnswerable(ctx, await readOffer(c, ctx, offerId, false));
  const entry = await lockEntry(c, ctx, peek.waitlist_entry_id);
  const offer = assertAnswerable(ctx, await readOffer(c, ctx, offerId, true));
  assertPending(offer, await databaseNow(c));
  if (offer.hold_id)
    await releaseHold(c, ctx, offer.hold_id, {
      internal: true,
      reason: "OFFER_DECLINED",
    });
  await c.query(
    `UPDATE scheduling.waitlist_offers
        SET status='DECLINED', responded_at=now(), response_channel=$4, version=version+1, updated_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [
      ctx.tenantId,
      ctx.practiceId,
      offer.id,
      ctx.actor.type === "SYSTEM" ? "SYSTEM" : ctx.channel,
    ],
  );
  await reopenEntry(c, ctx, entry);
  await emit(
    c,
    ctx,
    "WAITLIST_OFFER_DECLINED",
    { type: "practitioner", id: offer.practitioner_id },
    slotPayload(offer),
  );
  await audit(c, ctx, {
    action: "waitlist.offer_declined",
    resourceType: "waitlist_offer",
    resourceId: offer.id,
    after: { status: "DECLINED", waitlist_entry_id: offer.waitlist_entry_id },
  });
}

function slotPayload(o: {
  id: string;
  waitlist_entry_id: string;
  practitioner_id: string;
  location_id: string;
  starts_at: Date;
  patient_id: string;
}) {
  return {
    offer_id: o.id,
    waitlist_entry_id: o.waitlist_entry_id,
    practitioner_id: o.practitioner_id,
    location_id: o.location_id,
    starts_at: o.starts_at.toISOString(),
    patient_id: o.patient_id,
  };
}

/**
 * The hold behind an offer ended without a booking: it lapsed (EXPIRED,
 * and the slot passes to the next patient) or staff released it
 * (WITHDRAWN). Idempotent: an offer already answered is left alone.
 */
export async function closeOfferForHold(
  c: DbClient,
  ctx: CommandContext,
  holdId: string,
  outcome: "EXPIRED" | "WITHDRAWN",
): Promise<boolean> {
  const peek = await c.query<{ id: string }>(
    `SELECT o.id FROM scheduling.waitlist_offers o
       JOIN scheduling.slot_holds h ON h.tenant_id=o.tenant_id AND h.practice_id=o.practice_id
                                    AND h.appointment_id=o.appointment_id
      WHERE h.tenant_id=$1 AND h.practice_id=$2 AND h.id=$3`,
    [ctx.tenantId, ctx.practiceId, holdId],
  );
  const id = peek.rows[0]?.id;
  if (!id) return false;
  const first = await readOffer(c, ctx, id, false);
  if (!first || first.status !== "PENDING") return false;
  const entry = await lockEntry(c, ctx, first.waitlist_entry_id);
  const offer = (await readOffer(c, ctx, id, true))!;
  if (offer.status !== "PENDING") return false;
  await c.query(
    `UPDATE scheduling.waitlist_offers SET status=$4, version=version+1, updated_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, offer.id, outcome],
  );
  await reopenEntry(c, ctx, entry);
  if (outcome === "EXPIRED")
    await emit(
      c,
      ctx,
      "WAITLIST_OFFER_EXPIRED",
      { type: "practitioner", id: offer.practitioner_id },
      slotPayload(offer),
    );
  await audit(c, ctx, {
    action:
      outcome === "EXPIRED"
        ? "waitlist.offer_expired"
        : "waitlist.offer_withdrawn",
    resourceType: "waitlist_offer",
    resourceId: offer.id,
    after: { status: outcome, waitlist_entry_id: offer.waitlist_entry_id },
  });
  return true;
}

/**
 * Take a patient off the waitlist. A pending offer is withdrawn and its slot
 * passed on to the next patient.
 */
export async function cancelWaitlistEntry(
  c: DbClient,
  ctx: CommandContext,
  entryId: string,
  input: { expectedVersion?: number | undefined },
): Promise<void> {
  const entry = await lockEntry(c, ctx, entryId);
  if (
    input.expectedVersion !== undefined &&
    entry.version !== input.expectedVersion
  )
    throw new SchedulingError("WAITLIST_ENTRY_CHANGED");
  if (entry.status !== "ACTIVE" && entry.status !== "OFFERED")
    throw new SchedulingError("WAITLIST_ENTRY_CLOSED");
  const pending = await c.query<{ id: string }>(
    `SELECT id FROM scheduling.waitlist_offers
      WHERE tenant_id=$1 AND practice_id=$2 AND waitlist_entry_id=$3 AND status='PENDING' ORDER BY id FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId, entryId],
  );
  for (const { id } of pending.rows) {
    const offer = (await readOffer(c, ctx, id, false))!;
    if (offer.hold_id) {
      const hold = await c.query<{ status: string }>(
        "SELECT status FROM scheduling.slot_holds WHERE tenant_id=$1 AND practice_id=$2 AND id=$3",
        [ctx.tenantId, ctx.practiceId, offer.hold_id],
      );
      if (hold.rows[0]?.status === "ACTIVE")
        await releaseHold(c, ctx, offer.hold_id, { internal: true });
    }
    await c.query(
      `UPDATE scheduling.waitlist_offers SET status='WITHDRAWN', version=version+1, updated_at=now()
        WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
      [ctx.tenantId, ctx.practiceId, id],
    );
    if (+offer.starts_at > +(await databaseNow(c)))
      await emit(
        c,
        ctx,
        "WAITLIST_SLOT_AVAILABLE",
        { type: "practitioner", id: offer.practitioner_id },
        slotPayload(offer),
      );
  }
  await c.query(
    `UPDATE scheduling.waitlist_entries
        SET status='CANCELLED', closed_at=now(), closed_by=$4, version=version+1, updated_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, entryId, ctx.actor.id],
  );
  await audit(c, ctx, {
    action: "waitlist.entry_cancelled",
    resourceType: "waitlist_entry",
    resourceId: entryId,
    before: { status: entry.status },
    after: { status: "CANCELLED" },
  });
}

// ---------------------------------------------------------------------------
// Offering freed slots (worker)
// ---------------------------------------------------------------------------

export interface FreedSlot {
  practitionerId: string;
  locationId: string;
  start: Date;
  /** Not offered back to the patient whose booking freed it. */
  excludePatientId?: string | null | undefined;
}
export interface WaitlistCandidate {
  entryId: string;
  patientId: string;
  appointmentTypeId: string;
}

/**
 * Open entries that could take a freed slot, in queue order: the
 * practitioner offers the type at that location, the slot falls in the
 * patient's dates, days and hours, and they have not been offered this slot
 * before. Whether the slot really fits the type (duration, working hours,
 * other bookings) is decided by the hold itself.
 */
export async function waitlistCandidates(
  c: DbClient,
  s: Scope,
  slot: FreedSlot,
  limit = 20,
): Promise<WaitlistCandidate[]> {
  const r = await c.query<{
    id: string;
    patient_id: string;
    appointment_type_id: string;
  }>(
    `WITH slot AS (
       SELECT ($3::timestamptz AT TIME ZONE l.timezone) AS local
         FROM directory.practice_locations l WHERE l.tenant_id=$1 AND l.practice_id=$2 AND l.id=$5
     )
     SELECT e.id, e.patient_id, e.appointment_type_id
       FROM scheduling.waitlist_entries e CROSS JOIN slot
      WHERE e.tenant_id=$1 AND e.practice_id=$2 AND e.status='ACTIVE'
        AND (e.practitioner_id IS NULL OR e.practitioner_id=$4)
        AND (e.location_id IS NULL OR e.location_id=$5)
        AND slot.local::date BETWEEN e.earliest_date AND e.latest_date
        AND (cardinality(e.preferred_weekdays)=0
             OR extract(isodow FROM slot.local)::smallint = ANY(e.preferred_weekdays))
        AND (e.preferred_start_minute IS NULL
             OR extract(hour FROM slot.local)*60 + extract(minute FROM slot.local) >= e.preferred_start_minute)
        AND (e.preferred_end_minute IS NULL
             OR extract(hour FROM slot.local)*60 + extract(minute FROM slot.local) < e.preferred_end_minute)
        AND ($6::uuid IS NULL OR e.patient_id <> $6)
        AND EXISTS (SELECT 1 FROM scheduling.appointment_type_practitioners tp
                     WHERE tp.tenant_id=e.tenant_id AND tp.practice_id=e.practice_id
                       AND tp.appointment_type_id=e.appointment_type_id AND tp.practitioner_id=$4 AND tp.active)
        AND EXISTS (SELECT 1 FROM scheduling.appointment_type_locations tl
                     WHERE tl.tenant_id=e.tenant_id AND tl.practice_id=e.practice_id
                       AND tl.appointment_type_id=e.appointment_type_id AND tl.location_id=$5 AND tl.active)
        AND NOT EXISTS (SELECT 1 FROM scheduling.waitlist_offers o
                         WHERE o.tenant_id=e.tenant_id AND o.practice_id=e.practice_id AND o.waitlist_entry_id=e.id
                           AND o.practitioner_id=$4 AND o.starts_at=$3)
      ORDER BY e.priority DESC, e.created_at, e.id
      LIMIT $7`,
    [
      s.tenantId,
      s.practiceId,
      slot.start,
      slot.practitionerId,
      slot.locationId,
      slot.excludePatientId ?? null,
      limit,
    ],
  );
  return r.rows.map((e) => ({
    entryId: e.id,
    patientId: e.patient_id,
    appointmentTypeId: e.appointment_type_id,
  }));
}

export interface CreatedOffer {
  offerId: string;
  holdId: string;
  appointmentId: string;
  patientId: string;
  expiresAt: Date;
}
/**
 * Offer a slot to one waitlisted patient: reserve it as a WAITLIST_OFFER
 * hold (every booking rule applies: eligibility, referral, availability,
 * conflicts) for the practice's offer time and record the offer. Throws a
 * SchedulingError when this patient cannot take the slot.
 */
export async function createWaitlistOffer(
  c: DbClient,
  ctx: CommandContext,
  input: {
    entryId: string;
    practitionerId: string;
    locationId: string;
    start: Date;
    sourceEventId?: string | null | undefined;
  },
): Promise<CreatedOffer> {
  const peek = await c.query<{
    patient_id: string;
    appointment_type_id: string;
    referral_id: string | null;
    status: string;
  }>(
    `SELECT patient_id, appointment_type_id, referral_id, status FROM scheduling.waitlist_entries
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, input.entryId],
  );
  const entry = peek.rows[0];
  if (!entry) throw new SchedulingError("WAITLIST_ENTRY_NOT_FOUND");
  if (entry.status !== "ACTIVE")
    throw new SchedulingError("WAITLIST_ENTRY_CLOSED");
  const practice = await loadPractice(c, ctx);
  const ttlMs = practice.waitlistOfferTtlMinutes * MINUTE_MS;
  if (+input.start - +(await databaseNow(c)) < ttlMs + OFFER_ANSWER_MARGIN_MS)
    throw new SchedulingError("WAITLIST_SLOT_TOO_SOON");
  const offerId = randomUUID();
  const hold = await createHold(
    c,
    { ...ctx, sessionRef: `waitlist_offer:${offerId}` },
    {
      patientId: entry.patient_id,
      appointmentTypeId: entry.appointment_type_id,
      practitionerId: input.practitionerId,
      locationId: input.locationId,
      start: input.start,
      referralId: entry.referral_id,
      purpose: "WAITLIST_OFFER",
      waitlistEntryId: input.entryId,
      ttlSeconds: practice.waitlistOfferTtlMinutes * 60,
    },
  );
  // createHold locked the entry (after the practitioner and referral); it
  // must still be waiting.
  const locked = await lockEntry(c, ctx, input.entryId);
  if (locked.status !== "ACTIVE")
    throw new SchedulingError("WAITLIST_ENTRY_CLOSED");
  await c.query(
    `INSERT INTO scheduling.waitlist_offers(tenant_id,practice_id,id,waitlist_entry_id,appointment_id,practitioner_id,
        location_id,starts_at,ends_at,status,expires_at,source_event_id)
     SELECT a.tenant_id, a.practice_id, $3, $4, a.id, a.practitioner_id, a.location_id, a.starts_at, a.ends_at,
            'PENDING', $6, $7
       FROM scheduling.appointments a WHERE a.tenant_id=$1 AND a.practice_id=$2 AND a.id=$5`,
    [
      ctx.tenantId,
      ctx.practiceId,
      offerId,
      input.entryId,
      hold.appointmentId,
      hold.expiresAt,
      input.sourceEventId ?? null,
    ],
  );
  await c.query(
    `UPDATE scheduling.waitlist_entries SET status='OFFERED', version=version+1, updated_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, input.entryId],
  );
  await audit(c, ctx, {
    action: "waitlist.offer_created",
    resourceType: "waitlist_offer",
    resourceId: offerId,
    after: {
      waitlist_entry_id: input.entryId,
      appointment_id: hold.appointmentId,
      practitioner_id: input.practitionerId,
      starts_at: input.start.toISOString(),
      expires_at: hold.expiresAt.toISOString(),
    },
  });
  return {
    offerId,
    holdId: hold.holdId,
    appointmentId: hold.appointmentId,
    patientId: entry.patient_id,
    expiresAt: hold.expiresAt,
  };
}

/**
 * Staff tell the waitlist that a time is free (e.g. after removing a
 * block): the worker offers it like a cancelled appointment's slot.
 */
export async function announceFreedSlot(
  c: DbClient,
  ctx: CommandContext,
  slot: { practitionerId: string; locationId: string; start: Date },
): Promise<void> {
  await lockPractitioners(c, ctx, [slot.practitionerId]);
  await loadLocation(c, ctx, slot.locationId);
  if (+slot.start <= +(await databaseNow(c)))
    throw new SchedulingError("WAITLIST_SLOT_TOO_SOON");
  await emit(
    c,
    ctx,
    "WAITLIST_SLOT_AVAILABLE",
    { type: "practitioner", id: slot.practitionerId },
    {
      practitioner_id: slot.practitionerId,
      location_id: slot.locationId,
      starts_at: slot.start.toISOString(),
    },
  );
  await audit(c, ctx, {
    action: "waitlist.slot_announced",
    resourceType: "practitioner",
    resourceId: slot.practitionerId,
    after: {
      location_id: slot.locationId,
      starts_at: slot.start.toISOString(),
    },
  });
}

/** Entries whose last acceptable date has passed (worker sweep). */
export async function expireWaitlistEntries(
  c: DbClient,
  ctx: CommandContext,
): Promise<number> {
  const r = await c.query(
    `UPDATE scheduling.waitlist_entries e
        SET status='EXPIRED', closed_at=now(), closed_by='system:waitlist', version=e.version+1, updated_at=now()
       FROM directory.practices p
      WHERE e.tenant_id=$1 AND e.practice_id=$2 AND p.tenant_id=e.tenant_id AND p.id=e.practice_id
        AND e.status='ACTIVE' AND e.latest_date < (now() AT TIME ZONE p.timezone)::date`,
    [ctx.tenantId, ctx.practiceId],
  );
  return r.rowCount ?? 0;
}
