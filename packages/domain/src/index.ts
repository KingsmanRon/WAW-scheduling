import {
  TERMINAL_CASE_STATES,
  isAppointmentCaseType,
  type AppointmentWorkflowStatus,
  type CaseState,
  type ExecutionStatus,
  type ObservationDisposition,
  type ObservationType,
  type ResolutionCode,
} from "@access/contracts";
export type { CaseState } from "@access/contracts";

/**
 * ACCESS case lifecycle. This is business state only: connector execution
 * status (PENDING, LEASED, AMBIGUOUS, RECONCILING ...) lives on executions and
 * never appears here. Keep in sync with enforce_case_transition() (0003).
 */
const allowed: Record<CaseState, readonly CaseState[]> = {
  RECEIVED: [
    "IDENTITY_PENDING",
    "INFORMATION_MISSING",
    "READY",
    "DESTINATION_PENDING",
    "EXCEPTION",
    "REJECTED",
  ],
  IDENTITY_PENDING: [
    "INFORMATION_MISSING",
    "READY",
    "DESTINATION_PENDING",
    "EXCEPTION",
    "REJECTED",
    "CLOSED",
  ],
  INFORMATION_MISSING: [
    "IDENTITY_PENDING",
    "READY",
    "DESTINATION_PENDING",
    "EXCEPTION",
    "REJECTED",
    "CLOSED",
  ],
  READY: ["DESTINATION_PENDING", "READY_FOR_BOOKING", "EXCEPTION", "CLOSED"],
  // A destination write may be in flight: only its settlement moves the case.
  DESTINATION_PENDING: ["READY_FOR_BOOKING", "EXCEPTION"],
  READY_FOR_BOOKING: ["WAITING", "BOOKED", "CLOSED", "EXCEPTION"],
  WAITING: ["READY_FOR_BOOKING", "BOOKED", "CLOSED", "EXCEPTION"],
  EXCEPTION: [
    "IDENTITY_PENDING",
    "INFORMATION_MISSING",
    "READY",
    "DESTINATION_PENDING",
    "READY_FOR_BOOKING",
    "REJECTED",
    "CLOSED",
  ],
  // Terminal states move only through the explicit, audited outcome
  // correction action (CLOSED <-> BOOKED); nothing re-opens them otherwise.
  BOOKED: ["CLOSED"],
  CLOSED: ["BOOKED"],
  REJECTED: [],
};
/**
 * Appointment operations cases (APPOINTMENT_REQUEST, RESCHEDULING_REQUEST,
 * CANCELLATION_REQUEST) have a narrower lifecycle: READY_FOR_BOOKING means a
 * staff decision is needed, WAITING means an external action is pending.
 * EXCEPTION -> BOOKED exists only for a reschedule whose remaining
 * uncertainty is settled by read-back or an audited attestation. Keep in
 * sync with enforce_case_transition() (0006).
 */
const appointmentAllowed: Record<CaseState, readonly CaseState[]> = {
  RECEIVED: ["READY_FOR_BOOKING", "WAITING", "EXCEPTION", "CLOSED"],
  IDENTITY_PENDING: [],
  INFORMATION_MISSING: [],
  READY: [],
  DESTINATION_PENDING: [],
  READY_FOR_BOOKING: ["WAITING", "EXCEPTION", "CLOSED"],
  WAITING: ["READY_FOR_BOOKING", "BOOKED", "EXCEPTION", "CLOSED"],
  EXCEPTION: ["READY_FOR_BOOKING", "WAITING", "BOOKED", "CLOSED"],
  BOOKED: [],
  CLOSED: [],
  REJECTED: [],
};
const cancellationAllowed: Record<CaseState, readonly CaseState[]> = {
  ...appointmentAllowed,
  // A cancellation request closes; it never books.
  WAITING: ["READY_FOR_BOOKING", "EXCEPTION", "CLOSED"],
  EXCEPTION: ["READY_FOR_BOOKING", "WAITING", "CLOSED"],
};
export const APPOINTMENT_CASE_TRANSITIONS = appointmentAllowed;
/** Transition table for a case type (referral semantics by default). */
export function transitionsFor(
  caseType?: string,
): Record<CaseState, readonly CaseState[]> {
  if (caseType === "CANCELLATION_REQUEST") return cancellationAllowed;
  return caseType && isAppointmentCaseType(caseType)
    ? appointmentAllowed
    : allowed;
}
export class InvalidTransitionError extends Error {
  readonly statusCode = 409;
  readonly code = "INVALID_TRANSITION";
  constructor(from: CaseState, to: CaseState) {
    super(`invalid transition ${from} -> ${to}`);
  }
}
export function transition(
  from: CaseState,
  to: CaseState,
  caseType?: string,
): CaseState {
  if (!transitionsFor(caseType)[from].includes(to))
    throw new InvalidTransitionError(from, to);
  return to;
}
export function canTransition(
  from: CaseState,
  to: CaseState,
  caseType?: string,
): boolean {
  return transitionsFor(caseType)[from].includes(to);
}
export function isTerminal(state: CaseState): boolean {
  return TERMINAL_CASE_STATES.includes(state);
}
export const CASE_TRANSITIONS = allowed;

