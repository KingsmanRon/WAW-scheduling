import {
  ENABLED_CASE_TYPES,
  OPERATIONS,
  type CaseActionName,
  type CaseType,
  type StaffRole,
} from "@access/contracts";

/**
 * Server-side workforce authorisation. Roles come from verified organisation
 * membership, never from the browser. None of these permissions authorise a
 * clinical decision: ACCESS has no clinical action to grant.
 */
export type Permission =
  | "case.read"
  | "case.read_patient_details"
  | "referral.ingest"
  | "case.interaction"
  | `case.action.${CaseActionName}`
  | "observation.import"
  | "metrics.read"
  | "rule_set.read"
  | "rule_set.write"
  | "membership.manage"
  // Appointment operations. Each case type's steps need its permission.
  | "appointment.book"
  | "appointment.confirm"
  | "appointment.reschedule"
  | "appointment.cancel";

const coordinator: readonly Permission[] = [
  "case.read",
  "case.read_patient_details",
  "referral.ingest",
  "case.interaction",
  "case.action.confirm_identity",
  "case.action.provide_information",
  "case.action.resolve_exception",
  "case.action.record_destination_reference",
  "case.action.record_follow_up",
  "case.action.record_booking",
  "case.action.record_patient_unreachable",
  "case.action.record_patient_declined",
  "case.action.record_provider_declined",
  "case.action.close",
  "case.action.reject",
  "case.action.start_booking",
  "appointment.book",
  "appointment.confirm",
  "metrics.read",
  "rule_set.read",
];
/**
 * Rescheduling and cancellation remove a committed appointment from the
 * destination, so they sit with the manager role (as outcome corrections do).
 */
const manager: readonly Permission[] = [
  ...coordinator,
  "case.action.correct_outcome",
  "observation.import",
  "appointment.reschedule",
  "appointment.cancel",
];
const matrix: Record<StaffRole, readonly Permission[]> = {
  READ_ONLY: ["case.read", "metrics.read", "rule_set.read"],
  REFERRAL_COORDINATOR: coordinator,
  PRACTICE_MANAGER: manager,
  ADMIN: [...manager, "rule_set.write", "membership.manage"],
};
export function can(role: StaffRole, permission: Permission): boolean {
  return matrix[role].includes(permission);
}
export class ForbiddenError extends Error {
  readonly statusCode = 403;
  readonly code = "FORBIDDEN";
}
export function authorize(role: StaffRole, permission: Permission): void {
  if (!can(role, permission))
    throw new ForbiddenError(`role ${role} lacks ${permission}`);
}

export class CaseTypeDisabledError extends Error {
  readonly statusCode = 422;
  readonly code = "CASE_TYPE_DISABLED";
  constructor(caseType: string) {
    super(`case type ${caseType} is not enabled`);
  }
}
/** Fail closed for every case type other than those enabled in this release. */
export function assertCaseTypeEnabled(
  caseType: string,
): asserts caseType is CaseType {
  if (!ENABLED_CASE_TYPES.includes(caseType as CaseType))
    throw new CaseTypeDisabledError(caseType);
}

export type OperationDecision =
  | { allowed: true; capability: string; consequential: boolean }
  | {
      allowed: false;
      code:
        | "UNKNOWN_OPERATION"
        | "CASE_TYPE_DISABLED"
        | "OPERATION_NOT_PERMITTED_FOR_CASE_TYPE";
    };
/**
 * A case type may only authorise the operations registered for it, and only
 * enabled case types may authorise anything.
 */
export function authorizeOperation(
  caseType: string,
  operation: string,
): OperationDecision {
  const spec = (
    OPERATIONS as Record<string, (typeof OPERATIONS)[keyof typeof OPERATIONS]>
  )[operation];
  if (!spec) return { allowed: false, code: "UNKNOWN_OPERATION" };
  if (!ENABLED_CASE_TYPES.includes(caseType as CaseType))
    return { allowed: false, code: "CASE_TYPE_DISABLED" };
  if (!(spec.caseTypes as readonly string[]).includes(caseType))
    return { allowed: false, code: "OPERATION_NOT_PERMITTED_FOR_CASE_TYPE" };
  return {
    allowed: true,
    capability: spec.capability,
    consequential: spec.consequential,
  };
}

/** Permission needed for the steps of an appointment operations case. */
export function appointmentPermission(
  caseType: string,
): "appointment.book" | "appointment.reschedule" | "appointment.cancel" {
  switch (caseType) {
    case "APPOINTMENT_REQUEST":
      return "appointment.book";
    case "RESCHEDULING_REQUEST":
      return "appointment.reschedule";
    case "CANCELLATION_REQUEST":
      return "appointment.cancel";
    default:
      throw new CaseTypeDisabledError(caseType);
  }
}

export class CaseTypeNotCreatableError extends Error {
  readonly statusCode = 422;
  readonly code = "CASE_TYPE_NOT_CREATABLE";
  constructor(caseType: string) {
    super(
      caseType === "APPOINTMENT_REQUEST"
        ? "an appointment request starts from a referral that is ready for booking"
        : `a ${caseType} starts from a committed appointment`,
    );
  }
}
/**
 * Only referrals are created directly. Appointment operations cases start
 * from an eligible referral or a committed appointment.
 */
export function assertDirectlyCreatable(caseType: string): void {
  assertCaseTypeEnabled(caseType);
  if (caseType !== "REFERRAL") throw new CaseTypeNotCreatableError(caseType);
}

export type AppointmentDecision = {
  effect: "ALLOW" | "DENY";
  policyVersion: "appointment-policy.v1";
  operation: string;
  reason: string;
};
/**
 * Policy for an appointment operation, evaluated (and recorded in evidence)
 * before its outbox row is written: the case type must be enabled and bound
 * to the operation, and the administrative preconditions must hold.
 */
export function evaluateAppointmentOperation(input: {
  caseType: string;
  operation: string;
  ready: boolean;
  reason?: string;
}): AppointmentDecision {
  const op = authorizeOperation(input.caseType, input.operation);
  const base = {
    policyVersion: "appointment-policy.v1" as const,
    operation: input.operation,
  };
  if (!op.allowed) return { ...base, effect: "DENY", reason: op.code };
  if (!input.ready)
    return {
      ...base,
      effect: "DENY",
      reason: input.reason ?? "preconditions unmet",
    };
  return {
    ...base,
    effect: "ALLOW",
    reason: "administrative appointment operation permitted",
  };
}

export type Decision = {
  effect: "ALLOW" | "DENY";
  policyVersion: "action-policy.v2";
  reason: string;
};
/**
 * Administrative action policy for automated referral creation. Rule
 * evaluation decides readiness; this adds the case-type/operation binding.
 */
export function evaluateAction(input: {
  caseType: string;
  action: string;
  ready: boolean;
}): Decision {
  const op = authorizeOperation(input.caseType, input.action);
  if (!op.allowed)
    return {
      effect: "DENY",
      policyVersion: "action-policy.v2",
      reason: op.code,
    };
  if (!input.ready)
    return {
      effect: "DENY",
      policyVersion: "action-policy.v2",
      reason: "administrative requirements unmet",
    };
  return {
    effect: "ALLOW",
    policyVersion: "action-policy.v2",
    reason: "administrative referral creation permitted",
  };
}
