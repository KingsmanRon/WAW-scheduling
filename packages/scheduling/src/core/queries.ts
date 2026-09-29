import type { DbClient } from "@access/db";
import {
  availableWindows,
  findAvailableSlots,
} from "../domain/availability.js";
import { SchedulingError } from "../domain/errors.js";
import type { AppointmentStatus } from "../domain/state-machine.js";
import { DAY_MS } from "../domain/time.js";
import type { CommandContext } from "./context.js";
import {
  databaseNow,
  loadAppointmentType,
  loadEligiblePairs,
  loadPractice,
  loadScheduleContext,
  readHold,
  timingOf,
  type Scope,
} from "./repository.js";

/**
 * Read models for staff and channels. Each list is one joined query over an
 * indexed, bounded range (a calendar never loads more than the visible
 * window); patient details are limited to what scheduling needs.
 */
export interface AppointmentView {
  id: string;
  status: AppointmentStatus;
  version: number;
  starts_at: string;
  ends_at: string;
  timezone: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  patient: {
    id: string;
    display_name: string;
    given_name: string;
    patient_number: string;
  };
  practitioner: { id: string; display_name: string };
  location: { id: string; name: string };
  appointment_type: {
    id: string;
    code: string;
    name: string;
    calendar_color: string | null;
  };
  source_channel: string;
  booked_by: { actor_type: string; actor_id: string; role: string | null };
  referral_id: string | null;
  waitlist_entry_id: string | null;
  hold: {
    id: string;
    status: string;
    expires_at: string;
    purpose: string;
    owner_channel: string;
  } | null;
  rescheduled_from_id: string | null;
  rescheduled_to_id: string | null;
  notes: string | null;
  override_availability: boolean;
  confirmed_at: string | null;
  checked_in_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  no_show_at: string | null;
  cancelled_at: string | null;
  cancellation_reason_code: string | null;
  cancellation_note: string | null;
  rescheduled_at: string | null;
  expired_at: string | null;
  created_at: string;
  updated_at: string;
}

const VIEW_SELECT = `
SELECT a.id,a.status,a.version,a.starts_at,a.ends_at,a.timezone,a.duration_minutes,a.buffer_before_minutes,a.buffer_after_minutes,
       a.patient_id,p.given_name,p.family_name,p.preferred_name,p.patient_number,
       a.practitioner_id,pr.display_name AS practitioner_name,a.location_id,l.name AS location_name,
       a.appointment_type_id,t.code AS type_code,t.name AS type_name,t.calendar_color AS type_color,
       a.source_channel,a.booked_by_actor_type,a.booked_by_actor_id,a.booked_by_role,a.referral_id,a.waitlist_entry_id,
       h.id AS hold_id,h.status AS hold_status,h.expires_at AS hold_expires_at,h.purpose AS hold_purpose,h.owner_channel AS hold_owner_channel,
       a.rescheduled_from_id,a.rescheduled_to_id,a.notes,a.override_availability,a.confirmed_at,a.checked_in_at,a.started_at,
       a.completed_at,a.no_show_at,a.cancelled_at,a.cancellation_reason_code,a.cancellation_note,a.rescheduled_at,a.expired_at,
       a.created_at,a.updated_at
  FROM scheduling.appointments a
  JOIN directory.patients p ON p.tenant_id=a.tenant_id AND p.practice_id=a.practice_id AND p.id=a.patient_id
  JOIN scheduling.practitioners pr ON pr.tenant_id=a.tenant_id AND pr.practice_id=a.practice_id AND pr.id=a.practitioner_id
  JOIN directory.practice_locations l ON l.tenant_id=a.tenant_id AND l.practice_id=a.practice_id AND l.id=a.location_id
  JOIN scheduling.appointment_types t ON t.tenant_id=a.tenant_id AND t.practice_id=a.practice_id AND t.id=a.appointment_type_id
  LEFT JOIN scheduling.slot_holds h ON h.tenant_id=a.tenant_id AND h.practice_id=a.practice_id AND h.appointment_id=a.id`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
export function patientDisplayName(p: {
  given_name: string;
  family_name: string;
  preferred_name: string | null;
}): string {
  return `${p.preferred_name ?? p.given_name} ${p.family_name}`;
}

