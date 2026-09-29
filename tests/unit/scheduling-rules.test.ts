import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_TRANSITIONS,
  OCCUPYING_STATUSES,
  SchedulingError,
  assertActionTiming,
  assertBookingEligibility,
  assertPatientChangeAllowed,
  assertTransition,
  canTransition,
  isValidTimezone,
  isoWeekday,
  localDateOf,
  localDatesBetween,
  localMinuteOf,
  wallClockToInstant,
  type EligibilityInput,
  type ReferralFacts,
} from "../../packages/scheduling/src/index.js";

const code = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    if (e instanceof SchedulingError) return e.code;
    throw e;
  }
};

describe("appointment state machine", () => {
  it("allows exactly the listed transitions", () => {
    const allowed = new Set([
      "HELD>CONFIRMED",
      "HELD>EXPIRED",
      "HELD>CANCELLED",
      "CONFIRMED>CHECKED_IN",
      "CONFIRMED>CANCELLED",
      "CONFIRMED>NO_SHOW",
      "CONFIRMED>RESCHEDULED",
      "CHECKED_IN>IN_PROGRESS",
      "CHECKED_IN>COMPLETED",
      "CHECKED_IN>CANCELLED",
      "IN_PROGRESS>COMPLETED",
      "NO_SHOW>CHECKED_IN",
    ]);
    for (const from of APPOINTMENT_STATUSES)
      for (const to of APPOINTMENT_STATUSES)
        expect(canTransition(from, to), `${from}>${to}`).toBe(
          allowed.has(`${from}>${to}`),
        );
  });

  it("makes completed, cancelled, rescheduled and expired final", () => {
    for (const s of [
      "COMPLETED",
      "CANCELLED",
      "RESCHEDULED",
      "EXPIRED",
    ] as const)
      expect(APPOINTMENT_TRANSITIONS[s]).toEqual([]);
    expect(code(() => assertTransition("CANCELLED", "CONFIRMED"))).toBe(
      "INVALID_TRANSITION",
    );
  });

  it("treats only time-consuming statuses as occupying", () => {
    expect([...OCCUPYING_STATUSES].sort()).toEqual(
      ["CHECKED_IN", "COMPLETED", "CONFIRMED", "HELD", "IN_PROGRESS"].sort(),
    );
  });

  it("checks in only on the appointment's local day and no-shows only after the start", () => {
    const tz = "Africa/Johannesburg";
    const startsAt = new Date("2026-10-05T07:00:00Z"); // 09:00 local
    const base = { from: "CONFIRMED" as const, startsAt, timezone: tz };
    // 23:30 UTC the day before is 01:30 local on the day itself.
    expect(
      code(() =>
        assertActionTiming({
          ...base,
          action: "check_in",
          now: new Date("2026-10-04T23:30:00Z"),
        }),
      ),
    ).toBeUndefined();
    expect(
      code(() =>
        assertActionTiming({
          ...base,
          action: "check_in",
          now: new Date("2026-10-04T21:00:00Z"),
        }),
      ),
    ).toBe("CHECK_IN_WRONG_DAY");
    expect(
      code(() =>
        assertActionTiming({
          ...base,
          action: "no_show",
          now: new Date("2026-10-05T06:59:00Z"),
        }),
      ),
    ).toBe("TRANSITION_TOO_EARLY");
    expect(
      code(() =>
        assertActionTiming({
          ...base,
          action: "no_show",
          now: new Date("2026-10-05T07:20:00Z"),
        }),
      ),
    ).toBeUndefined();
    // A late arrival after a no-show is a check-in on the same day.
    expect(
      code(() =>
        assertActionTiming({
          ...base,
          from: "NO_SHOW",
          action: "check_in",
          now: new Date("2026-10-05T08:00:00Z"),
        }),
      ),
    ).toBeUndefined();
    expect(
      code(() =>
        assertActionTiming({
          ...base,
          action: "complete",
          now: new Date("2026-10-05T08:00:00Z"),
        }),
      ),
    ).toBe("INVALID_TRANSITION");
  });
});