/** Pre-destination states: the referral has not reached the destination. */
export const PRE_DESTINATION: readonly CaseState[] = [
  "RECEIVED",
  "IDENTITY_PENDING",
  "INFORMATION_MISSING",
  "READY",
  "DESTINATION_PENDING",
];

/** Execution statuses that mean a foreign effect may still be in flight. */
export const IN_FLIGHT_EXECUTION: readonly ExecutionStatus[] = [
  "PENDING",
  "LEASED",
  "RETRYABLE",
  "AMBIGUOUS",
  "RECONCILING",
];

/**
 * Terminal meaning of an outcome observation. Only these observation types
 * can resolve a case; milestone observations never do.
 */
export function terminalOutcome(
  type: ObservationType,
  resolutionCode?: ResolutionCode,
): { state: "BOOKED" | "CLOSED"; code: ResolutionCode } | null {
  switch (type) {
    case "APPOINTMENT_BOOKED":
      return { state: "BOOKED", code: "BOOKED" };
    case "PATIENT_UNREACHABLE":
      return { state: "CLOSED", code: "PATIENT_UNREACHABLE" };
    case "PATIENT_DECLINED":
      return { state: "CLOSED", code: "PATIENT_DECLINED" };
    case "PROVIDER_DECLINED":
      return { state: "CLOSED", code: "PROVIDER_DECLINED" };
    case "REFERRAL_CLOSED":
      if (!resolutionCode || resolutionCode === "BOOKED") return null;
      return { state: "CLOSED", code: resolutionCode };
    default:
      return null;
  }
}

export type ObservationPlan =
  | { disposition: "APPLIED"; to: CaseState; resolution: ResolutionCode | null }
  | { disposition: Exclude<ObservationDisposition, "APPLIED">; reason: string };

/**
 * Decide what an outcome observation does to a case. Pure and deterministic
 * so out-of-order and duplicate deliveries are reproducible:
 * - a terminal case is never regressed; a conflicting later fact goes to
 *   human review, an earlier or agreeing fact is only recorded;
 * - outcomes that arrive before the destination commit are held PENDING and
 *   applied once the case reaches READY_FOR_BOOKING;
 * - nothing auto-advances out of EXCEPTION (it may be a safety hold).
 */