interface ViewRow {
  id: string;
  status: AppointmentStatus;
  version: number;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  patient_id: string;
  given_name: string;
  family_name: string;
  preferred_name: string | null;
  patient_number: string;
  practitioner_id: string;
  practitioner_name: string;
  location_id: string;
  location_name: string;
  appointment_type_id: string;
  type_code: string;
  type_name: string;
  type_color: string | null;
  source_channel: string;
  booked_by_actor_type: string;
  booked_by_actor_id: string;
  booked_by_role: string | null;
  referral_id: string | null;
  waitlist_entry_id: string | null;
  hold_id: string | null;
  hold_status: string | null;
  hold_expires_at: Date | null;
  hold_purpose: string | null;
  hold_owner_channel: string | null;
  rescheduled_from_id: string | null;
  rescheduled_to_id: string | null;
  notes: string | null;
  override_availability: boolean;
  confirmed_at: Date | null;
  checked_in_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  no_show_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason_code: string | null;
  cancellation_note: string | null;
  rescheduled_at: Date | null;
  expired_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toView(r: ViewRow): AppointmentView {
  return {
    id: r.id,
    status: r.status,
    version: r.version,
    starts_at: r.starts_at.toISOString(),
    ends_at: r.ends_at.toISOString(),
    timezone: r.timezone,
    duration_minutes: r.duration_minutes,
    buffer_before_minutes: r.buffer_before_minutes,
    buffer_after_minutes: r.buffer_after_minutes,
    patient: {
      id: r.patient_id,
      display_name: patientDisplayName(r),
      given_name: r.preferred_name ?? r.given_name,
      patient_number: r.patient_number,
    },
    practitioner: { id: r.practitioner_id, display_name: r.practitioner_name },
    location: { id: r.location_id, name: r.location_name },
    appointment_type: {
      id: r.appointment_type_id,
      code: r.type_code,
      name: r.type_name,
      calendar_color: r.type_color,
    },
    source_channel: r.source_channel,
    booked_by: {
      actor_type: r.booked_by_actor_type,
      actor_id: r.booked_by_actor_id,
      role: r.booked_by_role,
    },
    referral_id: r.referral_id,
    waitlist_entry_id: r.waitlist_entry_id,
    hold:
      r.hold_id && r.hold_expires_at
        ? {
            id: r.hold_id,
            status: r.hold_status!,
            expires_at: r.hold_expires_at.toISOString(),
            purpose: r.hold_purpose!,
            owner_channel: r.hold_owner_channel!,
          }
        : null,
    rescheduled_from_id: r.rescheduled_from_id,
    rescheduled_to_id: r.rescheduled_to_id,
    notes: r.notes,
    override_availability: r.override_availability,
    confirmed_at: iso(r.confirmed_at),
    checked_in_at: iso(r.checked_in_at),
    started_at: iso(r.started_at),
    completed_at: iso(r.completed_at),
    no_show_at: iso(r.no_show_at),
    cancelled_at: iso(r.cancelled_at),
    cancellation_reason_code: r.cancellation_reason_code,
    cancellation_note: r.cancellation_note,
    rescheduled_at: iso(r.rescheduled_at),
    expired_at: iso(r.expired_at),
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

export async function getAppointmentView(
  c: DbClient,
  s: Scope,
  id: string,
): Promise<AppointmentView> {
  const row = await c.query<ViewRow>(
    `${VIEW_SELECT} WHERE a.tenant_id=$1 AND a.practice_id=$2 AND a.id=$3`,
    [s.tenantId, s.practiceId, id],
  );
  if (!row.rows[0]) throw new SchedulingError("APPOINTMENT_NOT_FOUND");
  return toView(row.rows[0]);
}

export interface AppointmentListQuery {
  from?: Date | undefined;
  to?: Date | undefined;
  practitionerIds?: string[] | undefined;
  locationId?: string | undefined;
  patientId?: string | undefined;
  statuses?: AppointmentStatus[] | undefined;
  /** Keyset cursor: continue after this (starts_at, id). */
  after?: { startsAt: Date; id: string } | undefined;
  limit: number;
}
/**
 * Appointments ordered by start time, keyset-paginated. Held appointments
 * whose hold has lapsed are shown as expired even before the sweep runs.
 */
export async function listAppointments(
  c: DbClient,
  s: Scope,
  q: AppointmentListQuery,
): Promise<{ items: AppointmentView[]; next: string | null }> {
  // Appointments are at most 8 hours long: bounding starts_at keeps the
  // start-time indexes usable for an overlap query.
  const rows = await c.query<ViewRow>(
    `${VIEW_SELECT}
      WHERE a.tenant_id=$1 AND a.practice_id=$2
        AND ($3::timestamptz IS NULL OR (a.starts_at >= $3::timestamptz - interval '8 hours' AND a.ends_at > $3))
        AND ($4::timestamptz IS NULL OR a.starts_at < $4)
        AND ($5::uuid[] IS NULL OR a.practitioner_id = ANY($5::uuid[]))
        AND ($6::uuid IS NULL OR a.location_id=$6)
        AND ($7::uuid IS NULL OR a.patient_id=$7)
        AND ($8::text[] IS NULL OR a.status = ANY($8::text[]))
        AND NOT (a.status='HELD' AND a.hold_expires_at <= now())
        AND ($9::timestamptz IS NULL OR (a.starts_at, a.id) > ($9::timestamptz, $10::uuid))
      ORDER BY a.starts_at, a.id
      LIMIT $11`,
    [
      s.tenantId,
      s.practiceId,
      q.from ?? null,
      q.to ?? null,
      q.practitionerIds?.length ? q.practitionerIds : null,
      q.locationId ?? null,
      q.patientId ?? null,
      q.statuses?.length ? q.statuses : null,
      q.after?.startsAt ?? null,
      q.after?.id ?? null,
      q.limit + 1,
    ],
  );
  const items = rows.rows.slice(0, q.limit).map(toView);
  const last = items[items.length - 1];
  return {
    items,
    next:
      rows.rows.length > q.limit && last
        ? Buffer.from(`${last.starts_at}|${last.id}`).toString("base64url")
        : null,
  };
}
export function decodeCursor(
  cursor: string | undefined,
): { startsAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const startsAt = new Date(at ?? "");
  if (Number.isNaN(+startsAt) || !/^[0-9a-f-]{36}$/i.test(id ?? ""))
    throw new SchedulingError("SEARCH_WINDOW_INVALID", "Invalid cursor.");
  return { startsAt, id: id! };
}

export interface AppointmentEventView {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string;
  actor_type: string;
  actor_id: string;
  actor_role: string | null;
  channel: string | null;
  reason_code: string | null;
  details: Record<string, unknown>;
  occurred_at: string;
}
export async function appointmentHistory(
  c: DbClient,
  s: Scope,
  appointmentId: string,
): Promise<AppointmentEventView[]> {
  // e.id: the unqualified name would sort the text output column.
  const rows = await c.query(
    `SELECT id::text,event_type,from_status,to_status,actor_type,actor_id,actor_role,channel,reason_code,details,occurred_at
       FROM scheduling.appointment_events e WHERE tenant_id=$1 AND practice_id=$2 AND appointment_id=$3 ORDER BY e.id`,
    [s.tenantId, s.practiceId, appointmentId],
  );
  return rows.rows.map((r) => ({
    ...r,
    occurred_at: r.occurred_at.toISOString(),
  }));
}

export async function getHoldView(c: DbClient, s: Scope, holdId: string) {
  const hold = await readHold(c, s, holdId, false);
  const appointment = await getAppointmentView(c, s, hold.appointmentId);
  return {
    id: hold.id,
    status:
      hold.status === "ACTIVE" && hold.expiresAt <= (await databaseNow(c))
        ? "EXPIRED"
        : hold.status,
    purpose: hold.purpose,
    expires_at: hold.expiresAt.toISOString(),
    reschedule_of_id: hold.rescheduleOfId,
    owner: {
      channel: hold.ownerChannel,
      actor_type: hold.ownerActorType,
      session_ref: hold.ownerSessionRef,
    },
    practice_id: s.practiceId,
    practitioner_id: hold.practitionerId,
    location_id: hold.locationId,
    appointment_type_id: hold.appointmentTypeId,
    starts_at: hold.startsAt.toISOString(),
    ends_at: hold.endsAt.toISOString(),
    created_at: hold.createdAt.toISOString(),
    closed_at: hold.closedAt?.toISOString() ?? null,
    close_reason: hold.closeReason,
    appointment,
  };
}

export interface AvailabilityQuery {
  appointmentTypeId: string;
  from: Date;
  to: Date;
  practitionerId?: string | undefined;
  locationId?: string | undefined;
  /** Staff moving an appointment: its own time is not an obstacle. */
  excludeAppointmentId?: string | undefined;
  limit?: number | undefined;
}
export interface AvailableSlotView {
  practitioner_id: string;
  practitioner_name: string;
  location_id: string;
  location_name: string;
  start: string;
  end: string;
  timezone: string;
}
/**
 * The one availability query for every channel. Channels never compute or
 * invent availability: WhatsApp, the console and future web self-service all
 * receive these slots, derived from the committed schedule.
 */
export async function queryAvailability(
  c: DbClient,
  ctx: CommandContext,
  q: AvailabilityQuery,
): Promise<AvailableSlotView[]> {
  if (!(q.to > q.from) || +q.to - +q.from > 31 * DAY_MS)
    throw new SchedulingError("SEARCH_WINDOW_INVALID");
  const practice = await loadPractice(c, ctx);
  const type = await loadAppointmentType(c, ctx, q.appointmentTypeId);
  if (!type.active) throw new SchedulingError("APPOINTMENT_TYPE_INACTIVE");
  const patientChannel = ctx.actor.type === "PATIENT";
  if (patientChannel && !type.patientBookable)
    throw new SchedulingError("CHANNEL_NOT_PERMITTED");
  const pairs = await loadEligiblePairs(c, ctx, type, {
    practitionerId: q.practitionerId,
    locationId: q.locationId,
    patientChannel,
  });
  const schedule = await loadScheduleContext(c, ctx, pairs, q.from, q.to);
  const slots = findAvailableSlots(
    {
      from: q.from,
      to: q.to,
      now: await databaseNow(c),
      actor: ctx.actor.type,
      timing: timingOf(type, practice),
      excludeAppointmentIds: q.excludeAppointmentId
        ? [q.excludeAppointmentId]
        : [],
      limit: q.limit ?? 500,
    },
    schedule,
  );
  const names = await c.query(
    `SELECT 'p' AS kind, id, display_name AS name FROM scheduling.practitioners
      WHERE tenant_id=$1 AND practice_id=$2 AND id = ANY($3::uuid[])
     UNION ALL
     SELECT 'l', id, name FROM directory.practice_locations
      WHERE tenant_id=$1 AND practice_id=$2 AND id = ANY($4::uuid[])`,
    [
      ctx.tenantId,
      ctx.practiceId,
      [...new Set(slots.map((s) => s.practitionerId))],
      [...new Set(slots.map((s) => s.locationId))],
    ],
  );
  const name = new Map(names.rows.map((r) => [`${r.kind}:${r.id}`, r.name]));
  return slots.map((s) => ({
    practitioner_id: s.practitionerId,
    practitioner_name: name.get(`p:${s.practitionerId}`) ?? "",
    location_id: s.locationId,
    location_name: name.get(`l:${s.locationId}`) ?? "",
    start: s.start.toISOString(),
    end: s.end.toISOString(),
    timezone: s.timezone,
  }));
}

/**
 * Everything a day/week calendar renders, in a fixed number of queries:
 * practitioners (columns), their working windows, blocks, exceptions and the
 * appointments in range (lapsed holds excluded).
 */
export async function calendar(
  c: DbClient,
  s: Scope,
  q: {
    from: Date;
    to: Date;
    practitionerIds?: string[] | undefined;
    locationId?: string | undefined;
    includeCancelled?: boolean | undefined;
  },
) {
  if (!(q.to > q.from) || +q.to - +q.from > 31 * DAY_MS)
    throw new SchedulingError("SEARCH_WINDOW_INVALID");
  const practitioners = await c.query(
    `SELECT p.id,p.display_name,p.calendar_color,p.active,
            ARRAY(SELECT pl.location_id FROM scheduling.practitioner_locations pl
                   WHERE pl.tenant_id=p.tenant_id AND pl.practice_id=p.practice_id AND pl.practitioner_id=p.id AND pl.active) AS location_ids
       FROM scheduling.practitioners p
      WHERE p.tenant_id=$1 AND p.practice_id=$2 AND p.active
        AND ($3::uuid[] IS NULL OR p.id = ANY($3::uuid[]))
      ORDER BY p.display_name, p.id`,
    [
      s.tenantId,
      s.practiceId,
      q.practitionerIds?.length ? q.practitionerIds : null,
    ],
  );
  const pairs = practitioners.rows.flatMap((p) =>
    (p.location_ids as string[])
      .filter((l) => !q.locationId || l === q.locationId)
      .map((l) => ({ practitionerId: p.id as string, locationId: l })),
  );
  const tz = await c.query(
    "SELECT id,timezone FROM directory.practice_locations WHERE tenant_id=$1 AND practice_id=$2 AND id = ANY($3::uuid[])",
    [s.tenantId, s.practiceId, [...new Set(pairs.map((p) => p.locationId))]],
  );
  const tzByLocation = new Map(tz.rows.map((r) => [r.id, r.timezone]));
  const schedule = await loadScheduleContext(
    c,
    s,
    pairs.map((p) => ({ ...p, timezone: tzByLocation.get(p.locationId)! })),
    q.from,
    q.to,
  );
  const workingWindows = pairs.flatMap((p) =>
    availableWindows(
      schedule,
      p.practitionerId,
      p.locationId,
      +q.from,
      +q.to,
    ).map((w) => ({
      practitioner_id: p.practitionerId,
      location_id: p.locationId,
      start: new Date(Math.max(w.start, +q.from)).toISOString(),
      end: new Date(Math.min(w.end, +q.to)).toISOString(),
    })),
  );
  const practitionerIds = practitioners.rows.map((p) => p.id as string);
  const blocks = await c.query(
    `SELECT id,practitioner_id,location_id,reason_code,starts_at,ends_at,note,created_by
       FROM scheduling.schedule_blocks
      WHERE tenant_id=$1 AND practice_id=$2 AND practitioner_id = ANY($3::uuid[]) AND removed_at IS NULL
        AND period && tstzrange($4,$5,'[)') ORDER BY starts_at`,
    [s.tenantId, s.practiceId, practitionerIds, q.from, q.to],
  );
  const exceptions = await c.query(
    `SELECT id,practitioner_id,location_id,kind,reason_code,starts_at,ends_at,note
       FROM scheduling.availability_exceptions
      WHERE tenant_id=$1 AND practice_id=$2 AND practitioner_id = ANY($3::uuid[]) AND removed_at IS NULL
        AND period && tstzrange($4,$5,'[)') ORDER BY starts_at`,
    [s.tenantId, s.practiceId, practitionerIds, q.from, q.to],
  );
  const appointments = await listAppointments(c, s, {
    from: q.from,
    to: q.to,
    practitionerIds,
    locationId: q.locationId,
    statuses: q.includeCancelled
      ? undefined
      : [
          "HELD",
          "CONFIRMED",
          "CHECKED_IN",
          "IN_PROGRESS",
          "COMPLETED",
          "NO_SHOW",
        ],
    limit: 2000,
  });
  const at = (d: Date) => d.toISOString();
  return {
    from: at(q.from),
    to: at(q.to),
    practitioners: practitioners.rows.map((p) => ({
      id: p.id,
      display_name: p.display_name,
      calendar_color: p.calendar_color,
      location_ids: p.location_ids,
    })),
    working_windows: workingWindows,
    blocks: blocks.rows.map((b) => ({
      ...b,
      starts_at: at(b.starts_at),
      ends_at: at(b.ends_at),
    })),
    exceptions: exceptions.rows.map((e) => ({
      ...e,
      starts_at: at(e.starts_at),
      ends_at: at(e.ends_at),
    })),
    appointments: appointments.items,
    truncated: appointments.next !== null,
  };
}
