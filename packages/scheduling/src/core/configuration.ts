import { randomUUID } from "node:crypto";
import type { DbClient } from "@access/db";
import { SchedulingError } from "../domain/errors.js";
import { isValidTimezone } from "../domain/time.js";
import type { CommandContext } from "./context.js";
import { audit } from "./effects.js";
import { lockPractitioners, type Scope } from "./repository.js";

/**
 * Practice scheduling configuration. Changes that alter availability
 * (working hours, exceptions, blocks) take the practitioner lock, so they
 * serialise with bookings and can never race one. Every change is audited
 * with its before/after values.
 */

// ---------------------------------------------------------------------------
// Practice settings and locations.
// ---------------------------------------------------------------------------

export interface PracticeSettingsPatch {
  name?: string | undefined;
  timezone?: string | undefined;
  contactPhone?: string | null | undefined;
  contactEmail?: string | null | undefined;
  holdTtlSeconds?: number | undefined;
  defaultSlotIntervalMinutes?: number | undefined;
  reminder24hEnabled?: boolean | undefined;
  nearTermReminderMinutes?: number | null | undefined;
  waitlistOfferTtlMinutes?: number | undefined;
  referralVerificationRequired?: boolean | undefined;
  patientChangeCutoffMinutes?: number | undefined;
}
const PRACTICE_COLUMNS: Record<keyof PracticeSettingsPatch, string> = {
  name: "name",
  timezone: "timezone",
  contactPhone: "contact_phone",
  contactEmail: "contact_email",
  holdTtlSeconds: "hold_ttl_seconds",
  defaultSlotIntervalMinutes: "default_slot_interval_minutes",
  reminder24hEnabled: "reminder_24h_enabled",
  nearTermReminderMinutes: "near_term_reminder_minutes",
  waitlistOfferTtlMinutes: "waitlist_offer_ttl_minutes",
  referralVerificationRequired: "referral_verification_required",
  patientChangeCutoffMinutes: "patient_change_cutoff_minutes",
};
const PRACTICE_SELECT = `id,name,timezone,status,contact_phone,contact_email,hold_ttl_seconds,default_slot_interval_minutes,
  reminder_24h_enabled,near_term_reminder_minutes,waitlist_offer_ttl_minutes,referral_verification_required,
  patient_change_cutoff_minutes,version,updated_at`;

export async function getPracticeSettings(c: DbClient, s: Scope) {
  const row = await c.query(
    `SELECT ${PRACTICE_SELECT} FROM directory.practices WHERE tenant_id=$1 AND id=$2`,
    [s.tenantId, s.practiceId],
  );
  if (!row.rows[0]) throw new SchedulingError("PRACTICE_NOT_FOUND");
  return row.rows[0];
}

/** Build "col=$n" assignments for the defined keys of a patch. */
function assignments<P extends object>(
  patch: P,
  columns: { readonly [K in keyof P]?: string },
  firstParam: number,
): { sql: string; values: unknown[]; changed: string[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(columns) as (keyof P)[]) {
    const column = columns[key];
    const value = patch[key];
    if (!column || value === undefined) continue;
    parts.push(`${column}=$${firstParam + values.length}`);
    values.push(value);
    changed.push(column);
  }
  return { sql: parts.join(","), values, changed };
}