export function planObservation(input: {
  state: CaseState;
  type: ObservationType;
  occurredAt: Date;
  resolutionCode?: ResolutionCode;
  caseOutcome?: { code: ResolutionCode | null; at: Date | null };
  /**
   * STAFF: an authorised person is recording their own decision, which may
   * close a case held in EXCEPTION. EXTERNAL facts never leave EXCEPTION.
   */
  authority?: "EXTERNAL" | "STAFF";
}): ObservationPlan {
  const { state, type } = input;
  const terminal = terminalOutcome(type, input.resolutionCode);
  if (
    type === "REFERRAL_RECEIVED" ||
    type === "REFERRAL_VERIFIED" ||
    type === "REFERRAL_READY" ||
    type === "DESTINATION_COMMITTED"
  )
    return { disposition: "RECORDED", reason: "milestone" };
  if (type === "REFERRAL_CLOSED" && !terminal)
    return { disposition: "REVIEW", reason: "closure_without_valid_code" };
  if (isTerminal(state)) {
    const outcome = input.caseOutcome;
    if (terminal && outcome?.code === terminal.code)
      return { disposition: "RECORDED", reason: "agrees_with_outcome" };
    if (outcome?.at && input.occurredAt.getTime() <= outcome.at.getTime())
      return { disposition: "RECORDED", reason: "precedes_outcome" };
    if (type === "BOOKING_REQUESTED")
      return { disposition: "RECORDED", reason: "after_terminal_outcome" };
    return { disposition: "REVIEW", reason: "conflicts_with_terminal_outcome" };
  }
  if (state === "EXCEPTION") {
    if (input.authority === "STAFF" && terminal?.state === "CLOSED")
      return {
        disposition: "APPLIED",
        to: "CLOSED",
        resolution: terminal.code,
      };
    return { disposition: "REVIEW", reason: "case_in_exception" };
  }
  if (PRE_DESTINATION.includes(state)) {
    if (terminal?.state === "CLOSED" && canTransition(state, "CLOSED"))
      return {
        disposition: "APPLIED",
        to: "CLOSED",
        resolution: terminal.code,
      };
    return { disposition: "PENDING", reason: "awaiting_destination_commit" };
  }
  // READY_FOR_BOOKING or WAITING.
  if (terminal)
    return {
      disposition: "APPLIED",
      to: terminal.state,
      resolution: terminal.code,
    };
  if (type === "BOOKING_REQUESTED")
    return state === "READY_FOR_BOOKING"
      ? { disposition: "APPLIED", to: "WAITING", resolution: null }
      : { disposition: "RECORDED", reason: "already_waiting" };
  if (type === "APPOINTMENT_CANCELLED")
    return state === "WAITING"
      ? { disposition: "APPLIED", to: "READY_FOR_BOOKING", resolution: null }
      : { disposition: "RECORDED", reason: "no_active_booking" };
  return { disposition: "RECORDED", reason: "no_effect" };
}

/** Plain-language next step shown to staff; never a clinical instruction. */
export function nextRequiredAction(input: {
  state: CaseState;
  destinationMode?: "CONNECTOR" | "MANUAL" | null;
  missing?: readonly string[];
  exceptionReason?: string | null;
}): string {
  switch (input.state) {
    case "RECEIVED":
      return "System processing";
    case "IDENTITY_PENDING":
      return "Confirm patient identity";
    case "INFORMATION_MISSING":
      return input.missing?.length
        ? `Obtain missing information: ${input.missing.join(", ")}`
        : "Obtain missing information";
    case "READY":
      return input.destinationMode === "CONNECTOR"
        ? "Queued for destination system"
        : "Enter referral in destination system and record its reference";
    case "DESTINATION_PENDING":
      return "Awaiting destination system (automated)";
    case "READY_FOR_BOOKING":
      return "Contact patient to book";
    case "WAITING":
      return "Awaiting booking or patient response; follow up when due";
    case "EXCEPTION":
      return `Resolve exception${input.exceptionReason ? `: ${input.exceptionReason}` : ""}`;
    case "BOOKED":
    case "CLOSED":
    case "REJECTED":
      return "None";
  }
}

// ---------------------------------------------------------------------------
// Appointment operations: the booking sub-flow. Business state only; the
// connector execution behind a step lives on executions.
// ---------------------------------------------------------------------------

/** An availability snapshot older than this cannot be selected or booked. */
export const AVAILABILITY_FRESH_SECONDS = 600;
/** A hold with less time left than this is not submitted for booking. */
export const HOLD_SUBMISSION_MARGIN_SECONDS = 15;
/** Hold duration ACCESS asks for; the destination's expiry is authoritative. */
export const DEFAULT_HOLD_TTL_SECONDS = 300;

export function availabilityIsFresh(
  observedAt: Date | null,
  now: Date = new Date(),
): boolean {
  return (
    observedAt !== null &&
    now.getTime() - observedAt.getTime() <= AVAILABILITY_FRESH_SECONDS * 1000
  );
}
export function holdIsUsable(expiresAt: Date, now: Date = new Date()): boolean {
  return (
    expiresAt.getTime() - now.getTime() > HOLD_SUBMISSION_MARGIN_SECONDS * 1000
  );
}

const bookingFlow: Record<
  AppointmentWorkflowStatus,
  readonly AppointmentWorkflowStatus[]