describe("booking eligibility", () => {
  const eligible = (
    over: Partial<EligibilityInput> = {},
  ): EligibilityInput => ({
    actor: "STAFF",
    appointmentType: {
      active: true,
      requiresReferral: false,
      newPatientAllowed: true,
      followUpOnly: false,
      patientBookable: true,
      allowsPractitioner: true,
      allowsLocation: true,
    },
    practitioner: { active: true, bookableByPatients: true },
    location: { active: true },
    patient: {
      active: true,
      hasCompletedAppointment: false,
      hasCompletedWithPractitioner: false,
    },
    appointmentDate: "2026-10-05",
    referral: null,
    referralVerificationRequired: true,
    ...over,
  });
  const referral: ReferralFacts = {
    patientMatches: true,
    status: "VERIFIED",
    appointmentTypeMatches: null,
    validUntil: "2026-12-31",
    maxAppointments: null,
    appointmentsUsed: 0,
  };
  const type = eligible().appointmentType;

  it("accepts an eligible booking", () => {
    expect(code(() => assertBookingEligibility(eligible()))).toBeUndefined();
  });

  it("refuses inactive or disallowed configuration", () => {
    expect(
      code(() =>
        assertBookingEligibility(
          eligible({ appointmentType: { ...type, active: false } }),
        ),
      ),
    ).toBe("APPOINTMENT_TYPE_INACTIVE");
    expect(
      code(() =>
        assertBookingEligibility(
          eligible({
            practitioner: { active: false, bookableByPatients: true },
          }),
        ),
      ),
    ).toBe("PRACTITIONER_INACTIVE");
    expect(
      code(() =>
        assertBookingEligibility(eligible({ location: { active: false } })),
      ),
    ).toBe("LOCATION_INACTIVE");
    expect(
      code(() =>
        assertBookingEligibility(
          eligible({ appointmentType: { ...type, allowsPractitioner: false } }),
        ),
      ),
    ).toBe("PRACTITIONER_NOT_ALLOWED");
    expect(
      code(() =>
        assertBookingEligibility(
          eligible({ appointmentType: { ...type, allowsLocation: false } }),
        ),
      ),
    ).toBe("LOCATION_NOT_ALLOWED");
  });

  it("limits patient self-service to patient-bookable types and practitioners", () => {
    const staffOnly = { ...type, patientBookable: false };
    expect(
      code(() =>
        assertBookingEligibility(
          eligible({ actor: "PATIENT", appointmentType: staffOnly }),
        ),
      ),
    ).toBe("CHANNEL_NOT_PERMITTED");
    expect(
      code(() =>
        assertBookingEligibility(
          eligible({
            actor: "PATIENT",
            practitioner: { active: true, bookableByPatients: false },
          }),
        ),
      ),
    ).toBe("CHANNEL_NOT_PERMITTED");
    // Staff may still book it for the patient.
    expect(
      code(() =>
        assertBookingEligibility(eligible({ appointmentType: staffOnly })),
      ),
    ).toBeUndefined();
  });

  it("enforces new-patient and follow-up rules", () => {
    const existingOnly = { ...type, newPatientAllowed: false };
    expect(
      code(() =>
        assertBookingEligibility(eligible({ appointmentType: existingOnly })),
      ),
    ).toBe("NEW_PATIENT_NOT_ALLOWED");
    const followUp = { ...type, newPatientAllowed: false, followUpOnly: true };
    expect(
      code(() =>
        assertBookingEligibility(
          eligible({
            appointmentType: followUp,
            patient: {
              active: true,
              hasCompletedAppointment: true,
              hasCompletedWithPractitioner: false,
            },
          }),
        ),
      ),
    ).toBe("FOLLOW_UP_ONLY");
    expect(
      code(() =>
        assertBookingEligibility(
          eligible({
            appointmentType: followUp,
            patient: {
              active: true,
              hasCompletedAppointment: true,
              hasCompletedWithPractitioner: true,
            },
          }),
        ),
      ),
    ).toBeUndefined();
    expect(
      code(() =>
        assertBookingEligibility(
          eligible({
            patient: {
              active: false,
              hasCompletedAppointment: true,
              hasCompletedWithPractitioner: true,
            },
          }),
        ),
      ),
    ).toBe("PATIENT_INACTIVE");
  });

  it("never lets a booking skip a required, valid referral", () => {
    const needs = { ...type, requiresReferral: true };
    expect(
      code(() =>
        assertBookingEligibility(eligible({ appointmentType: needs })),
      ),
    ).toBe("REFERRAL_REQUIRED");
    const withReferral = (r: Partial<ReferralFacts>, verification = true) =>
      code(() =>
        assertBookingEligibility(
          eligible({
            appointmentType: needs,
            referral: { ...referral, ...r },
            referralVerificationRequired: verification,
          }),
        ),
      );
    expect(withReferral({})).toBeUndefined();
    expect(withReferral({ status: "RECEIVED" })).toBe("REFERRAL_NOT_VERIFIED");
    expect(withReferral({ status: "RECEIVED" }, false)).toBeUndefined();
    expect(withReferral({ status: "REJECTED" }, false)).toBe(
      "REFERRAL_NOT_VERIFIED",
    );
    expect(withReferral({ validUntil: "2026-10-04" })).toBe("REFERRAL_EXPIRED");
    expect(withReferral({ validUntil: "2026-10-05" })).toBeUndefined();
    expect(withReferral({ maxAppointments: 2, appointmentsUsed: 2 })).toBe(
      "REFERRAL_EXHAUSTED",
    );
    expect(withReferral({ patientMatches: false })).toBe("REFERRAL_MISMATCH");
    expect(withReferral({ appointmentTypeMatches: false })).toBe(
      "REFERRAL_MISMATCH",
    );
  });

  it("applies the patient change cutoff to patient channels only", () => {
    const startsAt = new Date("2026-10-05T10:00:00Z");
    const now = new Date("2026-10-05T09:00:00Z");
    expect(
      code(() =>
        assertPatientChangeAllowed({
          actor: "PATIENT",
          startsAt,
          now,
          cutoffMinutes: 120,
        }),
      ),
    ).toBe("PATIENT_CHANGE_CUTOFF");
    expect(
      code(() =>
        assertPatientChangeAllowed({
          actor: "STAFF",
          startsAt,
          now,
          cutoffMinutes: 120,
        }),
      ),
    ).toBeUndefined();
  });
});

