import {
  ENABLED_CASE_TYPES,
  OPERATIONS,
  type CaseActionName,
  type CaseType,
  type PracticeRole,
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
  | "membership.manage";

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
  "metrics.read",
  "rule_set.read",
];
const manager: readonly Permission[] = [
  ...coordinator,
  "case.action.correct_outcome",
  "observation.import",
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

// ---------------------------------------------------------------------------
// Practice (scheduling) authorisation. Roles come from verified practice
// membership, server-side, on every request. Booking never implies clinical
// access: receptionists manage schedules and demographics, but referral
// documents (clinical content) are for clinicians and administrators.
// ---------------------------------------------------------------------------

export const PRACTICE_PERMISSIONS = [
  "schedule.read",
  "patient.read",
  "patient.write",
  "patient.duplicates.review",
  "appointment.book",
  "appointment.reschedule",
  "appointment.cancel",
  "appointment.check_in",
  "appointment.progress",
  "appointment.no_show",
  "appointment.notes",
  "appointment.override_availability",
  "schedule.blocks.manage",
  "schedule.exceptions.manage",
  "schedule.hours.manage",
  "configuration.manage",
  "staff.manage",
  "audit.read",
  "waitlist.read",
  "waitlist.manage",
  "referral.read",
  "referral.register",
  "referral.verify",
  "referral.document.read",
  "conversation.manage",
  "notification.read",
  "notification.preferences.manage",
  "integration.manage",
] as const;
export type PracticePermission = (typeof PRACTICE_PERMISSIONS)[number];

const readOnly: readonly PracticePermission[] = ["schedule.read"];
const clinicalStaff: readonly PracticePermission[] = [
  "schedule.read",
  "patient.read",
  "appointment.check_in",
  "appointment.progress",
  "appointment.no_show",
  "appointment.notes",
  "waitlist.read",
  "referral.read",
  "referral.register",
  "referral.verify",
  "referral.document.read",
  "notification.read",
];
const receptionist: readonly PracticePermission[] = [
  "schedule.read",
  "patient.read",
  "patient.write",
  "patient.duplicates.review",
  "appointment.book",
  "appointment.reschedule",
  "appointment.cancel",
  "appointment.check_in",
  "appointment.progress",
  "appointment.no_show",
  "appointment.notes",
  "appointment.override_availability",
  "schedule.blocks.manage",
  "schedule.exceptions.manage",
  "waitlist.read",
  "waitlist.manage",
  "referral.read",
  "referral.register",
  "conversation.manage",
  "notification.read",
  "notification.preferences.manage",
];
const doctor: readonly PracticePermission[] = [
  ...new Set<PracticePermission>([
    ...clinicalStaff,
    "appointment.book",
    "appointment.reschedule",
    "appointment.cancel",
    "appointment.override_availability",
    "schedule.blocks.manage",
    "schedule.exceptions.manage",
    "waitlist.manage",
  ]),
];
const practiceMatrix: Record<PracticeRole, readonly PracticePermission[]> = {
  READ_ONLY: readOnly,
  CLINICAL_STAFF: clinicalStaff,
  RECEPTIONIST: receptionist,
  DOCTOR: doctor,
  PRACTICE_ADMIN: PRACTICE_PERMISSIONS,
};
export function practiceCan(
  role: PracticeRole,
  permission: PracticePermission,
): boolean {
  return practiceMatrix[role].includes(permission);
}
export function practicePermissions(
  role: PracticeRole,
): readonly PracticePermission[] {
  return practiceMatrix[role];
}
export function authorizePractice(
  role: PracticeRole,
  permission: PracticePermission,
): void {
  if (!practiceCan(role, permission))
    throw new ForbiddenError(`role ${role} lacks ${permission}`);
}
/**
 * Doctors manage only their own time (the practitioner their login is linked
 * to); administrators and receptionists manage everyone's.
 */
export function assertOwnSchedule(
  role: PracticeRole,
  linkedPractitionerId: string | null,
  practitionerId: string,
): void {
  if (role === "DOCTOR" && linkedPractitionerId !== practitionerId)
    throw new ForbiddenError("doctors manage only their own schedule");
}
