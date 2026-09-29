import type { DbClient } from "@access/db";
import type {
  AppointmentTiming,
  AvailabilityException,
  DatedPeriod,
  OccupiedPeriod,
  ScheduleContext,
  WeeklyRule,
} from "../domain/availability.js";
import { SchedulingError } from "../domain/errors.js";
import type { AppointmentStatus } from "../domain/state-machine.js";
import { DAY_MS } from "../domain/time.js";

/**
 * Reads the Scheduling Core needs. Every query names tenant and practice
 * explicitly (in addition to RLS) and loads a bounded, indexed range; nothing
 * loads a practice's whole history, and nothing is queried per row.
 */
export interface Scope {
  tenantId: string;
  practiceId: string;
}

export interface PracticeSettings {
  id: string;
  name: string;
  timezone: string;
  status: "ACTIVE" | "SUSPENDED";
  holdTtlSeconds: number;
  defaultSlotIntervalMinutes: number;
  referralVerificationRequired: boolean;
  patientChangeCutoffMinutes: number;
  waitlistOfferTtlMinutes: number;
}
export async function loadPractice(
  c: DbClient,
  s: Scope,
): Promise<PracticeSettings> {
  const row = await c.query(
    `SELECT id,name,timezone,status,hold_ttl_seconds,default_slot_interval_minutes,referral_verification_required,
            patient_change_cutoff_minutes,waitlist_offer_ttl_minutes
       FROM directory.practices WHERE tenant_id=$1 AND id=$2`,
    [s.tenantId, s.practiceId],
  );
  const p = row.rows[0];
  if (!p) throw new SchedulingError("PRACTICE_NOT_FOUND");
  if (p.status !== "ACTIVE") throw new SchedulingError("PRACTICE_SUSPENDED");
  return {
    id: p.id,
    name: p.name,
    timezone: p.timezone,
    status: p.status,
    holdTtlSeconds: p.hold_ttl_seconds,
    defaultSlotIntervalMinutes: p.default_slot_interval_minutes,
    referralVerificationRequired: p.referral_verification_required,
    patientChangeCutoffMinutes: p.patient_change_cutoff_minutes,
    waitlistOfferTtlMinutes: p.waitlist_offer_ttl_minutes,
  };
}

export interface AppointmentTypeRow {
  id: string;
  code: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  slotIntervalMinutes: number | null;
  requiresReferral: boolean;
  newPatientAllowed: boolean;
  followUpOnly: boolean;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  patientBookable: boolean;
  active: boolean;
  practitionerIds: string[];
  locationIds: string[];
}
export async function loadAppointmentType(
  c: DbClient,
  s: Scope,
  id: string,
): Promise<AppointmentTypeRow> {
  const row = await c.query(
    `SELECT t.id,t.code,t.name,t.duration_minutes,t.buffer_before_minutes,t.buffer_after_minutes,t.slot_interval_minutes,
            t.requires_referral,t.new_patient_allowed,t.follow_up_only,t.min_notice_minutes,t.max_advance_days,
            t.patient_bookable,t.active,
            ARRAY(SELECT tp.practitioner_id FROM scheduling.appointment_type_practitioners tp
                   WHERE tp.tenant_id=t.tenant_id AND tp.practice_id=t.practice_id AND tp.appointment_type_id=t.id AND tp.active) AS practitioner_ids,
            ARRAY(SELECT tl.location_id FROM scheduling.appointment_type_locations tl
                   WHERE tl.tenant_id=t.tenant_id AND tl.practice_id=t.practice_id AND tl.appointment_type_id=t.id AND tl.active) AS location_ids
       FROM scheduling.appointment_types t WHERE t.tenant_id=$1 AND t.practice_id=$2 AND t.id=$3`,
    [s.tenantId, s.practiceId, id],
  );
  const t = row.rows[0];
  if (!t) throw new SchedulingError("APPOINTMENT_TYPE_NOT_FOUND");
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    durationMinutes: t.duration_minutes,
    bufferBeforeMinutes: t.buffer_before_minutes,
    bufferAfterMinutes: t.buffer_after_minutes,
    slotIntervalMinutes: t.slot_interval_minutes,
    requiresReferral: t.requires_referral,
    newPatientAllowed: t.new_patient_allowed,
    followUpOnly: t.follow_up_only,
    minNoticeMinutes: t.min_notice_minutes,
    maxAdvanceDays: t.max_advance_days,
    patientBookable: t.patient_bookable,
    active: t.active,
    practitionerIds: t.practitioner_ids,
    locationIds: t.location_ids,
  };
}