> = {
  AVAILABILITY_REQUESTED: [
    "AVAILABILITY_RETURNED",
    "NO_AVAILABILITY",
    "AVAILABILITY_REQUESTED",
    "WITHDRAWN",
  ],
  AVAILABILITY_RETURNED: [
    "AVAILABILITY_REQUESTED",
    "SLOT_SELECTED",
    "WITHDRAWN",
  ],
  NO_AVAILABILITY: ["AVAILABILITY_REQUESTED", "WITHDRAWN"],
  SLOT_SELECTED: [
    "AVAILABILITY_REQUESTED",
    "SLOT_SELECTED",
    "HOLD_REQUESTED",
    "BOOKING_SUBMITTED",
    "WITHDRAWN",
  ],
  // A refused hold returns to selection; a taken slot back to availability.
  HOLD_REQUESTED: ["HELD", "SLOT_SELECTED", "AVAILABILITY_RETURNED"],
  HELD: [
    "AVAILABILITY_REQUESTED",
    "SLOT_SELECTED",
    "BOOKING_SUBMITTED",
    "WITHDRAWN",
  ],
  // Refusal: choose again. Confirmed not committed: resubmit or re-hold.
  BOOKING_SUBMITTED: [
    "COMMITTED",
    "REPLACEMENT_BOOKED",
    "AVAILABILITY_RETURNED",
    "SLOT_SELECTED",
    "HELD",
  ],
  // Committed at the destination; BOOKED only once it is read back there.
  COMMITTED: ["BOOKED"],
  BOOKED: [],
  REPLACEMENT_BOOKED: ["ORIGINAL_CANCELLATION_PENDING"],
  ORIGINAL_CANCELLATION_PENDING: ["COMPLETED"],
  COMPLETED: [],
  CANCELLATION_REQUESTED: ["CANCELLATION_SUBMITTED", "WITHDRAWN"],
  CANCELLATION_SUBMITTED: ["CANCELLED", "CANCELLATION_REQUESTED"],
  CANCELLED: [],
  WITHDRAWN: [],
};
export const BOOKING_FLOW = bookingFlow;
const flowStatuses: Record<string, readonly AppointmentWorkflowStatus[]> = {
  APPOINTMENT_REQUEST: [
    "AVAILABILITY_REQUESTED",
    "AVAILABILITY_RETURNED",
    "NO_AVAILABILITY",
    "SLOT_SELECTED",
    "HOLD_REQUESTED",
    "HELD",
    "BOOKING_SUBMITTED",
    "COMMITTED",
    "BOOKED",
    "WITHDRAWN",
  ],
  RESCHEDULING_REQUEST: [
    "AVAILABILITY_REQUESTED",
    "AVAILABILITY_RETURNED",
    "NO_AVAILABILITY",
    "SLOT_SELECTED",
    "HOLD_REQUESTED",
    "HELD",
    "BOOKING_SUBMITTED",
    "REPLACEMENT_BOOKED",
    "ORIGINAL_CANCELLATION_PENDING",
    "COMPLETED",
    "WITHDRAWN",
  ],
  CANCELLATION_REQUEST: [
    "CANCELLATION_REQUESTED",
    "CANCELLATION_SUBMITTED",
    "CANCELLED",
    "WITHDRAWN",
  ],
};
export class InvalidWorkflowStepError extends Error {
  readonly statusCode = 409;
  readonly code = "INVALID_BOOKING_STEP";
  constructor(from: string, to: string) {
    super(`booking step ${from} -> ${to} is not permitted`);
  }
}
/** Enforce the booking sub-flow for the request's case type. */
export function workflowStep(
  caseType: string,
  from: AppointmentWorkflowStatus,
  to: AppointmentWorkflowStatus,
): AppointmentWorkflowStatus {
  if (!flowStatuses[caseType]?.includes(to) || !bookingFlow[from].includes(to))
    throw new InvalidWorkflowStepError(from, to);
  return to;
}
export function canWorkflowStep(
  caseType: string,
  from: AppointmentWorkflowStatus,
  to: AppointmentWorkflowStatus,
): boolean {
  return Boolean(
    flowStatuses[caseType]?.includes(to) && bookingFlow[from].includes(to),
  );
}
/** The request is finished: nothing further can happen to it. */
export function workflowFinished(status: AppointmentWorkflowStatus): boolean {
  return bookingFlow[status].length === 0;
}

/**
 * Destination refusals after which staff simply choose again: the slot was
 * taken or went stale, or the hold lapsed. Any other refusal needs a person.
 */