export async function updatePracticeSettings(
  c: DbClient,
  ctx: CommandContext,
  patch: PracticeSettingsPatch,
  expectedVersion?: number,
) {
  if (patch.timezone !== undefined && !isValidTimezone(patch.timezone))
    throw new SchedulingError("INVALID_TIMEZONE");
  const before = await c.query(
    `SELECT ${PRACTICE_SELECT} FROM directory.practices WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId],
  );
  const prior = before.rows[0];
  if (!prior) throw new SchedulingError("PRACTICE_NOT_FOUND");
  if (expectedVersion !== undefined && prior.version !== expectedVersion)
    throw new SchedulingError("VERSION_CONFLICT");
  const set = assignments(patch, PRACTICE_COLUMNS, 3);
  if (!set.sql) return prior;
  const after = await c.query(
    `UPDATE directory.practices SET ${set.sql}, version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING ${PRACTICE_SELECT}`,
    [ctx.tenantId, ctx.practiceId, ...set.values],
  );
  await audit(c, ctx, {
    action: "practice.settings_updated",
    resourceType: "practice",
    resourceId: ctx.practiceId,
    before: pick(prior, set.changed),
    after: pick(after.rows[0], set.changed),
  });
  return after.rows[0];
}

function pick(row: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
}

export interface LocationInput {
  name: string;
  timezone: string;
  addressLine1?: string | null | undefined;
  addressLine2?: string | null | undefined;
  city?: string | null | undefined;
  postalCode?: string | null | undefined;
  phone?: string | null | undefined;
  active?: boolean | undefined;
}
const LOCATION_COLUMNS: Record<keyof LocationInput, string> = {
  name: "name",
  timezone: "timezone",
  addressLine1: "address_line1",
  addressLine2: "address_line2",
  city: "city",
  postalCode: "postal_code",
  phone: "phone",
  active: "active",
};
const LOCATION_SELECT =
  "id,name,timezone,address_line1,address_line2,city,postal_code,phone,active,version,updated_at";

export async function listLocations(c: DbClient, s: Scope) {
  return (
    await c.query(
      `SELECT ${LOCATION_SELECT} FROM directory.practice_locations WHERE tenant_id=$1 AND practice_id=$2 ORDER BY name`,
      [s.tenantId, s.practiceId],
    )
  ).rows;
}

export async function createLocation(
  c: DbClient,
  ctx: CommandContext,
  input: LocationInput,
) {
  if (!isValidTimezone(input.timezone))
    throw new SchedulingError("INVALID_TIMEZONE");
  const id = randomUUID();
  const row = await c.query(
    `INSERT INTO directory.practice_locations(tenant_id,practice_id,id,name,timezone,address_line1,address_line2,city,postal_code,phone,active)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${LOCATION_SELECT}`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      input.name,
      input.timezone,
      input.addressLine1 ?? null,
      input.addressLine2 ?? null,
      input.city ?? null,
      input.postalCode ?? null,
      input.phone ?? null,
      input.active ?? true,
    ],
  );
  await audit(c, ctx, {
    action: "location.created",
    resourceType: "location",
    resourceId: id,
    after: row.rows[0],
  });
  return row.rows[0];
}

export async function updateLocation(
  c: DbClient,
  ctx: CommandContext,
  id: string,
  patch: Partial<LocationInput>,
  expectedVersion?: number,
) {
  if (patch.timezone !== undefined && !isValidTimezone(patch.timezone))
    throw new SchedulingError("INVALID_TIMEZONE");
  const before = await c.query(
    `SELECT ${LOCATION_SELECT} FROM directory.practice_locations WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId, id],
  );
  const prior = before.rows[0];
  if (!prior) throw new SchedulingError("LOCATION_NOT_FOUND");
  if (expectedVersion !== undefined && prior.version !== expectedVersion)
    throw new SchedulingError("VERSION_CONFLICT");
  const set = assignments(patch, LOCATION_COLUMNS, 4);
  if (!set.sql) return prior;
  const after = await c.query(
    `UPDATE directory.practice_locations SET ${set.sql}, version=version+1
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 RETURNING ${LOCATION_SELECT}`,
    [ctx.tenantId, ctx.practiceId, id, ...set.values],
  );
  await audit(c, ctx, {
    action: "location.updated",
    resourceType: "location",
    resourceId: id,
    before: pick(prior, set.changed),
    after: pick(after.rows[0], set.changed),
  });
  return after.rows[0];
}

// ---------------------------------------------------------------------------
// Practitioners.
// ---------------------------------------------------------------------------