export function timingOf(
  type: AppointmentTypeRow,
  practice: PracticeSettings,
): AppointmentTiming {
  return {
    durationMinutes: type.durationMinutes,
    bufferBeforeMinutes: type.bufferBeforeMinutes,
    bufferAfterMinutes: type.bufferAfterMinutes,
    slotIntervalMinutes:
      type.slotIntervalMinutes ?? practice.defaultSlotIntervalMinutes,
    minNoticeMinutes: type.minNoticeMinutes,
    maxAdvanceDays: type.maxAdvanceDays,
  };
}

export interface PractitionerRow {
  id: string;
  displayName: string;
  active: boolean;
  bookableByPatients: boolean;
}
/**
 * Lock practitioners for a schedule-changing command, in id order so that
 * concurrent commands touching several practitioners cannot deadlock. Every
 * booking, hold, reschedule and availability change for a practitioner
 * serialises here; the exclusion constraint remains the final guarantee.
 */
export async function lockPractitioners(
  c: DbClient,
  s: Scope,
  ids: readonly string[],
): Promise<Map<string, PractitionerRow>> {
  const unique = [...new Set(ids)].sort();
  const rows = await c.query(
    `SELECT id,display_name,active,bookable_by_patients FROM scheduling.practitioners
      WHERE tenant_id=$1 AND practice_id=$2 AND id = ANY($3::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
    [s.tenantId, s.practiceId, unique],
  );
  const out = new Map<string, PractitionerRow>();
  for (const r of rows.rows)
    out.set(r.id, {
      id: r.id,
      displayName: r.display_name,
      active: r.active,
      bookableByPatients: r.bookable_by_patients,
    });
  for (const id of unique)
    if (!out.has(id)) throw new SchedulingError("PRACTITIONER_NOT_FOUND");
  return out;
}

export interface LocationRow {
  id: string;
  name: string;
  timezone: string;
  active: boolean;
}
export async function loadLocation(
  c: DbClient,
  s: Scope,
  id: string,
): Promise<LocationRow> {
  const row = await c.query(
    `SELECT id,name,timezone,active FROM directory.practice_locations WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [s.tenantId, s.practiceId, id],
  );
  const l = row.rows[0];
  if (!l) throw new SchedulingError("LOCATION_NOT_FOUND");
  return { id: l.id, name: l.name, timezone: l.timezone, active: l.active };
}

export interface EligiblePair {
  practitionerId: string;
  locationId: string;
  timezone: string;
}
/**
 * Practitioner/location pairs that can take the appointment type: active
 * practitioner, active location, active assignment, and both on the type's
 * allow-lists (patients additionally only see patient-bookable practitioners).
 */
export async function loadEligiblePairs(
  c: DbClient,
  s: Scope,
  type: AppointmentTypeRow,
  filter: {
    practitionerId?: string | undefined;
    locationId?: string | undefined;
    patientChannel: boolean;
  },
): Promise<EligiblePair[]> {
  const rows = await c.query(
    `SELECT pl.practitioner_id, pl.location_id, l.timezone
       FROM scheduling.practitioner_locations pl
       JOIN scheduling.practitioners p ON p.tenant_id=pl.tenant_id AND p.practice_id=pl.practice_id AND p.id=pl.practitioner_id
       JOIN directory.practice_locations l ON l.tenant_id=pl.tenant_id AND l.practice_id=pl.practice_id AND l.id=pl.location_id
      WHERE pl.tenant_id=$1 AND pl.practice_id=$2 AND pl.active AND p.active AND l.active
        AND pl.practitioner_id = ANY($3::uuid[]) AND pl.location_id = ANY($4::uuid[])
        AND ($5::uuid IS NULL OR pl.practitioner_id=$5) AND ($6::uuid IS NULL OR pl.location_id=$6)
        AND (NOT $7 OR p.bookable_by_patients)
      ORDER BY pl.practitioner_id, pl.location_id`,
    [
      s.tenantId,
      s.practiceId,
      type.practitionerIds,
      type.locationIds,
      filter.practitionerId ?? null,
      filter.locationId ?? null,
      filter.patientChannel,
    ],
  );
  return rows.rows.map((r) => ({
    practitionerId: r.practitioner_id,
    locationId: r.location_id,
    timezone: r.timezone,
  }));
}

