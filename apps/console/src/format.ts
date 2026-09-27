export const STATE_LABELS: Record<string, string> = {
  RECEIVED: "Received",
  IDENTITY_PENDING: "Identity pending",
  INFORMATION_MISSING: "Information missing",
  READY: "Ready (destination entry)",
  DESTINATION_PENDING: "Sending to destination",
  READY_FOR_BOOKING: "Ready for booking",
  WAITING: "Waiting",
  BOOKED: "Booked",
  CLOSED: "Closed",
  EXCEPTION: "Exception",
  REJECTED: "Rejected",
};
export const RESOLUTION_LABELS: Record<string, string> = {
  BOOKED: "Booked",
  PATIENT_UNREACHABLE: "Patient unreachable",
  PATIENT_DECLINED: "Patient declined",
  PROVIDER_DECLINED: "Provider declined",
  DUPLICATE_REFERRAL: "Duplicate referral",
  INVALID_REFERRAL: "Invalid referral",
  MISSING_INFORMATION: "Information never supplied",
  REFERRED_ELSEWHERE: "Referred elsewhere",
  CANCELLED: "Cancelled",
  WITHDRAWN: "Withdrawn",
  UNKNOWN: "Unknown outcome",
};
/** Work item kinds in staff words (no connector vocabulary). */
export const WORK_KIND_LABELS: Record<string, string> = {
  CONNECTOR: "Destination system",
  MANUAL_DESTINATION: "Manual destination step",
  OUTCOME_REVIEW: "Outcome review",
  FILE_SAFETY: "File safety",
  FOLLOW_UP: "Follow-up",
};
export function kindLabel(kind: string): string {
  return WORK_KIND_LABELS[kind] ?? label(kind);
}
/** Who reported a fact, in staff words (no connector vocabulary). */
const SOURCE_LABELS: Record<string, string> = {
  CONNECTOR: "Destination system",
  RECONCILIATION: "Destination system (read back)",
};
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? label(source);
}
/** What kind of work a case is, in the words staff use. */
export const CASE_TYPE_LABELS: Record<string, string> = {
  REFERRAL: "Referral",
  APPOINTMENT_REQUEST: "Booking",
  RESCHEDULING_REQUEST: "Reschedule",
  CANCELLATION_REQUEST: "Cancellation",
};
/** The booking sub-flow in plain words. Never connector vocabulary. */
export const WORKFLOW_LABELS: Record<string, string> = {
  AVAILABILITY_REQUESTED: "Searching for appointments",
  AVAILABILITY_RETURNED: "Appointments found",
  NO_AVAILABILITY: "No appointments found",
  SLOT_SELECTED: "Slot selected",
  HOLD_REQUESTED: "Holding the slot",
  HELD: "Slot held",
  BOOKING_SUBMITTED: "Booking submitted",
  COMMITTED: "Booked, being checked",
  BOOKED: "Booked",
  REPLACEMENT_BOOKED: "New appointment booked, being checked",
  ORIGINAL_CANCELLATION_PENDING: "Cancelling the original appointment",
  COMPLETED: "Rescheduled",
  CANCELLATION_REQUESTED: "Cancellation requested",
  CANCELLATION_SUBMITTED: "Cancellation submitted",
  CANCELLED: "Cancelled",
  WITHDRAWN: "Withdrawn",
};
/** Why the last booking step did not go through, for staff. */
export const FAILURE_LABELS: Record<string, string> = {
  SLOT_UNAVAILABLE:
    "That slot was taken before it could be booked. Choose another.",
  HOLD_EXPIRED:
    "The hold ran out before the booking. Hold the slot again or choose another.",
  HOLD_NOT_FOUND:
    "The destination no longer had the hold. Choose a slot again.",
  HOLD_SLOT_MISMATCH:
    "The destination held a different slot, so the hold was let go. Try again.",
  HOLD_NOT_COMMITTED:
    "The destination confirmed the hold was not made. You can try again.",
  BOOKING_NOT_COMMITTED:
    "The destination confirmed the booking was not made. You can submit it again.",
  CANCELLATION_NOT_COMMITTED:
    "The destination confirmed the cancellation was not made. You can submit it again.",
  ATTESTED_NOT_COMMITTED:
    "Staff checked the destination system and it was not done there. You can try again.",
  ORIGINAL_CANCELLATION_NOT_COMMITTED:
    "The original appointment was not cancelled. Submit its cancellation again, or confirm it is cancelled.",
  BOOKING_UNVERIFIED:
    "The destination did not show the booking when ACCESS checked it.",
  REPLACEMENT_UNVERIFIED:
    "The destination did not show the new appointment when ACCESS checked it.",
  REJECTED: "The destination refused the request.",
  CAPABILITY_WITHDRAWN:
    "Automated booking is not available for this destination right now.",
  UNSUPPORTED_OPERATION:
    "Automated booking is not enabled for this destination.",
};
export function failureText(code: string | null | undefined): string {
  if (!code) return "";
  return (
    FAILURE_LABELS[code] ?? `The last step did not complete (${label(code)}).`
  );
}
/**
 * An appointment time in the time zone of the place it happens, with the
 * zone named, so staff in another zone are never misled.
 */
export function slotTime(
  startAt: string,
  timezone: string,
  endAt?: string,
): string {
  const start = new Date(startAt);
  const day = new Intl.DateTimeFormat([], {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(start);
  const time = (d: Date) =>
    new Intl.DateTimeFormat([], {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  return `${day}, ${time(start)}${endAt ? `–${time(new Date(endAt))}` : ""}`;
}
/** The calendar day of a slot in its own time zone (for grouping). */
export function slotDay(startAt: string, timezone: string): string {
  return new Intl.DateTimeFormat([], {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(startAt));
}
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "Unknown";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}
export function when(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}
export function percent(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "Unknown"
    : `${(value * 100).toFixed(1)}%`;
}
export function stateClass(state: string): string {
  return `badge state-${state.toLowerCase().replace(/_/g, "-")}`;
}
export function label(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Staff role or owner role in plain words; null means nobody is assigned. */
export function roleLabel(role: string | null | undefined): string {
  return role ? label(role) : "Unassigned";
}
/** Machine reason codes ("missing:insurance,demographics") in plain words. */
export function reasonLabel(code: string | null | undefined): string {
  if (!code) return "";
  const [head, ...rest] = code.split(":");
  const tail = rest.join(":");
  if (!tail) return label(head!);
  return `${label(head!)}: ${tail
    .split(",")
    .map((part) => part.replace(/[_.]/g, " "))
    .join(", ")}`;
}
/** First block of an opaque identifier, for compact display. */
export function shortId(id: string | null | undefined): string {
  return id ? id.split("-")[0]!.slice(0, 8) : "";
}
/** Compact local time: today shows the time, other days the date too. */
export function stamp(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}
