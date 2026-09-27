import { SchedulingError } from "./errors.js";
import { localDateOf } from "./time.js";

/**
 * The appointment state machine. Status is never assigned arbitrarily: every
 * change goes through an action whose transition is listed here, and the
 * database trigger `scheduling.appointment_guard` enforces the same table.
 */
export const APPOINTMENT_STATUSES = [
  "HELD",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "RESCHEDULED",
  "EXPIRED",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  // A hold is confirmed, lapses, or is released.
  HELD: ["CONFIRMED", "EXPIRED", "CANCELLED"],
  CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW", "RESCHEDULED"],
  CHECKED_IN: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED"],
  // A patient marked absent who then arrives the same day.
  NO_SHOW: ["CHECKED_IN"],
  COMPLETED: [],
  CANCELLED: [],
  RESCHEDULED: [],
  EXPIRED: [],
};

/** Statuses that consume the practitioner's time (the exclusion constraint's predicate). */
export const OCCUPYING_STATUSES: readonly AppointmentStatus[] = [
  "HELD",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
];
export const TERMINAL_STATUSES: readonly AppointmentStatus[] = [
  "COMPLETED",
  "CANCELLED",
  "RESCHEDULED",
  "EXPIRED",
];

export function canTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  return APPOINTMENT_TRANSITIONS[from].includes(to);
}
export function assertTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
): void {
  if (!canTransition(from, to))
    throw new SchedulingError(
      "INVALID_TRANSITION",
      `An appointment that is ${from.toLowerCase().replace("_", " ")} cannot become ${to.toLowerCase().replace("_", " ")}.`,
      { from, to },
    );
}
export function occupiesTime(status: AppointmentStatus): boolean {
  return OCCUPYING_STATUSES.includes(status);
}

/** Staff actions on a booked appointment and the status each produces. */
export const APPOINTMENT_ACTIONS = {
  check_in: "CHECKED_IN",
  start: "IN_PROGRESS",
  complete: "COMPLETED",
  no_show: "NO_SHOW",
  cancel: "CANCELLED",
} as const satisfies Record<string, AppointmentStatus>;
export type AppointmentActionName = keyof typeof APPOINTMENT_ACTIONS;

/**
 * Timing rules layered on the transition table, all deterministic:
 * - check-in (including a late arrival after NO_SHOW) only on the
 *   appointment's local calendar day;
 * - no-show only once the appointment's start time has passed.
 */
export function assertActionTiming(input: {
  action: AppointmentActionName;
  from: AppointmentStatus;
  startsAt: Date;
  timezone: string;
  now: Date;
}): void {
  const to = APPOINTMENT_ACTIONS[input.action];
  assertTransition(input.from, to);
  if (
    input.action === "check_in" &&
    localDateOf(input.now, input.timezone) !==
      localDateOf(input.startsAt, input.timezone)
  )
    throw new SchedulingError("CHECK_IN_WRONG_DAY");
  if (input.action === "no_show" && input.now < input.startsAt)
    throw new SchedulingError("TRANSITION_TOO_EARLY");
}