/**
 * Everything the availability engine needs for some practitioners over a
 * window: rules, exceptions, blocks and occupied time (appointments that
 * consume time plus holds that have not expired: an expired hold never
 * blocks anyone, whether or not the sweep has run).
 */
export async function loadScheduleContext(
  c: DbClient,
  s: Scope,
  pairs: readonly EligiblePair[],
  from: Date,
  to: Date,
): Promise<ScheduleContext> {
  const practitionerIds = [...new Set(pairs.map((p) => p.practitionerId))];
  const locations = new Map<string, { timezone: string }>();
  for (const p of pairs) locations.set(p.locationId, { timezone: p.timezone });
  if (!practitionerIds.length)
    return {
      locations,
      pairs: [],
      rules: [],
      exceptions: [],
      blocks: [],
      occupancy: [],
    };
  const padFrom = new Date(+from - 2 * DAY_MS);
  const padTo = new Date(+to + 2 * DAY_MS);
  const dateFrom = padFrom.toISOString().slice(0, 10);
  const dateTo = padTo.toISOString().slice(0, 10);
  // Sequential: one connection runs one statement at a time.
  const rules = await c.query(
    `SELECT practitioner_id,location_id,weekday,start_minute,end_minute,valid_from::text,valid_until::text
         FROM scheduling.availability_rules
        WHERE tenant_id=$1 AND practice_id=$2 AND practitioner_id = ANY($3::uuid[]) AND removed_at IS NULL
          AND valid_from <= $5::date AND (valid_until IS NULL OR valid_until >= $4::date)`,
    [s.tenantId, s.practiceId, practitionerIds, dateFrom, dateTo],
  );
  const exceptions = await c.query(
    `SELECT practitioner_id,location_id,kind,starts_at,ends_at FROM scheduling.availability_exceptions
        WHERE tenant_id=$1 AND practitioner_id = ANY($3::uuid[]) AND practice_id=$2 AND removed_at IS NULL
          AND period && tstzrange($4,$5,'[)')`,
    [s.tenantId, s.practiceId, practitionerIds, padFrom, padTo],
  );
  const blocks = await c.query(
    `SELECT practitioner_id,location_id,starts_at,ends_at FROM scheduling.schedule_blocks
        WHERE tenant_id=$1 AND practitioner_id = ANY($3::uuid[]) AND practice_id=$2 AND removed_at IS NULL
          AND period && tstzrange($4,$5,'[)')`,
    [s.tenantId, s.practiceId, practitionerIds, padFrom, padTo],
  );
  const occupancy = await c.query(
    `SELECT id,practitioner_id,lower(occupied) AS start,upper(occupied) AS "end"
         FROM scheduling.appointments
        WHERE tenant_id=$1 AND practitioner_id = ANY($3::uuid[]) AND practice_id=$2
          AND status IN ('HELD','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED')
          AND (status <> 'HELD' OR hold_expires_at > now())
          AND occupied && tstzrange($4,$5,'[)')`,
    [s.tenantId, s.practiceId, practitionerIds, padFrom, padTo],
  );
  return {
    locations,
    pairs: pairs.map((p) => ({
      practitionerId: p.practitionerId,
      locationId: p.locationId,
    })),
    rules: rules.rows.map((r): WeeklyRule => ({
      practitionerId: r.practitioner_id,
      locationId: r.location_id,
      weekday: r.weekday,
      startMinute: r.start_minute,
      endMinute: r.end_minute,
      validFrom: r.valid_from,
      validUntil: r.valid_until,
    })),
    exceptions: exceptions.rows.map((e): AvailabilityException => ({
      practitionerId: e.practitioner_id,
      locationId: e.location_id,
      kind: e.kind,
      start: e.starts_at,
      end: e.ends_at,
    })),
    blocks: blocks.rows.map((b): DatedPeriod => ({
      practitionerId: b.practitioner_id,
      locationId: b.location_id,
      start: b.starts_at,
      end: b.ends_at,
    })),
    occupancy: occupancy.rows.map((o): OccupiedPeriod => ({
      practitionerId: o.practitioner_id,
      appointmentId: o.id,
      start: o.start,
      end: o.end,
    })),
  };
}