export interface PractitionerInput {
  displayName: string;
  title?: string | null | undefined;
  givenName?: string | null | undefined;
  familyName: string;
  profession?: "DOCTOR" | "NURSE" | "ALLIED_HEALTH" | "OTHER" | undefined;
  registrationNumber?: string | null | undefined;
  calendarColor?: string | null | undefined;
  active?: boolean | undefined;
  bookableByPatients?: boolean | undefined;
}
const PRACTITIONER_COLUMNS: Record<keyof PractitionerInput, string> = {
  displayName: "display_name",
  title: "title",
  givenName: "given_name",
  familyName: "family_name",
  profession: "profession",
  registrationNumber: "registration_number",
  calendarColor: "calendar_color",
  active: "active",
  bookableByPatients: "bookable_by_patients",
};
const PRACTITIONER_SELECT = `p.id,p.display_name,p.title,p.given_name,p.family_name,p.profession,p.registration_number,
  p.calendar_color,p.active,p.bookable_by_patients,p.version,p.updated_at,
  ARRAY(SELECT pl.location_id FROM scheduling.practitioner_locations pl
         WHERE pl.tenant_id=p.tenant_id AND pl.practice_id=p.practice_id AND pl.practitioner_id=p.id AND pl.active
         ORDER BY pl.location_id) AS location_ids`;

export async function listPractitioners(
  c: DbClient,
  s: Scope,
  includeInactive = false,
) {
  return (
    await c.query(
      `SELECT ${PRACTITIONER_SELECT} FROM scheduling.practitioners p
        WHERE p.tenant_id=$1 AND p.practice_id=$2 AND ($3 OR p.active) ORDER BY p.display_name, p.id`,
      [s.tenantId, s.practiceId, includeInactive],
    )
  ).rows;
}
async function practitionerView(c: DbClient, s: Scope, id: string) {
  const row = await c.query(
    `SELECT ${PRACTITIONER_SELECT} FROM scheduling.practitioners p WHERE p.tenant_id=$1 AND p.practice_id=$2 AND p.id=$3`,
    [s.tenantId, s.practiceId, id],
  );
  if (!row.rows[0]) throw new SchedulingError("PRACTITIONER_NOT_FOUND");
  return row.rows[0];
}

export async function createPractitioner(
  c: DbClient,
  ctx: CommandContext,
  input: PractitionerInput & { locationIds?: string[] | undefined },
) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO scheduling.practitioners(tenant_id,practice_id,id,display_name,title,given_name,family_name,profession,
        registration_number,calendar_color,active,bookable_by_patients)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      input.displayName,
      input.title ?? null,
      input.givenName ?? null,
      input.familyName,
      input.profession ?? "DOCTOR",
      input.registrationNumber ?? null,
      input.calendarColor ?? null,
      input.active ?? true,
      input.bookableByPatients ?? true,
    ],
  );
  if (input.locationIds?.length)
    await setPractitionerLocations(c, ctx, id, input.locationIds, false);
  const view = await practitionerView(c, ctx, id);
  await audit(c, ctx, {
    action: "practitioner.created",
    resourceType: "practitioner",
    resourceId: id,
    after: view,
  });
  return view;
}

