import { describe, expect, it } from "vitest";
import { CASE_TYPES, STAFF_ROLES } from "../../packages/contracts/src/index.js";
import {
  assertCaseTypeEnabled,
  authorizeOperation,
  can,
  evaluateAction,
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
});

describe("case types and operations", () => {
  it("only REFERRAL is enabled; every other type fails closed", () => {
    for (const type of CASE_TYPES)
      if (type === "REFERRAL")
        expect(() => assertCaseTypeEnabled(type)).not.toThrow();
      else expect(() => assertCaseTypeEnabled(type)).toThrow(/not enabled/);
  });
  it("only referral.create executes; connectors never write appointments", () => {
    expect(authorizeOperation("REFERRAL", "referral.create")).toMatchObject({
      allowed: true,
      capability: "referral.create",
      consequential: true,
    });
    for (const operation of [
      "appointment.create",
      "appointment.cancel",
      "appointment.reschedule",
      "appointment.hold",
    ])
      for (const type of CASE_TYPES)
        expect(authorizeOperation(type, operation)).toEqual({
          allowed: false,
          code: "UNKNOWN_OPERATION",
        });
    expect(
      authorizeOperation("APPOINTMENT_REQUEST", "referral.create"),
    ).toEqual({ allowed: false, code: "CASE_TYPE_DISABLED" });
    expect(authorizeOperation("REFERRAL", "patient.merge")).toEqual({
      allowed: false,
      code: "UNKNOWN_OPERATION",
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
