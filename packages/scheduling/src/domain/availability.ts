import { DateTime } from "luxon";
import {
  containedIn,
  normalize,
  overlapsAny,
  subtract,
  type Interval,
} from "./intervals.js";
import {
  DAY_MS,
  MINUTE_MS,
  isoWeekday,
  localDateOf,
  localDatesBetween,
  localMinuteOf,
  wallClockToInstant,
} from "./time.js";

/**
 * Availability engine: the single place where bookable times are derived.
 * Candidate start times are generated on demand from the practitioner's
 * recurring rules and one-off availability, minus leave/exceptions, schedule
 * blocks and time already occupied (appointments and live holds, with their
 * buffers). Nothing is pre-generated or cached; nothing is hardcoded.
 *
 * Semantics:
 * - An appointment occupies [start - buffer_before, end + buffer_after). That
 *   whole occupied interval must lie inside one available window and must not
 *   overlap any other occupied interval of the practitioner (the same range
 *   the database's exclusion constraint protects).
 * - Candidate starts sit on a local wall-clock grid anchored at local
 *   midnight (e.g. :00/:15/:30/:45 for a 15-minute interval), so the offered
 *   times are the same whatever the search window.
 * - Weekly rules are local wall-clock times in the location's IANA zone; DST
 *   gaps are skipped and ambiguous times use their first occurrence.
 */

/** Who is booking. Patient self-service follows the type's booking window and grid. */
export type ActorKind = "STAFF" | "PATIENT" | "SYSTEM";

export interface AppointmentTiming {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  slotIntervalMinutes: number;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
}
export interface WeeklyRule {
  practitionerId: string;
  locationId: string;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  startMinute: number;
  endMinute: number;
  /** Local calendar dates (inclusive); `validUntil` null = open-ended. */
  validFrom: string;
  validUntil: string | null;
}
export interface DatedPeriod {
  practitionerId: string;
  /** null applies at every location. */
  locationId: string | null;
  start: Date;
  end: Date;
}
export interface AvailabilityException extends DatedPeriod {
  kind: "AVAILABLE" | "UNAVAILABLE";
}
export interface OccupiedPeriod {
  practitionerId: string;
  appointmentId: string;
  /** Occupied range including buffers. */
  start: Date;
  end: Date;
}
export interface ScheduleContext {
  /** Time zone per location id. */
  locations: ReadonlyMap<string, { timezone: string }>;
  /** Practitioner/location pairs eligible for the requested appointment type. */
  pairs: ReadonlyArray<{ practitionerId: string; locationId: string }>;
  rules: readonly WeeklyRule[];
  exceptions: readonly AvailabilityException[];
  blocks: readonly DatedPeriod[];
  /** Appointments and unexpired holds that consume time. */
  occupancy: readonly OccupiedPeriod[];
}
export interface BookingRequestTiming {
  actor: ActorKind;
  now: Date;
  timing: AppointmentTiming;
  /** Occupancy to ignore (the appointment being rescheduled in place). */
  excludeAppointmentIds?: readonly string[];
  /** Staff may book a walk-in that started moments ago. Default 15 minutes. */
  staffGraceMinutes?: number;
  /** Furthest staff booking horizon. Default 730 days. */
  staffHorizonDays?: number;
}
export interface AvailabilityRequest extends BookingRequestTiming {
  from: Date;
  to: Date;
  limit?: number;
}
export interface CandidateSlot {
  practitionerId: string;
  locationId: string;
  start: Date;
  end: Date;
  timezone: string;
}

/** Earliest and latest permitted start for the actor. */
export function bookingWindow(req: BookingRequestTiming): {
  earliest: number;
  latest: number;
} {
  const now = req.now.getTime();
  if (req.actor === "PATIENT")
    return {
      earliest: now + req.timing.minNoticeMinutes * MINUTE_MS,
      latest: now + req.timing.maxAdvanceDays * DAY_MS,
    };
  return {
    earliest: now - (req.staffGraceMinutes ?? 15) * MINUTE_MS,
    latest: now + (req.staffHorizonDays ?? 730) * DAY_MS,
  };
}

function appliesAt(
  period: DatedPeriod,
  practitionerId: string,
  locationId: string,
) {
  return (
    period.practitionerId === practitionerId &&
    (period.locationId === null || period.locationId === locationId)
  );
}

/**
 * Available windows (instants) for one practitioner at one location that
 * intersect [from, to): recurring rules plus one-off availability, minus
 * unavailability exceptions and schedule blocks.
 */
