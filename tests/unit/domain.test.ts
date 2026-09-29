import { describe, expect, it } from "vitest";
import {
  CASE_STATES,
  TERMINAL_CASE_STATES,
} from "../../packages/contracts/src/index.js";
import {
  CASE_TRANSITIONS,
  LEGACY_STATE_MAP,
  canTransition,
  isTerminal,
  nextRequiredAction,
  planObservation,
  terminalOutcome,
  transition,
} from "../../packages/domain/src/index.js";

const t0 = new Date("2026-01-01T10:00:00Z");
const later = new Date("2026-01-02T10:00:00Z");

describe("case lifecycle", () => {
  it("destination success leads to READY_FOR_BOOKING, never to a terminal state", () => {
    expect(CASE_TRANSITIONS.DESTINATION_PENDING).toEqual([
      "READY_FOR_BOOKING",
      "EXCEPTION",
    ]);
    expect(canTransition("DESTINATION_PENDING", "BOOKED")).toBe(false);
    expect(canTransition("DESTINATION_PENDING", "CLOSED")).toBe(false);
  });
  it.each([
    ["RECEIVED", "BOOKED"],
    ["REJECTED", "READY"],
    ["BOOKED", "READY_FOR_BOOKING"],
    ["CLOSED", "WAITING"],
    ["READY_FOR_BOOKING", "DESTINATION_PENDING"],
    ["INFORMATION_MISSING", "BOOKED"],
  ] as const)("rejects %s -> %s", (from, to) =>
    expect(() => transition(from, to)).toThrow("invalid transition"),
  );
  it("only BOOKED, CLOSED and REJECTED are terminal", () => {
    expect(CASE_STATES.filter(isTerminal)).toEqual([...TERMINAL_CASE_STATES]);
  });
  it("maps every legacy referral state onto a case state", () => {
    expect(LEGACY_STATE_MAP.COMPLETED).toBe("READY_FOR_BOOKING");
    expect(LEGACY_STATE_MAP.RECONCILING).toBe("DESTINATION_PENDING");
    expect(LEGACY_STATE_MAP.ADMIN_PENDING).toBe("INFORMATION_MISSING");
  });
  it("gives an administrative next action, never a clinical one", () => {
    for (const state of CASE_STATES)
      expect(nextRequiredAction({ state })).not.toMatch(
        /diagnos|triage|treat|urgen/i,
      );
  });
});

describe("outcome observations", () => {
  it("closure requires a resolution code", () => {
    expect(terminalOutcome("REFERRAL_CLOSED")).toBeNull();
    expect(terminalOutcome("REFERRAL_CLOSED", "BOOKED")).toBeNull();
    expect(terminalOutcome("REFERRAL_CLOSED", "CANCELLED")).toEqual({
      state: "CLOSED",
      code: "CANCELLED",
    });
    expect(
      planObservation({
        state: "WAITING",
        type: "REFERRAL_CLOSED",
        occurredAt: t0,
      }).disposition,
    ).toBe("REVIEW");
  });
  it("booking completes a bookable case", () =>
    expect(
      planObservation({
        state: "WAITING",
        type: "APPOINTMENT_BOOKED",
        occurredAt: t0,
      }),
    ).toEqual({
      disposition: "APPLIED",
      to: "BOOKED",
      resolution: "BOOKED",
    }));
  it("holds an outcome that arrives before the destination commit", () =>
    expect(
      planObservation({
        state: "DESTINATION_PENDING",
        type: "APPOINTMENT_BOOKED",
        occurredAt: t0,
      }).disposition,
    ).toBe("PENDING"));
  it("never regresses a terminal case: earlier facts are recorded, later conflicts reviewed", () => {
    const booked = { code: "BOOKED" as const, at: later };
    expect(
      planObservation({
        state: "BOOKED",
        type: "PATIENT_UNREACHABLE",
        occurredAt: t0,
        caseOutcome: booked,
      }).disposition,
    ).toBe("RECORDED");
    expect(
      planObservation({
        state: "BOOKED",
        type: "PATIENT_UNREACHABLE",
        occurredAt: new Date("2026-02-01T00:00:00Z"),
        caseOutcome: booked,
      }).disposition,
    ).toBe("REVIEW");
    expect(
      planObservation({
        state: "BOOKED",
        type: "BOOKING_REQUESTED",
        occurredAt: new Date("2026-03-01T00:00:00Z"),
        caseOutcome: booked,
      }).disposition,
    ).toBe("RECORDED");
    const closed = { code: "PATIENT_UNREACHABLE" as const, at: t0 };
    expect(
      planObservation({
        state: "CLOSED",
        type: "APPOINTMENT_BOOKED",
        occurredAt: later,
        caseOutcome: closed,
      }).disposition,
    ).toBe("REVIEW");
    expect(
      planObservation({
        state: "CLOSED",
        type: "PATIENT_UNREACHABLE",
        occurredAt: later,
        caseOutcome: closed,
      }).disposition,
    ).toBe("RECORDED");
  });
  it("external facts never move a case out of EXCEPTION; a staff decision may close it", () => {
    expect(
      planObservation({
        state: "EXCEPTION",
        type: "PATIENT_DECLINED",
        occurredAt: t0,
      }).disposition,
    ).toBe("REVIEW");
    expect(
      planObservation({
        state: "EXCEPTION",
        type: "PATIENT_DECLINED",
        occurredAt: t0,
        authority: "STAFF",
      }).disposition,
    ).toBe("APPLIED");
    expect(
      planObservation({
        state: "EXCEPTION",
        type: "APPOINTMENT_BOOKED",
        occurredAt: t0,
        authority: "STAFF",
      }).disposition,
    ).toBe("REVIEW");
  });
  it("booking requests and cancellations move between bookable states only", () => {
    expect(
      planObservation({
        state: "READY_FOR_BOOKING",
        type: "BOOKING_REQUESTED",
        occurredAt: t0,
      }),
    ).toMatchObject({ to: "WAITING" });
    expect(
      planObservation({
        state: "WAITING",
        type: "APPOINTMENT_CANCELLED",
        occurredAt: t0,
      }),
    ).toMatchObject({ to: "READY_FOR_BOOKING" });
    expect(
      planObservation({
        state: "READY_FOR_BOOKING",
        type: "APPOINTMENT_CANCELLED",
        occurredAt: t0,
      }).disposition,
    ).toBe("RECORDED");
  });
  it("milestones never change state", () => {
    for (const type of [
      "REFERRAL_RECEIVED",
      "REFERRAL_VERIFIED",
      "REFERRAL_READY",
      "DESTINATION_COMMITTED",
    ] as const)
      expect(
        planObservation({ state: "READY_FOR_BOOKING", type, occurredAt: t0 })
          .disposition,
      ).toBe("RECORDED");
  });
});
