import { describe, expect, it } from "vitest";
import {
  CASE_TYPES,
  OPERATIONS,
  STAFF_ROLES,
} from "../../packages/contracts/src/index.js";
import {
  CaseTypeNotCreatableError,
  appointmentPermission,
  assertCaseTypeEnabled,
  assertDirectlyCreatable,
  authorizeOperation,
  can,
  evaluateAction,
  evaluateAppointmentOperation,
} from "../../packages/policy/src/index.js";

describe("workforce authorisation", () => {
  it("READ_ONLY can read but never act", () => {
    expect(can("READ_ONLY", "case.read")).toBe(true);
    expect(can("READ_ONLY", "case.read_patient_details")).toBe(false);
    expect(can("READ_ONLY", "case.action.record_booking")).toBe(false);
    expect(can("READ_ONLY", "referral.ingest")).toBe(false);
  });
  it("only managers correct outcomes or import; only admins manage rules and members", () => {
    expect(can("REFERRAL_COORDINATOR", "case.action.correct_outcome")).toBe(
      false,
    );
    expect(can("PRACTICE_MANAGER", "case.action.correct_outcome")).toBe(true);
    expect(can("PRACTICE_MANAGER", "observation.import")).toBe(true);
    for (const role of STAFF_ROLES)
      expect(can(role, "rule_set.write")).toBe(role === "ADMIN");
    for (const role of STAFF_ROLES)
      expect(can(role, "membership.manage")).toBe(role === "ADMIN");
  });
  it("coordinators book and confirm; only managers and admins reschedule or cancel", () => {
    const grid = Object.fromEntries(
      STAFF_ROLES.map((role) => [
        role,
        (
          [
            "case.action.start_booking",
            "appointment.book",
            "appointment.confirm",
            "appointment.reschedule",
            "appointment.cancel",
          ] as const
        ).filter((p) => can(role, p)),
      ]),
    );
    expect(grid).toEqual({
      ADMIN: [
        "case.action.start_booking",
        "appointment.book",
        "appointment.confirm",
        "appointment.reschedule",
        "appointment.cancel",
      ],
      PRACTICE_MANAGER: [
        "case.action.start_booking",
        "appointment.book",
        "appointment.confirm",
        "appointment.reschedule",
        "appointment.cancel",
      ],
      REFERRAL_COORDINATOR: [
        "case.action.start_booking",
        "appointment.book",
        "appointment.confirm",
      ],
      READ_ONLY: [],
    });
    expect(appointmentPermission("APPOINTMENT_REQUEST")).toBe(
      "appointment.book",
    );
    expect(appointmentPermission("RESCHEDULING_REQUEST")).toBe(
      "appointment.reschedule",
    );
    expect(appointmentPermission("CANCELLATION_REQUEST")).toBe(
      "appointment.cancel",
    );
    expect(() => appointmentPermission("REFERRAL")).toThrow();
  });
});