export async function updatePractitioner(
  c: DbClient,
  ctx: CommandContext,
  id: string,
  patch: Partial<PractitionerInput> & { locationIds?: string[] | undefined },
  expectedVersion?: number,
) {
  await lockPractitioners(c, ctx, [id]);
  const prior = await practitionerView(c, ctx, id);
  if (expectedVersion !== undefined && prior.version !== expectedVersion)
    throw new SchedulingError("VERSION_CONFLICT");
  const set = assignments(patch, PRACTITIONER_COLUMNS, 4);
  if (set.sql)
    await c.query(
      `UPDATE scheduling.practitioners SET ${set.sql}, version=version+1 WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
      [ctx.tenantId, ctx.practiceId, id, ...set.values],
    );
  if (patch.locationIds)
    await setPractitionerLocations(c, ctx, id, patch.locationIds, false);
  const view = await practitionerView(c, ctx, id);
  await audit(c, ctx, {
    action: "practitioner.updated",
    resourceType: "practitioner",
    resourceId: id,
    before: pick(prior, [...set.changed, "location_ids"]),
    after: pick(view, [...set.changed, "location_ids"]),
  });
  return view;
}

/** Make exactly `locationIds` the practitioner's active locations. */
async function setPractitionerLocations(
  c: DbClient,
  ctx: CommandContext,
  practitionerId: string,
  locationIds: string[],
  lock: boolean,
) {
  if (lock) await lockPractitioners(c, ctx, [practitionerId]);
  await c.query(
    `INSERT INTO scheduling.practitioner_locations(tenant_id,practice_id,practitioner_id,location_id,active)
     SELECT $1,$2,$3,l,true FROM unnest($4::uuid[]) AS l
     ON CONFLICT (tenant_id,practice_id,practitioner_id,location_id) DO UPDATE SET active=true, updated_at=now()
       WHERE NOT scheduling.practitioner_locations.active`,
    [ctx.tenantId, ctx.practiceId, practitionerId, locationIds],
  );
  await c.query(
    `UPDATE scheduling.practitioner_locations SET active=false, updated_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND practitioner_id=$3 AND active AND NOT (location_id = ANY($4::uuid[]))`,
    [ctx.tenantId, ctx.practiceId, practitionerId, locationIds],
  );
}

// ---------------------------------------------------------------------------
// Appointment types.
// ---------------------------------------------------------------------------

export interface AppointmentTypeInput {
  code: string;
  name: string;
  description?: string | null | undefined;
  durationMinutes: number;
  bufferBeforeMinutes?: number | undefined;
  bufferAfterMinutes?: number | undefined;
  slotIntervalMinutes?: number | null | undefined;
  requiresReferral?: boolean | undefined;
  newPatientAllowed?: boolean | undefined;
  followUpOnly?: boolean | undefined;
  minNoticeMinutes?: number | undefined;
  maxAdvanceDays?: number | undefined;
  patientBookable?: boolean | undefined;
  calendarColor?: string | null | undefined;
  active?: boolean | undefined;
}
const TYPE_COLUMNS: Record<keyof AppointmentTypeInput, string> = {
  code: "code",
  name: "name",
  description: "description",
  durationMinutes: "duration_minutes",
  bufferBeforeMinutes: "buffer_before_minutes",
  bufferAfterMinutes: "buffer_after_minutes",
  slotIntervalMinutes: "slot_interval_minutes",
  requiresReferral: "requires_referral",
  newPatientAllowed: "new_patient_allowed",
  followUpOnly: "follow_up_only",
  minNoticeMinutes: "min_notice_minutes",
  maxAdvanceDays: "max_advance_days",
  patientBookable: "patient_bookable",
  calendarColor: "calendar_color",
  active: "active",
};
const TYPE_SELECT = `t.id,t.code,t.name,t.description,t.duration_minutes,t.buffer_before_minutes,t.buffer_after_minutes,
  t.slot_interval_minutes,t.requires_referral,t.new_patient_allowed,t.follow_up_only,t.min_notice_minutes,t.max_advance_days,
  t.patient_bookable,t.calendar_color,t.active,t.version,t.updated_at,
  ARRAY(SELECT tp.practitioner_id FROM scheduling.appointment_type_practitioners tp
         WHERE tp.tenant_id=t.tenant_id AND tp.practice_id=t.practice_id AND tp.appointment_type_id=t.id AND tp.active
         ORDER BY tp.practitioner_id) AS practitioner_ids,
  ARRAY(SELECT tl.location_id FROM scheduling.appointment_type_locations tl
         WHERE tl.tenant_id=t.tenant_id AND tl.practice_id=t.practice_id AND tl.appointment_type_id=t.id AND tl.active
         ORDER BY tl.location_id) AS location_ids`;

export async function listAppointmentTypes(
  c: DbClient,
  s: Scope,
  includeInactive = false,
) {
  return (
    await c.query(
      `SELECT ${TYPE_SELECT} FROM scheduling.appointment_types t
        WHERE t.tenant_id=$1 AND t.practice_id=$2 AND ($3 OR t.active) ORDER BY t.name, t.id`,
      [s.tenantId, s.practiceId, includeInactive],
    )
  ).rows;
}
async function typeView(c: DbClient, s: Scope, id: string) {
  const row = await c.query(
    `SELECT ${TYPE_SELECT} FROM scheduling.appointment_types t WHERE t.tenant_id=$1 AND t.practice_id=$2 AND t.id=$3`,
    [s.tenantId, s.practiceId, id],
  );
  if (!row.rows[0]) throw new SchedulingError("APPOINTMENT_TYPE_NOT_FOUND");
  return row.rows[0];
}

async function setTypeAllowLists(
  c: DbClient,
  ctx: CommandContext,
  typeId: string,
  lists: {
    practitionerIds?: string[] | undefined;
    locationIds?: string[] | undefined;
  },
) {
  for (const [table, column, ids] of [
    [
      "appointment_type_practitioners",
      "practitioner_id",
      lists.practitionerIds,
    ],
    ["appointment_type_locations", "location_id", lists.locationIds],
  ] as const) {
    if (!ids) continue;
    await c.query(
      `INSERT INTO scheduling.${table}(tenant_id,practice_id,appointment_type_id,${column},active)
       SELECT $1,$2,$3,x,true FROM unnest($4::uuid[]) AS x
       ON CONFLICT (tenant_id,practice_id,appointment_type_id,${column}) DO UPDATE SET active=true, updated_at=now()
         WHERE NOT scheduling.${table}.active`,
      [ctx.tenantId, ctx.practiceId, typeId, ids],
    );
    await c.query(
      `UPDATE scheduling.${table} SET active=false, updated_at=now()
        WHERE tenant_id=$1 AND practice_id=$2 AND appointment_type_id=$3 AND active AND NOT (${column} = ANY($4::uuid[]))`,
      [ctx.tenantId, ctx.practiceId, typeId, ids],
    );
  }
}

export async function createAppointmentType(
  c: DbClient,
  ctx: CommandContext,
  input: AppointmentTypeInput & {
    practitionerIds?: string[] | undefined;
    locationIds?: string[] | undefined;
  },
) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO scheduling.appointment_types(tenant_id,practice_id,id,code,name,description,duration_minutes,buffer_before_minutes,
        buffer_after_minutes,slot_interval_minutes,requires_referral,new_patient_allowed,follow_up_only,min_notice_minutes,
        max_advance_days,patient_bookable,calendar_color,active)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      input.code,
      input.name,
      input.description ?? null,
      input.durationMinutes,
      input.bufferBeforeMinutes ?? 0,
      input.bufferAfterMinutes ?? 0,
      input.slotIntervalMinutes ?? null,
      input.requiresReferral ?? false,
      input.newPatientAllowed ?? !input.followUpOnly,
      input.followUpOnly ?? false,
      input.minNoticeMinutes ?? 60,
      input.maxAdvanceDays ?? 90,
      input.patientBookable ?? true,
      input.calendarColor ?? null,
      input.active ?? true,
    ],
  );
  await setTypeAllowLists(c, ctx, id, input);
  const view = await typeView(c, ctx, id);
  await audit(c, ctx, {
    action: "appointment_type.created",
    resourceType: "appointment_type",
    resourceId: id,
    after: view,
  });
  return view;
}

export async function updateAppointmentType(
  c: DbClient,
  ctx: CommandContext,
  id: string,
  patch: Partial<AppointmentTypeInput> & {
    practitionerIds?: string[] | undefined;
    locationIds?: string[] | undefined;
  },
  expectedVersion?: number,
) {
  const before = await c.query(
    "SELECT id FROM scheduling.appointment_types WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 FOR UPDATE",
    [ctx.tenantId, ctx.practiceId, id],
  );
  if (!before.rowCount) throw new SchedulingError("APPOINTMENT_TYPE_NOT_FOUND");
  const prior = await typeView(c, ctx, id);
  if (expectedVersion !== undefined && prior.version !== expectedVersion)
    throw new SchedulingError("VERSION_CONFLICT");
  const set = assignments(patch, TYPE_COLUMNS, 4);
  if (set.sql)
    await c.query(
      `UPDATE scheduling.appointment_types SET ${set.sql}, version=version+1 WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
      [ctx.tenantId, ctx.practiceId, id, ...set.values],
    );
  await setTypeAllowLists(c, ctx, id, patch);
  const view = await typeView(c, ctx, id);
  const keys = [...set.changed, "practitioner_ids", "location_ids"];
  await audit(c, ctx, {
    action: "appointment_type.updated",
    resourceType: "appointment_type",
    resourceId: id,
    before: pick(prior, keys),
    after: pick(view, keys),
  });
  return view;
}