export function availableWindows(
  ctx: ScheduleContext,
  practitionerId: string,
  locationId: string,
  from: number,
  to: number,
): Interval[] {
  const tz = ctx.locations.get(locationId)?.timezone;
  if (!tz) return [];
  const windows: Interval[] = [];
  const rules = ctx.rules.filter(
    (r) => r.practitionerId === practitionerId && r.locationId === locationId,
  );
  if (rules.length)
    // One extra day each side: a local day can start before `from` in UTC.
    for (const date of localDatesBetween(from - DAY_MS, to + DAY_MS, tz)) {
      const weekday = isoWeekday(date);
      for (const r of rules) {
        if (
          r.weekday !== weekday ||
          date < r.validFrom ||
          (r.validUntil !== null && date > r.validUntil)
        )
          continue;
        const start = wallClockToInstant(date, r.startMinute, tz, "shift")!;
        const end = wallClockToInstant(date, r.endMinute, tz, "shift")!;
        if (end > start) windows.push({ start: +start, end: +end });
      }
    }
  for (const e of ctx.exceptions)
    if (
      e.kind === "AVAILABLE" &&
      e.practitionerId === practitionerId &&
      e.locationId === locationId
    )
      windows.push({ start: +e.start, end: +e.end });
  const unavailable = [
    ...ctx.exceptions.filter(
      (e) =>
        e.kind === "UNAVAILABLE" && appliesAt(e, practitionerId, locationId),
    ),
    ...ctx.blocks.filter((b) => appliesAt(b, practitionerId, locationId)),
  ].map((p) => ({ start: +p.start, end: +p.end }));
  return subtract(windows, unavailable).filter(
    (w) => w.end > from && w.start < to,
  );
}

function occupiedFor(
  ctx: ScheduleContext,
  practitionerId: string,
  exclude: readonly string[] | undefined,
): Interval[] {
  return normalize(
    ctx.occupancy
      .filter(
        (o) =>
          o.practitionerId === practitionerId &&
          !(exclude ?? []).includes(o.appointmentId),
      )
      .map((o) => ({ start: +o.start, end: +o.end })),
  );
}

function occupiedInterval(start: number, t: AppointmentTiming): Interval {
  return {
    start: start - t.bufferBeforeMinutes * MINUTE_MS,
    end: start + (t.durationMinutes + t.bufferAfterMinutes) * MINUTE_MS,
  };
}

/**
 * Bookable start times in [from, to) for every eligible practitioner and
 * location, sorted by time (then practitioner). Deterministic for the same
 * inputs.
 */
export function findAvailableSlots(
  req: AvailabilityRequest,
  ctx: ScheduleContext,
): CandidateSlot[] {
  const t = req.timing;
  const interval = t.slotIntervalMinutes;
  const { earliest, latest } = bookingWindow(req);
  const lo = Math.max(+req.from, earliest);
  const hi = Math.min(+req.to - 1, latest);
  const slots: CandidateSlot[] = [];
  if (lo > hi) return slots;
  const beforeMs = t.bufferBeforeMinutes * MINUTE_MS;
  const afterMs = (t.durationMinutes + t.bufferAfterMinutes) * MINUTE_MS;
  const occupiedByPractitioner = new Map<string, Interval[]>();
  const frames = new DayFrames();
  for (const pair of ctx.pairs) {
    const tz = ctx.locations.get(pair.locationId)?.timezone;
    if (!tz) continue;
    let occupied = occupiedByPractitioner.get(pair.practitionerId);
    if (!occupied) {
      occupied = occupiedFor(
        ctx,
        pair.practitionerId,
        req.excludeAppointmentIds,
      );
      occupiedByPractitioner.set(pair.practitionerId, occupied);
    }
    const windows = availableWindows(
      ctx,
      pair.practitionerId,
      pair.locationId,
      lo - beforeMs,
      hi + afterMs,
    );
    for (const w of windows) {
      // Starts whose whole occupied interval fits the window and the request.
      const first = Math.max(w.start + beforeMs, lo);
      const last = Math.min(w.end - afterMs, hi);
      if (first > last) continue;
      const lastDate = localDateOf(last, tz);
      let minute =
        Math.ceil(localMinuteOf(first, tz) / interval - 1e-9) * interval;
      let date = localDateOf(first, tz);
      let day = frames.get(tz, date);
      while (date <= lastDate) {
        if (minute >= 1440) {
          date = nextDate(date);
          day = frames.get(tz, date);
          minute = 0;
          continue;
        }
        const s = day.linear
          ? day.midnight + minute * MINUTE_MS
          : +(wallClockToInstant(date, minute, tz, "exact") ?? NaN);
        minute += interval;
        if (Number.isNaN(s)) continue;
        if (s < first) continue;
        if (s > last) break;
        if (overlapsAny(occupied, { start: s - beforeMs, end: s + afterMs }))
          continue;
        slots.push({
          practitionerId: pair.practitionerId,
          locationId: pair.locationId,
          start: new Date(s),
          end: new Date(s + t.durationMinutes * MINUTE_MS),
          timezone: tz,
        });
      }
    }
  }
  slots.sort(
    (a, b) =>
      +a.start - +b.start ||
      a.practitionerId.localeCompare(b.practitionerId) ||
      a.locationId.localeCompare(b.locationId),
  );
  // Several windows of one pair never yield the same start twice (windows
  // are disjoint), but two locations of one practitioner may: keep both.
  return req.limit ? slots.slice(0, req.limit) : slots;
}