export const RESELECT_REFUSALS = [
  "SLOT_UNAVAILABLE",
  "HOLD_EXPIRED",
  "HOLD_NOT_FOUND",
] as const;
export function refusalIsRecoverable(code: string): boolean {
  return (RESELECT_REFUSALS as readonly string[]).includes(code);
}

/** Why a referral may or may not start automated booking. */
export function bookingEligibility(input: {
  caseType: string;
  state: CaseState;
  openWorkKinds: readonly string[];
  unmetPrerequisites: readonly string[];
  activeRequest: boolean;
}): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.caseType !== "REFERRAL") reasons.push("NOT_A_REFERRAL");
  if (!["READY_FOR_BOOKING", "WAITING"].includes(input.state))
    reasons.push("NOT_READY_FOR_BOOKING");
  if (input.openWorkKinds.some((k) => k === "SAFETY" || k === "FILE_SAFETY"))
    reasons.push("SAFETY_REVIEW_OPEN");
  if (input.unmetPrerequisites.length)
    reasons.push(
      `BOOKING_PREREQUISITES_UNMET:${[...input.unmetPrerequisites].join(",")}`,
    );
  if (input.activeRequest) reasons.push("BOOKING_ALREADY_ACTIVE");
  return { eligible: reasons.length === 0, reasons };
}

/** Plain-language next step for an appointment operations case. */
export function appointmentNextAction(input: {
  caseType: string;
  state: CaseState;
  workflowStatus: AppointmentWorkflowStatus;
  exceptionReason?: string | null;
  confirmationStatus?: "UNCONFIRMED" | "CONFIRMED" | null;
}): string {
  if (input.state === "EXCEPTION") {
    const reason = input.exceptionReason ?? "";
    if (/both_appointments|original_already_cancelled/.test(reason))
      return "Check the destination system: the original and the new appointment may both exist";
    if (reason.endsWith("_outcome_unknown"))
      return "Check the destination system: it has not confirmed whether the last step happened";
    if (/_not_verified|_verification_not_planned/.test(reason))
      return "Check the destination system for the booked appointment, then ask ACCESS to check again";
    if (reason.startsWith("availability_unavailable"))
      return "Search again, or withdraw and book by hand";
    if (reason.startsWith("booking_refused"))
      return "Choose another slot, or withdraw and book by hand";
    if (reason.startsWith("cancellation_refused"))
      return "Check the destination system, then submit the cancellation again or withdraw";
    return `Resolve exception${reason ? `: ${reason}` : ""}`;
  }
  switch (input.workflowStatus) {
    case "AVAILABILITY_REQUESTED":
      return "Searching the destination for appointments (automated)";
    case "AVAILABILITY_RETURNED":
      return "Choose an appointment slot";
    case "NO_AVAILABILITY":
      return "No appointments found: widen the search or search again";
    case "SLOT_SELECTED":
      return "Hold the slot or book it";
    case "HOLD_REQUESTED":
      return "Holding the slot (automated)";
    case "HELD":
      return "Book the held slot before the hold expires";
    case "BOOKING_SUBMITTED":
      return input.caseType === "RESCHEDULING_REQUEST"
        ? "Replacement submitted; awaiting destination confirmation (automated)"
        : "Booking submitted; awaiting destination confirmation (automated)";
    case "COMMITTED":
      return "Booking committed; verifying it with the destination (automated)";
    case "BOOKED":
      return input.confirmationStatus === "CONFIRMED"
        ? "None"
        : "Confirm the appointment with the patient";
    case "REPLACEMENT_BOOKED":
      return "Verifying the replacement appointment (automated)";
    case "ORIGINAL_CANCELLATION_PENDING":
      return "Cancelling the original appointment (automated)";
    case "CANCELLATION_REQUESTED":
      return "Commit the cancellation";
    case "CANCELLATION_SUBMITTED":
      return "Cancellation submitted; awaiting destination confirmation (automated)";
    case "COMPLETED":
    case "CANCELLED":
    case "WITHDRAWN":
      return "None";
  }
}