// ---------------------------------------------------------------------------
// Working hours, exceptions and blocks.
// ---------------------------------------------------------------------------

export async function listAvailabilityRules(
  c: DbClient,
  s: Scope,
  practitionerId?: string,
) {
  return (
    await c.query(
      `SELECT id,practitioner_id,location_id,weekday,start_minute,end_minute,valid_from::text,valid_until::text,created_by,created_at
         FROM scheduling.availability_rules
        WHERE tenant_id=$1 AND practice_id=$2 AND removed_at IS NULL AND ($3::uuid IS NULL OR practitioner_id=$3)
        ORDER BY practitioner_id, weekday, start_minute`,
      [s.tenantId, s.practiceId, practitionerId ?? null],
    )
  ).rows;
}

export interface AvailabilityRuleInput {
  practitionerId: string;
  locationId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  validFrom: string;
  validUntil?: string | null | undefined;
}
export async function createAvailabilityRule(
  c: DbClient,
  ctx: CommandContext,
  input: AvailabilityRuleInput,
) {
  await lockPractitioners(c, ctx, [input.practitionerId]);
  const assigned = await c.query(
    `SELECT 1 FROM scheduling.practitioner_locations
      WHERE tenant_id=$1 AND practice_id=$2 AND practitioner_id=$3 AND location_id=$4 AND active`,
    [ctx.tenantId, ctx.practiceId, input.practitionerId, input.locationId],
  );
  if (!assigned.rowCount)
    throw new SchedulingError("PRACTITIONER_NOT_AT_LOCATION");
  const id = randomUUID();
  const row = await c.query(
    `INSERT INTO scheduling.availability_rules(tenant_id,practice_id,id,practitioner_id,location_id,weekday,start_minute,end_minute,
        valid_from,valid_until,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id,practitioner_id,location_id,weekday,start_minute,end_minute,valid_from::text,valid_until::text`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      input.practitionerId,
      input.locationId,
      input.weekday,
      input.startMinute,
      input.endMinute,
      input.validFrom,
      input.validUntil ?? null,
      ctx.actor.id,
    ],
  );
  await audit(c, ctx, {
    action: "availability_rule.created",
    resourceType: "availability_rule",
    resourceId: id,
    after: row.rows[0],
  });
  return row.rows[0];
}