/**
 * Local midnight of each date, and whether the day is a plain 24-hour day in
 * the zone (no offset change). On such days a local minute maps to an instant
 * by addition, which is exact and avoids a zone lookup per candidate; DST
 * transition days take the exact per-candidate conversion.
 */
class DayFrames {
  private cache = new Map<string, { midnight: number; linear: boolean }>();
  get(tz: string, date: string): { midnight: number; linear: boolean } {
    const key = `${tz}|${date}`;
    let frame = this.cache.get(key);
    if (!frame) {
      const midnight = wallClockToInstant(date, 0, tz, "exact");
      const next = wallClockToInstant(nextDate(date), 0, tz, "exact");
      frame = {
        midnight: midnight ? +midnight : NaN,
        linear:
          midnight !== null &&
          next !== null &&
          +next - +midnight === DAY_MS &&
          DateTime.fromMillis(+midnight, { zone: tz }).offset ===
            DateTime.fromMillis(+next - 1, { zone: tz }).offset,
      };
      this.cache.set(key, frame);
    }
    return frame;
  }
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export type SlotRefusal =
  | "OUTSIDE_BOOKING_WINDOW"
  | "PRACTITIONER_NOT_AT_LOCATION"
  | "NOT_ON_SLOT_GRID"
  | "OUTSIDE_AVAILABILITY"
  | "SLOT_UNAVAILABLE";
export type SlotCheck =
  | { ok: true; timezone: string; occupied: Interval }
  | { ok: false; code: SlotRefusal };

/**
 * Whether one specific start can be booked, using exactly the rules of
 * `findAvailableSlots`. Staff (and the system) may start at any minute;
 * patients only on the offered grid. `override` (an authorised, audited staff
 * decision) skips the availability-window check but never the conflict check.
 */
export function checkSlot(
  req: BookingRequestTiming & { override?: boolean },
  ctx: ScheduleContext,
  slot: { practitionerId: string; locationId: string; start: Date },
): SlotCheck {
  const t = req.timing;
  const s = +slot.start;
  const { earliest, latest } = bookingWindow(req);
  if (s < earliest || s > latest)
    return { ok: false, code: "OUTSIDE_BOOKING_WINDOW" };
  const tz = ctx.locations.get(slot.locationId)?.timezone;
  if (
    !tz ||
    !ctx.pairs.some(
      (p) =>
        p.practitionerId === slot.practitionerId &&
        p.locationId === slot.locationId,
    )
  )
    return { ok: false, code: "PRACTITIONER_NOT_AT_LOCATION" };
  if (req.actor === "PATIENT") {
    const minute = localMinuteOf(s, tz);
    if (!Number.isInteger(minute) || minute % t.slotIntervalMinutes !== 0)
      return { ok: false, code: "NOT_ON_SLOT_GRID" };
  }
  const occupied = occupiedInterval(s, t);
  if (!req.override) {
    const windows = availableWindows(
      ctx,
      slot.practitionerId,
      slot.locationId,
      occupied.start,
      occupied.end,
    );
    if (!containedIn(windows, occupied))
      return { ok: false, code: "OUTSIDE_AVAILABILITY" };
  }
  if (
    overlapsAny(
      occupiedFor(ctx, slot.practitionerId, req.excludeAppointmentIds),
      occupied,
    )
  )
    return { ok: false, code: "SLOT_UNAVAILABLE" };
  return { ok: true, timezone: tz, occupied };
}