export interface PatientFacts {
  id: string;
  active: boolean;
  hasCompletedAppointment: boolean;
  hasCompletedWithPractitioner: boolean;
}
export async function loadPatientFacts(
  c: DbClient,
  s: Scope,
  patientId: string,
  practitionerId: string,
): Promise<PatientFacts> {
  const row = await c.query(
    `SELECT p.id, p.status,
            EXISTS (SELECT 1 FROM scheduling.appointments a WHERE a.tenant_id=p.tenant_id AND a.practice_id=p.practice_id
                     AND a.patient_id=p.id AND a.status='COMPLETED') AS completed_any,
            EXISTS (SELECT 1 FROM scheduling.appointments a WHERE a.tenant_id=p.tenant_id AND a.practice_id=p.practice_id
                     AND a.patient_id=p.id AND a.status='COMPLETED' AND a.practitioner_id=$4) AS completed_with
       FROM directory.patients p WHERE p.tenant_id=$1 AND p.practice_id=$2 AND p.id=$3`,
    [s.tenantId, s.practiceId, patientId, practitionerId],
  );
  const p = row.rows[0];
  if (!p) throw new SchedulingError("PATIENT_NOT_FOUND");
  return {
    id: p.id,
    active: p.status === "ACTIVE",
    hasCompletedAppointment: p.completed_any,
    hasCompletedWithPractitioner: p.completed_with,
  };
}

/** True when the patient is already booked (or held) overlapping [start, end). */
export async function patientHasOverlap(
  c: DbClient,
  s: Scope,
  patientId: string,
  start: Date,
  end: Date,
  excludeIds: readonly string[],
): Promise<boolean> {
  const row = await c.query(
    `SELECT 1 FROM scheduling.appointments
      WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3
        AND status IN ('HELD','CONFIRMED','CHECKED_IN','IN_PROGRESS')
        AND (status <> 'HELD' OR hold_expires_at > now())
        AND tstzrange(starts_at, ends_at, '[)') && tstzrange($4,$5,'[)')
        AND NOT (id = ANY($6::uuid[]))
      LIMIT 1`,
    [s.tenantId, s.practiceId, patientId, start, end, [...excludeIds]],
  );
  return (row.rowCount ?? 0) > 0;
}