export async function removeAvailabilityRule(
  c: DbClient,
  ctx: CommandContext,
  id: string,
) {
  const rule = await c.query(
    `SELECT practitioner_id FROM scheduling.availability_rules
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND removed_at IS NULL`,
    [ctx.tenantId, ctx.practiceId, id],
  );
  if (!rule.rows[0]) throw new SchedulingError("CONFIGURATION_NOT_FOUND");
  await lockPractitioners(c, ctx, [rule.rows[0].practitioner_id]);
  const removed = await c.query(
    `UPDATE scheduling.availability_rules SET removed_at=now(), removed_by=$4
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND removed_at IS NULL
      RETURNING id,practitioner_id,location_id,weekday,start_minute,end_minute,valid_from::text,valid_until::text`,
    [ctx.tenantId, ctx.practiceId, id, ctx.actor.id],
  );
  await audit(c, ctx, {
    action: "availability_rule.removed",
    resourceType: "availability_rule",
    resourceId: id,
    before: removed.rows[0],
  });
}

/** Booked (or live-held) appointments of a practitioner overlapping a period. */
async function conflictingAppointments(
  c: DbClient,
  s: Scope,
  practitionerId: string,
  locationId: string | null,
  start: Date,
  end: Date,
) {
  return (
    await c.query(
      `SELECT id, status, starts_at, ends_at FROM scheduling.appointments
        WHERE tenant_id=$1 AND practice_id=$2 AND practitioner_id=$3
          AND ($4::uuid IS NULL OR location_id=$4)
          AND status IN ('HELD','CONFIRMED','CHECKED_IN','IN_PROGRESS')
          AND (status <> 'HELD' OR hold_expires_at > now())
          AND tstzrange(starts_at, ends_at, '[)') && tstzrange($5,$6,'[)')
        ORDER BY starts_at`,
      [s.tenantId, s.practiceId, practitionerId, locationId, start, end],
    )
  ).rows.map((r) => ({
    appointment_id: r.id,
    status: r.status,
    starts_at: r.starts_at.toISOString(),
    ends_at: r.ends_at.toISOString(),
  }));
}