describe("case types and operations", () => {
  it("referrals and the three appointment operations types execute; the rest fail closed", () => {
    const enabled = CASE_TYPES.filter((type) => {
      try {
        assertCaseTypeEnabled(type);
        return true;
      } catch {
        return false;
      }
    });
    expect(enabled).toEqual([
      "REFERRAL",
      "APPOINTMENT_REQUEST",
      "CANCELLATION_REQUEST",
      "RESCHEDULING_REQUEST",
    ]);
    for (const type of ["STATUS_ENQUIRY", "MISSING_INFORMATION"])
      expect(() => assertCaseTypeEnabled(type)).toThrow(/not enabled/);
  });
  it("only referrals are created directly", () => {
    expect(() => assertDirectlyCreatable("REFERRAL")).not.toThrow();
    for (const type of [
      "APPOINTMENT_REQUEST",
      "CANCELLATION_REQUEST",
      "RESCHEDULING_REQUEST",
    ])
      expect(() => assertDirectlyCreatable(type)).toThrow(
        CaseTypeNotCreatableError,
      );
    expect(() => assertDirectlyCreatable("STATUS_ENQUIRY")).toThrow(
      /not enabled/,
    );
  });
  it("a case type cannot authorise another case type's operation", () => {
    expect(authorizeOperation("REFERRAL", "referral.create")).toMatchObject({
      allowed: true,
      capability: "referral.create",
      consequential: true,
    });
    expect(
      authorizeOperation("APPOINTMENT_REQUEST", "appointment.create"),
    ).toMatchObject({ allowed: true, consequential: true });
    const refused: [string, string][] = [
      ["REFERRAL", "appointment.create"],
      ["APPOINTMENT_REQUEST", "appointment.cancel"],
      ["APPOINTMENT_REQUEST", "appointment.reschedule"],
      ["APPOINTMENT_REQUEST", "appointment.reschedule.cancel_original"],
      ["CANCELLATION_REQUEST", "appointment.create"],
      ["CANCELLATION_REQUEST", "appointment.hold"],
      ["CANCELLATION_REQUEST", "appointment.availability.read"],
      ["RESCHEDULING_REQUEST", "appointment.cancel"],
      ["RESCHEDULING_REQUEST", "appointment.create"],
      ["REFERRAL", "appointment.availability.read"],
    ];
    for (const [caseType, operation] of refused)
      expect(
        authorizeOperation(caseType, operation),
        `${caseType} ${operation}`,
      ).toEqual({
        allowed: false,
        code: "OPERATION_NOT_PERMITTED_FOR_CASE_TYPE",
      });
    expect(authorizeOperation("STATUS_ENQUIRY", "appointment.create")).toEqual({
      allowed: false,
      code: "CASE_TYPE_DISABLED",
    });
    expect(authorizeOperation("REFERRAL", "patient.merge")).toEqual({
      allowed: false,
      code: "UNKNOWN_OPERATION",
    });
  });
  it("every consequential appointment operation belongs to its own case type", () => {
    const owners: Record<string, string[]> = {};
    for (const [operation, spec] of Object.entries(OPERATIONS))
      if (spec.consequential && operation !== "referral.create")
        owners[operation] = [...spec.caseTypes];
    expect(owners).toEqual({
      "appointment.hold": ["APPOINTMENT_REQUEST", "RESCHEDULING_REQUEST"],
      "appointment.create": ["APPOINTMENT_REQUEST"],
      "appointment.cancel": ["CANCELLATION_REQUEST"],
      "appointment.reschedule": ["RESCHEDULING_REQUEST"],
      "appointment.reschedule.cancel_original": ["RESCHEDULING_REQUEST"],
    });
    for (const read of [
      "appointment.availability.read",
      "appointment.verify",
      "appointment.hold.release",
    ])
      expect(
        OPERATIONS[read as keyof typeof OPERATIONS].consequential,
        read,
      ).toBe(false);
  });
  it("appointment policy is versioned and denies unbound or unready operations", () => {
    expect(
      evaluateAppointmentOperation({
        caseType: "APPOINTMENT_REQUEST",
        operation: "appointment.create",
        ready: true,
      }),
    ).toMatchObject({
      effect: "ALLOW",
      policyVersion: "appointment-policy.v1",
    });
    expect(
      evaluateAppointmentOperation({
        caseType: "APPOINTMENT_REQUEST",
        operation: "appointment.create",
        ready: false,
        reason: "REFERRAL_NOT_BOOKABLE",
      }),
    ).toMatchObject({ effect: "DENY", reason: "REFERRAL_NOT_BOOKABLE" });
    expect(
      evaluateAppointmentOperation({
        caseType: "CANCELLATION_REQUEST",
        operation: "appointment.create",
        ready: true,
      }),
    ).toMatchObject({
      effect: "DENY",
      reason: "OPERATION_NOT_PERMITTED_FOR_CASE_TYPE",
    });
  });
  it("action policy denies unready referrals", () => {
    expect(
      evaluateAction({
        caseType: "REFERRAL",
        action: "referral.create",
        ready: false,
      }).effect,
    ).toBe("DENY");
    expect(
      evaluateAction({
        caseType: "REFERRAL",
        action: "referral.create",
        ready: true,
      }).effect,
    ).toBe("ALLOW");
  });
});