describe("time-zone arithmetic", () => {
  it("never depends on the server's time zone", () => {
    expect(isValidTimezone("Africa/Johannesburg")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(
      wallClockToInstant("2026-10-05", 9 * 60, "Africa/Johannesburg"),
    ).toEqual(new Date("2026-10-05T07:00:00Z"));
    expect(
      wallClockToInstant("2026-10-05", 9 * 60, "America/New_York"),
    ).toEqual(new Date("2026-10-05T13:00:00Z"));
    expect(
      wallClockToInstant("2026-10-05", 1440, "Africa/Johannesburg"),
    ).toEqual(new Date("2026-10-05T22:00:00Z"));
    expect(
      localDateOf(new Date("2026-10-05T22:30:00Z"), "Africa/Johannesburg"),
    ).toBe("2026-10-06");
    expect(
      localMinuteOf(new Date("2026-10-05T07:15:00Z"), "Africa/Johannesburg"),
    ).toBe(9 * 60 + 15);
    expect(isoWeekday("2026-10-05")).toBe(1);
    expect(isoWeekday("2026-10-11")).toBe(7);
  });

  it("reports nonexistent local times exactly and shifts them on request", () => {
    expect(
      wallClockToInstant("2026-03-29", 90, "Europe/London", "exact"),
    ).toBeNull();
    expect(
      wallClockToInstant("2026-03-29", 90, "Europe/London", "shift"),
    ).toEqual(new Date("2026-03-29T01:30:00Z"));
    // Ambiguous 01:30 on fall-back day resolves to its first (BST) occurrence.
    expect(wallClockToInstant("2026-10-25", 90, "Europe/London")).toEqual(
      new Date("2026-10-25T00:30:00Z"),
    );
  });

  it("enumerates local dates across a range", () => {
    expect(
      localDatesBetween(
        new Date("2026-10-04T21:59:00Z"),
        new Date("2026-10-06T22:00:00Z"),
        "Africa/Johannesburg",
      ),
    ).toEqual(["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
  });
});