export interface PeriodInput {
  practitionerId: string;
  locationId?: string | null | undefined;
  start: Date;
  end: Date;
  note?: string | null | undefined;
  /** Create even though booked appointments overlap (they stay booked). */
  acknowledgeConflicts?: boolean | undefined;
}

export async function createScheduleBlock(
  c: DbClient,
  ctx: CommandContext,
  input: PeriodInput & {
    reasonCode:
      "ADMIN" | "MEETING" | "BREAK" | "PERSONAL" | "EMERGENCY" | "OTHER";
  },
) {
  if (!(input.end > input.start)) throw new SchedulingError("INVALID_PERIOD");
  await lockPractitioners(c, ctx, [input.practitionerId]);
  const conflicts = await conflictingAppointments(
    c,
    ctx,
    input.practitionerId,
    input.locationId ?? null,
    input.start,
    input.end,
  );
  if (conflicts.length && !input.acknowledgeConflicts)
    throw new SchedulingError("SCHEDULE_BLOCK_CONFLICT", undefined, {
      conflicts,
    });
  const id = randomUUID();
  const row = await c.query(
    `INSERT INTO scheduling.schedule_blocks(tenant_id,practice_id,id,practitioner_id,location_id,reason_code,starts_at,ends_at,note,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id,practitioner_id,location_id,reason_code,starts_at,ends_at,note,created_by,created_at`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      input.practitionerId,
      input.locationId ?? null,
      input.reasonCode,
      input.start,
      input.end,
      input.note ?? null,
      ctx.actor.id,
    ],
  );
  await audit(c, ctx, {
    action: "schedule_block.created",
    resourceType: "schedule_block",
    resourceId: id,
    after: { ...row.rows[0], conflicts_acknowledged: conflicts.length },
  });
  return { ...row.rows[0], conflicts };
}

export async function removeScheduleBlock(
  c: DbClient,
  ctx: CommandContext,
  id: string,
  reason?: string | null,
) {
  const block = await c.query(
    `SELECT practitioner_id FROM scheduling.schedule_blocks WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND removed_at IS NULL`,
    [ctx.tenantId, ctx.practiceId, id],
  );
  if (!block.rows[0]) throw new SchedulingError("CONFIGURATION_NOT_FOUND");
  await lockPractitioners(c, ctx, [block.rows[0].practitioner_id]);
  const removed = await c.query(
    `UPDATE scheduling.schedule_blocks SET removed_at=now(), removed_by=$4, removal_reason=$5
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND removed_at IS NULL
      RETURNING id,practitioner_id,location_id,reason_code,starts_at,ends_at`,
    [ctx.tenantId, ctx.practiceId, id, ctx.actor.id, reason ?? null],
  );
  await audit(c, ctx, {
    action: "schedule_block.removed",
    resourceType: "schedule_block",
    resourceId: id,
    before: removed.rows[0],
    reason: reason ?? null,
  });
}

