import {
  TERMINAL_CASE_STATES,
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
export class InvalidTransitionError extends Error {
  readonly statusCode = 409;
  readonly code = "INVALID_TRANSITION";
  constructor(from: CaseState, to: CaseState) {
    super(`invalid transition ${from} -> ${to}`);
  }
}
export function transition(from: CaseState, to: CaseState): CaseState {
  if (!allowed[from].includes(to)) throw new InvalidTransitionError(from, to);
  return to;
}
export function canTransition(from: CaseState, to: CaseState): boolean {
  return allowed[from].includes(to);
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
