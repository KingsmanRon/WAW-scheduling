import { DateTime } from "luxon";

/**
 * Times are shown and chosen in the practice's (or location's) IANA zone,
 * never the browser's: a receptionist working remotely still sees the
 * practice's wall clock. Instants travel as ISO strings with offsets.
 */
const LOCALE = "en-ZA";

export const dt = (iso: string, tz: string) =>
  DateTime.fromISO(iso, { zone: tz }).setLocale(LOCALE);

/** Today's date (YYYY-MM-DD) in a zone. */
export function todayIn(tz: string): string {
  return DateTime.now().setZone(tz).toISODate()!;
}
/** Local midnight at the start of a date, as an instant. */
export function startOfDay(date: string, tz: string): DateTime {
  return DateTime.fromISO(date, { zone: tz }).startOf("day");
}
/** [start, end) of a local day. */
export function dayRange(
  date: string,
  tz: string,
): { from: string; to: string } {
  const start = startOfDay(date, tz);
  return { from: start.toISO()!, to: start.plus({ days: 1 }).toISO()! };
}
/** The Monday-to-Sunday week containing a date. */
export function weekDays(date: string, tz: string): string[] {
  const monday = startOfDay(date, tz).startOf("week");
  return Array.from({ length: 7 }, (_, i) =>
    monday.plus({ days: i }).toISODate()!,
  );
}
export function weekRange(
  date: string,
  tz: string,
): { from: string; to: string } {
  const days = weekDays(date, tz);
  return {
    from: startOfDay(days[0]!, tz).toISO()!,
    to: startOfDay(days[6]!, tz).plus({ days: 1 }).toISO()!,
  };
}
export function shiftDate(date: string, days: number): string {
  return DateTime.fromISO(date).plus({ days }).toISODate()!;
}
/** Minutes after local midnight of the instant's own local day. */
export function minuteOfDay(iso: string, tz: string): number {
  const d = dt(iso, tz);
  return d.hour * 60 + d.minute;
}
/** The instant at a local date and minute of day (DST-safe). */
export function atMinute(date: string, minute: number, tz: string): string {
  return startOfDay(date, tz)
    .set({ hour: Math.floor(minute / 60), minute: minute % 60 })
    .toISO()!;
}

export const fmt = {
  time: (iso: string, tz: string) => dt(iso, tz).toFormat("HH:mm"),
  range: (from: string, to: string, tz: string) =>
    `${dt(from, tz).toFormat("HH:mm")}–${dt(to, tz).toFormat("HH:mm")}`,
  day: (iso: string, tz: string) => dt(iso, tz).toFormat("ccc d LLL"),
  longDay: (date: string) =>
    DateTime.fromISO(date).setLocale(LOCALE).toFormat("cccc d LLLL yyyy"),
  shortDate: (date: string) =>
    DateTime.fromISO(date).setLocale(LOCALE).toFormat("ccc d LLL"),
  /** A calendar date on its own: "29 Sept 2026". */
  date: (date: string) =>
    DateTime.fromISO(date).setLocale(LOCALE).toFormat("d LLL yyyy"),
  when: (iso: string, tz: string) =>
    dt(iso, tz).toFormat("ccc d LLL yyyy, HH:mm"),
  /** "in 4 min", "3 h ago". */
  relative: (iso: string) =>
    DateTime.fromISO(iso).setLocale(LOCALE).toRelative({ style: "short" }) ??
    "",
  minute: (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
};
export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
/** "08:30" to minutes after midnight, or null. */
export function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}