export async function createAvailabilityException(
  c: DbClient,
  ctx: CommandContext,
  input: PeriodInput & {
    kind: "UNAVAILABLE" | "AVAILABLE";
    reasonCode:
      | "LEAVE"
      | "SICK_LEAVE"
      | "TRAINING"
      | "PUBLIC_HOLIDAY"
      | "PRACTICE_CLOSED"
      | "EXTRA_SESSION"
      | "OTHER";
  },
) {
  if (!(input.end > input.start)) throw new SchedulingError("INVALID_PERIOD");
  await lockPractitioners(c, ctx, [input.practitionerId]);
  const conflicts =
    input.kind === "UNAVAILABLE"
      ? await conflictingAppointments(
          c,
          ctx,
          input.practitionerId,
          input.locationId ?? null,
          input.start,
          input.end,
        )
      : [];
  if (conflicts.length && !input.acknowledgeConflicts)
    throw new SchedulingError("SCHEDULE_BLOCK_CONFLICT", undefined, {
      conflicts,
    });
  const id = randomUUID();
  const row = await c.query(
    `INSERT INTO scheduling.availability_exceptions(tenant_id,practice_id,id,practitioner_id,location_id,kind,reason_code,
        starts_at,ends_at,note,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id,practitioner_id,location_id,kind,reason_code,starts_at,ends_at,note,created_by,created_at`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      input.practitionerId,
      input.locationId ?? null,
      input.kind,
      input.reasonCode,
      input.start,
      input.end,
      input.note ?? null,
      ctx.actor.id,
    ],
  );
  await audit(c, ctx, {
    action: "availability_exception.created",
    resourceType: "availability_exception",
    resourceId: id,
    after: { ...row.rows[0], conflicts_acknowledged: conflicts.length },
  });
  return { ...row.rows[0], conflicts };
}

export async function removeAvailabilityException(
  c: DbClient,
  ctx: CommandContext,
  id: string,
) {
  const exception = await c.query(
    `SELECT practitioner_id FROM scheduling.availability_exceptions
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND removed_at IS NULL`,
    [ctx.tenantId, ctx.practiceId, id],
  );
  if (!exception.rows[0]) throw new SchedulingError("CONFIGURATION_NOT_FOUND");
  await lockPractitioners(c, ctx, [exception.rows[0].practitioner_id]);
  const removed = await c.query(
    `UPDATE scheduling.availability_exceptions SET removed_at=now(), removed_by=$4
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND removed_at IS NULL
      RETURNING id,practitioner_id,location_id,kind,reason_code,starts_at,ends_at`,
    [ctx.tenantId, ctx.practiceId, id, ctx.actor.id],
  );
  await audit(c, ctx, {
    action: "availability_exception.removed",
    resourceType: "availability_exception",
    resourceId: id,
    before: removed.rows[0],
  });
}

export async function listAvailabilityExceptions(
  c: DbClient,
  s: Scope,
  q: { practitionerId?: string | undefined; from: Date; to: Date },
) {
  return (
    await c.query(
      `SELECT id,practitioner_id,location_id,kind,reason_code,starts_at,ends_at,note,created_by,created_at
         FROM scheduling.availability_exceptions
        WHERE tenant_id=$1 AND practice_id=$2 AND removed_at IS NULL AND ($3::uuid IS NULL OR practitioner_id=$3)
          AND period && tstzrange($4,$5,'[)') ORDER BY starts_at`,
      [s.tenantId, s.practiceId, q.practitionerId ?? null, q.from, q.to],
    )
  ).rows;
}
