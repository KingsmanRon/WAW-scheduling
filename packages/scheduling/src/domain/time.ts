import { DateTime } from "luxon";

/**
 * Time-zone arithmetic for the Scheduling Core. Every calculation takes an
 * explicit IANA time zone (the location's); nothing reads the server's local
 * zone. Local calendar dates are `YYYY-MM-DD` strings and wall-clock times
 * are minutes after local midnight (0..1440).
 */
export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimezone(tz: string): boolean {
  return (
    typeof tz === "string" &&
    tz.length > 0 &&
    DateTime.now().setZone(tz).isValid
  );
}

function parseLocalDate(date: string): {
  year: number;
  month: number;
  day: number;
} {
  if (!LOCAL_DATE.test(date))
    throw new RangeError(`invalid local date ${date}`);
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return { year, month, day };
}

/** The local calendar date of an instant in a zone. */
export function localDateOf(instant: Date | number, tz: string): string {
  return DateTime.fromMillis(+instant, { zone: tz }).toISODate()!;
}

/** Minutes (possibly fractional) since local midnight of an instant. */
export function localMinuteOf(instant: Date | number, tz: string): number {
  const dt = DateTime.fromMillis(+instant, { zone: tz });
  return dt.hour * 60 + dt.minute + dt.second / 60 + dt.millisecond / 60_000;
}

/** ISO weekday (1 = Monday .. 7 = Sunday) of a local calendar date. */
export function isoWeekday(date: string): number {
  const { year, month, day } = parseLocalDate(date);
  return DateTime.fromObject({ year, month, day }, { zone: "UTC" }).weekday;
}

export function addLocalDays(date: string, days: number): string {
  const { year, month, day } = parseLocalDate(date);
  return DateTime.fromObject({ year, month, day }, { zone: "UTC" })
    .plus({ days })
    .toISODate()!;
}

/**
 * The instant at which a local wall-clock time occurs.
 *
 * - `exact`: `null` when the wall time does not exist that day (a DST gap);
 *   used for candidate appointment starts, which must be real local times.
 * - `shift`: a nonexistent time moves forward by the gap; used for the edges
 *   of availability windows.
 *
 * An ambiguous wall time (DST overlap) resolves to its first occurrence.
 * Minute 1440 is the following day's midnight.
 */
export function wallClockToInstant(
  date: string,
  minuteOfDay: number,
  tz: string,
  mode: "exact" | "shift" = "exact",
): Date | null {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1440)
    throw new RangeError(`invalid minute of day ${minuteOfDay}`);
  const target = minuteOfDay === 1440 ? addLocalDays(date, 1) : date;
  const minute = minuteOfDay === 1440 ? 0 : minuteOfDay;
  const { year, month, day } = parseLocalDate(target);
  const hour = Math.floor(minute / 60);
  const dt = DateTime.fromObject(
    { year, month, day, hour, minute: minute % 60 },
    { zone: tz },
  );
  if (!dt.isValid) throw new RangeError(`invalid time zone ${tz}`);
  if (
    mode === "exact" &&
    (dt.day !== day || dt.hour !== hour || dt.minute !== minute % 60)
  )
    return null;
  return dt.toJSDate();
}

/** The instant of local midnight at the start of a local date. */
export function startOfLocalDay(date: string, tz: string): Date {
  return wallClockToInstant(date, 0, tz, "shift")!;
}

/** Every local date from the one containing `from` to the one containing `to`. */
export function localDatesBetween(
  from: Date | number,
  to: Date | number,
  tz: string,
): string[] {
  const last = localDateOf(to, tz);
  const dates: string[] = [];
  for (let d = localDateOf(from, tz); d <= last; d = addLocalDays(d, 1)) {
    dates.push(d);
    if (dates.length > 800) throw new RangeError("date range too large");
  }
  return dates;
}

/** Human-readable local date and time, e.g. "Tue 6 Oct 2026, 14:30". */
export function formatLocal(
  instant: Date | number,
  tz: string,
  locale = "en-ZA",
): string {
  return DateTime.fromMillis(+instant, { zone: tz })
    .setLocale(locale)
    .toFormat("ccc d LLL yyyy, HH:mm");
}