export interface ReferralRow {
  id: string;
  patientId: string;
  status: "RECEIVED" | "VERIFIED" | "REJECTED" | "CANCELLED";
  appointmentTypeId: string | null;
  validUntil: string | null;
  maxAppointments: number | null;
  appointmentsUsed: number;
}
/** Lock a referral (serialises its visit count) and count its live uses. */
export async function lockReferral(
  c: DbClient,
  s: Scope,
  referralId: string,
  excludeAppointmentIds: readonly string[],
): Promise<ReferralRow> {
  const row = await c.query(
    `SELECT id,patient_id,status,appointment_type_id,valid_until::text,max_appointments
       FROM scheduling.patient_referrals WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 FOR UPDATE`,
    [s.tenantId, s.practiceId, referralId],
  );
  const r = row.rows[0];
  if (!r) throw new SchedulingError("REFERRAL_NOT_FOUND");
  const used = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM scheduling.appointments
      WHERE tenant_id=$1 AND practice_id=$2 AND referral_id=$3
        AND status NOT IN ('CANCELLED','EXPIRED','RESCHEDULED')
        AND (status <> 'HELD' OR hold_expires_at > now())
        AND NOT (id = ANY($4::uuid[]))`,
    [s.tenantId, s.practiceId, referralId, [...excludeAppointmentIds]],
  );
  return {
    id: r.id,
    patientId: r.patient_id,
    status: r.status,
    appointmentTypeId: r.appointment_type_id,
    validUntil: r.valid_until,
    maxAppointments: r.max_appointments,
    appointmentsUsed: used.rows[0]!.n,
  };
}

export interface AppointmentRow {
  id: string;
  status: AppointmentStatus;
  version: number;
  patientId: string;
  practitionerId: string;
  locationId: string;
  appointmentTypeId: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  sourceChannel: string;
  referralId: string | null;
  waitlistEntryId: string | null;
  holdExpiresAt: Date | null;
  rescheduledFromId: string | null;
  rescheduledToId: string | null;
  notes: string | null;
}
export const APPOINTMENT_ROW_COLUMNS = `id,status,version,patient_id,practitioner_id,location_id,appointment_type_id,starts_at,ends_at,
  timezone,duration_minutes,buffer_before_minutes,buffer_after_minutes,source_channel,referral_id,waitlist_entry_id,
  hold_expires_at,rescheduled_from_id,rescheduled_to_id,notes`;
export function appointmentRow(r: Record<string, unknown>): AppointmentRow {
  return {
    id: r.id as string,
    status: r.status as AppointmentStatus,
    version: r.version as number,
    patientId: r.patient_id as string,
    practitionerId: r.practitioner_id as string,
    locationId: r.location_id as string,
    appointmentTypeId: r.appointment_type_id as string,
    startsAt: r.starts_at as Date,
    endsAt: r.ends_at as Date,
    timezone: r.timezone as string,
    durationMinutes: r.duration_minutes as number,
    bufferBeforeMinutes: r.buffer_before_minutes as number,
    bufferAfterMinutes: r.buffer_after_minutes as number,
    sourceChannel: r.source_channel as string,
    referralId: (r.referral_id as string | null) ?? null,
    waitlistEntryId: (r.waitlist_entry_id as string | null) ?? null,
    holdExpiresAt: (r.hold_expires_at as Date | null) ?? null,
    rescheduledFromId: (r.rescheduled_from_id as string | null) ?? null,
    rescheduledToId: (r.rescheduled_to_id as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
  };
}
export async function readAppointment(
  c: DbClient,
  s: Scope,
  id: string,
  lock: boolean,
): Promise<AppointmentRow> {
  const row = await c.query(
    `SELECT ${APPOINTMENT_ROW_COLUMNS} FROM scheduling.appointments
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 ${lock ? "FOR UPDATE" : ""}`,
    [s.tenantId, s.practiceId, id],
  );
  if (!row.rows[0]) throw new SchedulingError("APPOINTMENT_NOT_FOUND");
  return appointmentRow(row.rows[0]);
}

export interface HoldRow {
  id: string;
  appointmentId: string;
  patientId: string;
  practitionerId: string;
  locationId: string;
  appointmentTypeId: string;
  startsAt: Date;
  endsAt: Date;
  expiresAt: Date;
  status: "ACTIVE" | "CONSUMED" | "RELEASED" | "EXPIRED";
  purpose: "BOOKING" | "RESCHEDULE" | "WAITLIST_OFFER";
  rescheduleOfId: string | null;
  ownerChannel: string;
  ownerActorType: "STAFF" | "PATIENT" | "SYSTEM";
  ownerActorId: string;
  ownerSessionRef: string | null;
  createdAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
}
export const HOLD_COLUMNS = `id,appointment_id,patient_id,practitioner_id,location_id,appointment_type_id,starts_at,ends_at,expires_at,
  status,purpose,reschedule_of_id,owner_channel,owner_actor_type,owner_actor_id,owner_session_ref,created_at,closed_at,close_reason`;
export function holdRow(r: Record<string, unknown>): HoldRow {
  return {
    id: r.id as string,
    appointmentId: r.appointment_id as string,
    patientId: r.patient_id as string,
    practitionerId: r.practitioner_id as string,
    locationId: r.location_id as string,
    appointmentTypeId: r.appointment_type_id as string,
    startsAt: r.starts_at as Date,
    endsAt: r.ends_at as Date,
    expiresAt: r.expires_at as Date,
    status: r.status as HoldRow["status"],
    purpose: r.purpose as HoldRow["purpose"],
    rescheduleOfId: (r.reschedule_of_id as string | null) ?? null,
    ownerChannel: r.owner_channel as string,
    ownerActorType: r.owner_actor_type as HoldRow["ownerActorType"],
    ownerActorId: r.owner_actor_id as string,
    ownerSessionRef: (r.owner_session_ref as string | null) ?? null,
    createdAt: r.created_at as Date,
    closedAt: (r.closed_at as Date | null) ?? null,
    closeReason: (r.close_reason as string | null) ?? null,
  };
}
export async function readHold(
  c: DbClient,
  s: Scope,
  id: string,
  lock: boolean,
): Promise<HoldRow> {
  const row = await c.query(
    `SELECT ${HOLD_COLUMNS} FROM scheduling.slot_holds WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 ${lock ? "FOR UPDATE" : ""}`,
    [s.tenantId, s.practiceId, id],
  );
  if (!row.rows[0]) throw new SchedulingError("HOLD_NOT_FOUND");
  return holdRow(row.rows[0]);
}

/** The database clock: one "now" per command, shared with its triggers. */
export async function databaseNow(c: DbClient): Promise<Date> {
  return (await c.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now;
}