export const ACCESS_STATUSES = [
  "REFERRAL_IN_PROGRESS",
  "REFERRAL_COMPLETE",
  "READY_FOR_BOOKING",
  "SEARCHING",
  "SLOT_SELECTED",
  "BOOKED",
  "CONFIRMED",
  "RESCHEDULE_IN_PROGRESS",
  "CANCELLATION_IN_PROGRESS",
  "CANCELLED",
  "CLOSED",
  "NEEDS_ATTENTION",
] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];
export const ACCESS_STATUS_LABELS: Record<AccessStatus, string> = {
  REFERRAL_IN_PROGRESS: "Referral in progress",
  REFERRAL_COMPLETE: "Referral complete",
  READY_FOR_BOOKING: "Ready for booking",
  SEARCHING: "Searching for appointment",
  SLOT_SELECTED: "Slot selected / awaiting commit",
  BOOKED: "Booked",
  CONFIRMED: "Confirmed",
  RESCHEDULE_IN_PROGRESS: "Reschedule in progress",
  CANCELLATION_IN_PROGRESS: "Cancellation in progress",
  CANCELLED: "Cancelled",
  CLOSED: "Closed",
  NEEDS_ATTENTION: "Needs staff attention",
};
const ATTENTION_WORK = [
  "SAFETY",
  "FILE_SAFETY",
  "CONNECTOR",
  "MANUAL_DESTINATION",
  "OUTCOME_REVIEW",
];

/**
 * "What is happening with this referral/appointment?" from authoritative
 * state only: the referral case, its active appointment operations request
 * and its appointments. Deterministic; never generated.
 */
export function patientAccessStatus(input: {
  referralState: CaseState;
  referralResolution: ResolutionCode | null;
  openWorkKinds: readonly string[];
  activeRequest: {
    caseType: string;
    state: CaseState;
    workflowStatus: AppointmentWorkflowStatus;
  } | null;
  appointments: readonly {
    status: "BOOKED" | "CANCELLED" | "SUPERSEDED";
    confirmationStatus: "UNCONFIRMED" | "CONFIRMED";
  }[];
}): { status: AccessStatus; label: string } {
  const out = (status: AccessStatus) => ({
    status,
    label:
      status === "CLOSED" && input.referralResolution
        ? `Closed: ${input.referralResolution}`
        : ACCESS_STATUS_LABELS[status],
  });
  const request = input.activeRequest;
  if (
    input.referralState === "EXCEPTION" ||
    request?.state === "EXCEPTION" ||
    input.openWorkKinds.some((k) => ATTENTION_WORK.includes(k))
  )
    return out("NEEDS_ATTENTION");
  if (request) {
    if (request.caseType === "RESCHEDULING_REQUEST")
      return out("RESCHEDULE_IN_PROGRESS");
    if (request.caseType === "CANCELLATION_REQUEST")
      return out("CANCELLATION_IN_PROGRESS");
    return out(
      [
        "AVAILABILITY_REQUESTED",
        "AVAILABILITY_RETURNED",
        "NO_AVAILABILITY",
      ].includes(request.workflowStatus)
        ? "SEARCHING"
        : "SLOT_SELECTED",
    );
  }
  const booked = input.appointments.filter((a) => a.status === "BOOKED");
  if (booked.length)
    return out(
      booked.every((a) => a.confirmationStatus === "CONFIRMED")
        ? "CONFIRMED"
        : "BOOKED",
    );
  if (input.appointments.some((a) => a.status === "CANCELLED"))
    return out("CANCELLED");
  switch (input.referralState) {
    case "BOOKED":
      return out("BOOKED");
    case "CLOSED":
    case "REJECTED":
      return out("CLOSED");
    case "READY_FOR_BOOKING":
    case "WAITING":
      return out("READY_FOR_BOOKING");
    case "READY":
    case "DESTINATION_PENDING":
      return out("REFERRAL_COMPLETE");
    default:
      return out("REFERRAL_IN_PROGRESS");
  }
}

/** Mapping used by migration 0003 to backfill legacy referral states. */
export const LEGACY_STATE_MAP: Record<string, CaseState> = {
  RECEIVED: "RECEIVED",
  IDENTITY_PENDING: "IDENTITY_PENDING",
  ADMIN_PENDING: "INFORMATION_MISSING",
  READY: "READY",
  DISPATCH_PENDING: "DESTINATION_PENDING",
  RECONCILING: "DESTINATION_PENDING",
  COMPLETED: "READY_FOR_BOOKING",
  EXCEPTION: "EXCEPTION",
  REJECTED: "REJECTED",
};
