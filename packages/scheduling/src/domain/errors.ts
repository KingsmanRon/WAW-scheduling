/**
 * Explicit domain error codes of the Scheduling Core. Every consequential
 * refusal is one of these, with a stable HTTP status; messages are for staff
 * and never contain patient data or database detail.
 */
export const SCHEDULING_ERRORS = {
  // Concurrency and availability.
  SLOT_UNAVAILABLE: [409, "The requested time is no longer available."],
  PATIENT_SCHEDULE_CONFLICT: [
    409,
    "The patient already has an appointment at this time.",
  ],
  OUTSIDE_AVAILABILITY: [
    422,
    "The practitioner is not available at this time.",
  ],
  OUTSIDE_BOOKING_WINDOW: [
    422,
    "The time is outside the bookable window for this appointment type.",
  ],
  NOT_ON_SLOT_GRID: [422, "Choose one of the offered appointment times."],
  PRACTITIONER_NOT_AT_LOCATION: [
    422,
    "The practitioner does not work at this location.",
  ],
  // Holds.
  HOLD_NOT_FOUND: [404, "The slot hold was not found."],
  HOLD_EXPIRED: [409, "The slot hold has expired."],
  HOLD_NOT_ACTIVE: [409, "The slot hold is no longer active."],
  HOLD_NOT_OWNED: [403, "The slot hold belongs to another session."],
  // State machine.
  APPOINTMENT_NOT_FOUND: [404, "The appointment was not found."],
  INVALID_TRANSITION: [409, "The appointment cannot make this change now."],
  TRANSITION_TOO_EARLY: [
    409,
    "This change is only possible once the appointment time has arrived.",
  ],
  CHECK_IN_WRONG_DAY: [
    409,
    "Patients can only be checked in on the day of the appointment.",
  ],
  VERSION_CONFLICT: [
    409,
    "The appointment changed since it was loaded. Refresh and try again.",
  ],
  PATIENT_CHANGE_CUTOFF: [
    422,
    "This appointment can no longer be changed through this channel; please contact the practice.",
  ],
  // Configuration and eligibility.
  APPOINTMENT_TYPE_NOT_FOUND: [404, "The appointment type was not found."],
  APPOINTMENT_TYPE_INACTIVE: [422, "The appointment type is not active."],
  PRACTITIONER_NOT_FOUND: [404, "The practitioner was not found."],
  PRACTITIONER_INACTIVE: [422, "The practitioner is not active."],
  LOCATION_NOT_FOUND: [404, "The location was not found."],
  LOCATION_INACTIVE: [422, "The location is not active."],
  PRACTITIONER_NOT_ALLOWED: [
    422,
    "The practitioner does not offer this appointment type.",
  ],
  LOCATION_NOT_ALLOWED: [
    422,
    "This appointment type is not offered at this location.",
  ],
  CHANNEL_NOT_PERMITTED: [
    422,
    "This appointment cannot be booked through this channel.",
  ],
  PATIENT_NOT_FOUND: [404, "The patient was not found."],
  PATIENT_INACTIVE: [422, "The patient record is archived."],
  NEW_PATIENT_NOT_ALLOWED: [
    422,
    "This appointment type is for existing patients only.",
  ],
  FOLLOW_UP_ONLY: [
    422,
    "This appointment type is only for follow-up with the same practitioner.",
  ],
  REFERRAL_REQUIRED: [422, "This appointment type requires a referral."],
  REFERRAL_NOT_FOUND: [404, "The referral was not found."],
  REFERRAL_NOT_VERIFIED: [422, "The referral has not been verified."],
  REFERRAL_EXPIRED: [422, "The referral is not valid on the appointment date."],
  REFERRAL_EXHAUSTED: [
    422,
    "The referral has been used for its maximum number of appointments.",
  ],
  REFERRAL_MISMATCH: [
    422,
    "The referral does not cover this patient and appointment type.",
  ],
  OVERRIDE_NOT_PERMITTED: [
    403,
    "Booking outside availability requires an override permission.",
  ],
  // Waitlist.
  WAITLIST_ENTRY_NOT_FOUND: [404, "The waitlist entry was not found."],
  WAITLIST_OFFER_NOT_FOUND: [404, "The waitlist offer was not found."],
  WAITLIST_OFFER_EXPIRED: [409, "The waitlist offer has expired."],
  WAITLIST_OFFER_NOT_PENDING: [409, "The waitlist offer was already answered."],
  WAITLIST_DUPLICATE: [
    409,
    "The patient is already on the waitlist for this appointment type.",
  ],
  // Schedule configuration.
  SCHEDULE_BLOCK_CONFLICT: [
    409,
    "The block overlaps booked appointments. Reschedule them first or confirm the conflict.",
  ],
  AVAILABILITY_RULE_CONFLICT: [
    409,
    "The working hours overlap existing working hours for this practitioner.",
  ],
  SEARCH_WINDOW_INVALID: [
    400,
    "The search window must end after it starts and span at most 31 days.",
  ],
} as const satisfies Record<string, readonly [number, string]>;
export type SchedulingErrorCode = keyof typeof SCHEDULING_ERRORS;

export class SchedulingError extends Error {
  override readonly name = "SchedulingError";
  readonly statusCode: number;
  constructor(
    readonly code: SchedulingErrorCode,
    message?: string,
    /** Safe, non-sensitive structured detail (ids, instants, alternatives). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? SCHEDULING_ERRORS[code][1]);
    this.statusCode = SCHEDULING_ERRORS[code][0];
  }
}

export function isSchedulingError(e: unknown): e is SchedulingError {
  return e instanceof SchedulingError;
}
