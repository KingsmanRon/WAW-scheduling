import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_WORKFLOW_STATUSES,
  CASE_STATES,
} from "../../packages/contracts/src/index.js";
import {
  AVAILABILITY_FRESH_SECONDS,
  CASE_TRANSITIONS,
  appointmentNextAction,
  availabilityIsFresh,
  bookingEligibility,
  canTransition,
  canWorkflowStep,
  holdIsUsable,
  patientAccessStatus,
  refusalIsRecoverable,
  transition,
  workflowFinished,
  workflowStep,
} from "../../packages/domain/src/index.js";

describe("appointment case lifecycle", () => {
  it("appointment cases wait on external actions and return for staff decisions", () => {
    for (const type of [
      "APPOINTMENT_REQUEST",
      "RESCHEDULING_REQUEST",
      "CANCELLATION_REQUEST",
    ]) {
      expect(canTransition("RECEIVED", "WAITING", type)).toBe(true);
      expect(canTransition("WAITING", "READY_FOR_BOOKING", type)).toBe(true);
      expect(canTransition("WAITING", "EXCEPTION", type)).toBe(true);
      expect(canTransition("RECEIVED", "DESTINATION_PENDING", type)).toBe(
        false,
      );
      expect(canTransition("READY_FOR_BOOKING", "BOOKED", type)).toBe(false);
      expect(canTransition("BOOKED", "CLOSED", type)).toBe(false);
      expect(canTransition("CLOSED", "BOOKED", type)).toBe(false);
    }
    expect(canTransition("WAITING", "BOOKED", "APPOINTMENT_REQUEST")).toBe(
      true,
    );
    // A cancellation request closes; it never books.
    expect(canTransition("WAITING", "BOOKED", "CANCELLATION_REQUEST")).toBe(
      false,
    );
    expect(canTransition("EXCEPTION", "BOOKED", "CANCELLATION_REQUEST")).toBe(
      false,
    );
  });
  it("referral transitions are unchanged", () => {
    for (const from of CASE_STATES)
      for (const to of CASE_STATES)
        expect(canTransition(from, to, "REFERRAL")).toBe(
          CASE_TRANSITIONS[from].includes(to),
        );
    expect(() => transition("RECEIVED", "WAITING")).toThrow(
      "invalid transition",
    );
  });
});

describe("booking sub-flow", () => {
  it("follows availability, selection, hold, commit and read-back", () => {
    const path = [
      "AVAILABILITY_REQUESTED",
      "AVAILABILITY_RETURNED",
      "SLOT_SELECTED",
      "HOLD_REQUESTED",
      "HELD",
      "BOOKING_SUBMITTED",
      "COMMITTED",
      "BOOKED",
    ] as const;
    for (let i = 1; i < path.length; i++)
      expect(workflowStep("APPOINTMENT_REQUEST", path[i - 1]!, path[i]!)).toBe(
        path[i],
      );
    expect(workflowFinished("BOOKED")).toBe(true);
    // Only a commit that was read back counts as booked.
    expect(
      canWorkflowStep("APPOINTMENT_REQUEST", "BOOKING_SUBMITTED", "BOOKED"),
    ).toBe(false);
    expect(
      canWorkflowStep("APPOINTMENT_REQUEST", "COMMITTED", "WITHDRAWN"),
    ).toBe(false);
  });
  it("a reschedule commits the replacement, then cancels the original", () => {
    expect(
      canWorkflowStep(
        "RESCHEDULING_REQUEST",
        "BOOKING_SUBMITTED",
        "REPLACEMENT_BOOKED",
      ),
    ).toBe(true);
    expect(
      canWorkflowStep(
        "RESCHEDULING_REQUEST",
        "REPLACEMENT_BOOKED",
        "ORIGINAL_CANCELLATION_PENDING",
      ),
    ).toBe(true);
    // An appointment request never enters the reschedule steps, and a
    // reschedule never "books" without replacing.
    expect(
      canWorkflowStep(
        "APPOINTMENT_REQUEST",
        "BOOKING_SUBMITTED",
        "REPLACEMENT_BOOKED",
      ),
    ).toBe(false);
    expect(
      canWorkflowStep("RESCHEDULING_REQUEST", "BOOKING_SUBMITTED", "BOOKED"),
    ).toBe(false);
    // Once B exists the request cannot be withdrawn: two appointments would
    // be left in the destination.
    for (const from of [
      "REPLACEMENT_BOOKED",
      "ORIGINAL_CANCELLATION_PENDING",
    ] as const)
      expect(canWorkflowStep("RESCHEDULING_REQUEST", from, "WITHDRAWN")).toBe(
        false,
      );
  });
  it("in-flight writes cannot be withdrawn and finished requests are final", () => {
    for (const from of ["HOLD_REQUESTED", "BOOKING_SUBMITTED"] as const)
      expect(canWorkflowStep("APPOINTMENT_REQUEST", from, "WITHDRAWN")).toBe(
        false,
      );
    expect(
      canWorkflowStep(
        "CANCELLATION_REQUEST",
        "CANCELLATION_SUBMITTED",
        "WITHDRAWN",
      ),
    ).toBe(false);
    for (const status of APPOINTMENT_WORKFLOW_STATUSES)
      if (workflowFinished(status))
        expect(["BOOKED", "COMPLETED", "CANCELLED", "WITHDRAWN"]).toContain(
          status,
        );
    expect(() =>
      workflowStep("CANCELLATION_REQUEST", "CANCELLATION_REQUESTED", "HELD"),
    ).toThrow(/not permitted/);
  });
  it("availability goes stale and holds must have time left", () => {
    const now = new Date("2026-10-01T10:00:00Z");
    expect(
      availabilityIsFresh(
        new Date(now.getTime() - AVAILABILITY_FRESH_SECONDS * 1000),
        now,
      ),
    ).toBe(true);
    expect(
      availabilityIsFresh(
        new Date(now.getTime() - AVAILABILITY_FRESH_SECONDS * 1000 - 1),
        now,
      ),
    ).toBe(false);
    expect(availabilityIsFresh(null, now)).toBe(false);
    expect(holdIsUsable(new Date(now.getTime() + 16_000), now)).toBe(true);
    expect(holdIsUsable(new Date(now.getTime() + 15_000), now)).toBe(false);
    expect(holdIsUsable(new Date(now.getTime() - 1), now)).toBe(false);
  });
  it("only slot-level refusals return to selection", () => {
    expect(refusalIsRecoverable("SLOT_UNAVAILABLE")).toBe(true);
    expect(refusalIsRecoverable("HOLD_EXPIRED")).toBe(true);
    expect(refusalIsRecoverable("REJECTED")).toBe(false);
    expect(refusalIsRecoverable("CAPABILITY_WITHDRAWN")).toBe(false);
  });
});

describe("booking eligibility", () => {
  const base = {
    caseType: "REFERRAL",
    state: "READY_FOR_BOOKING" as const,
    openWorkKinds: [],
    unmetPrerequisites: [],
    activeRequest: false,
  };
  it("a ready referral with prerequisites met may start booking", () =>
    expect(bookingEligibility(base)).toEqual({ eligible: true, reasons: [] }));
  it("states every reason it may not", () =>
    expect(
      bookingEligibility({
        ...base,
        state: "INFORMATION_MISSING",
        openWorkKinds: ["SAFETY"],
        unmetPrerequisites: ["destination_reference"],
        activeRequest: true,
      }).reasons,
    ).toEqual([
      "NOT_READY_FOR_BOOKING",
      "SAFETY_REVIEW_OPEN",
      "BOOKING_PREREQUISITES_UNMET:destination_reference",
      "BOOKING_ALREADY_ACTIVE",
    ]));
  it("appointment cases cannot start a booking themselves", () =>
    expect(
      bookingEligibility({ ...base, caseType: "APPOINTMENT_REQUEST" }).reasons,
    ).toEqual(["NOT_A_REFERRAL"]));
});

describe("plain-language status", () => {
  const referral = {
    referralState: "READY_FOR_BOOKING" as const,
    referralResolution: null,
    openWorkKinds: [],
    activeRequest: null,
    appointments: [],
  };
  it("derives the status from authoritative state", () => {
    const cases: [Parameters<typeof patientAccessStatus>[0], string][] = [
      [
        { ...referral, referralState: "INFORMATION_MISSING" },
        "Referral in progress",
      ],
      [
        { ...referral, referralState: "DESTINATION_PENDING" },
        "Referral complete",
      ],
      [referral, "Ready for booking"],
      [
        {
          ...referral,
          referralState: "WAITING",
          activeRequest: {
            caseType: "APPOINTMENT_REQUEST",
            state: "WAITING",
            workflowStatus: "AVAILABILITY_REQUESTED",
          },
        },
        "Searching for appointment",
      ],
      [
        {
          ...referral,
          referralState: "WAITING",
          activeRequest: {
            caseType: "APPOINTMENT_REQUEST",
            state: "WAITING",
            workflowStatus: "BOOKING_SUBMITTED",
          },
        },
        "Slot selected / awaiting commit",
      ],
      [
        {
          ...referral,
          referralState: "BOOKED",
          referralResolution: "BOOKED",
          appointments: [
            { status: "BOOKED", confirmationStatus: "UNCONFIRMED" },
          ],
        },
        "Booked",
      ],
      [
        {
          ...referral,
          referralState: "BOOKED",
          referralResolution: "BOOKED",
          appointments: [{ status: "BOOKED", confirmationStatus: "CONFIRMED" }],
        },
        "Confirmed",
      ],
      [
        {
          ...referral,
          referralState: "BOOKED",
          referralResolution: "BOOKED",
          activeRequest: {
            caseType: "RESCHEDULING_REQUEST",
            state: "WAITING",
            workflowStatus: "BOOKING_SUBMITTED",
          },
          appointments: [{ status: "BOOKED", confirmationStatus: "CONFIRMED" }],
        },
        "Reschedule in progress",
      ],
      [
        {
          ...referral,
          referralState: "BOOKED",
          referralResolution: "BOOKED",
          appointments: [
            { status: "CANCELLED", confirmationStatus: "UNCONFIRMED" },
          ],
        },
        "Cancelled",
      ],
      [
        {
          ...referral,
          referralState: "CLOSED",
          referralResolution: "PATIENT_DECLINED",
        },
        "Closed: PATIENT_DECLINED",
      ],
    ];
    for (const [input, label] of cases)
      expect(patientAccessStatus(input).label, label).toBe(label);
  });
  it("anything needing a person says so first", () => {
    expect(
      patientAccessStatus({
        ...referral,
        referralState: "BOOKED",
        referralResolution: "BOOKED",
        activeRequest: {
          caseType: "RESCHEDULING_REQUEST",
          state: "EXCEPTION",
          workflowStatus: "ORIGINAL_CANCELLATION_PENDING",
        },
        appointments: [
          { status: "BOOKED", confirmationStatus: "UNCONFIRMED" },
          { status: "BOOKED", confirmationStatus: "UNCONFIRMED" },
        ],
      }).status,
    ).toBe("NEEDS_ATTENTION");
    expect(
      patientAccessStatus({ ...referral, openWorkKinds: ["SAFETY"] }).status,
    ).toBe("NEEDS_ATTENTION");
    expect(
      patientAccessStatus({ ...referral, openWorkKinds: ["FOLLOW_UP"] }).status,
    ).toBe("READY_FOR_BOOKING");
  });
  it("next actions are administrative, never clinical", () => {
    for (const type of [
      "APPOINTMENT_REQUEST",
      "RESCHEDULING_REQUEST",
      "CANCELLATION_REQUEST",
    ])
      for (const status of APPOINTMENT_WORKFLOW_STATUSES)
        expect(
          appointmentNextAction({
            caseType: type,
            state: "WAITING",
            workflowStatus: status,
          }),
        ).not.toMatch(/diagnos|triage|treat|urgen|clinical/i);
    expect(
      appointmentNextAction({
        caseType: "APPOINTMENT_REQUEST",
        state: "EXCEPTION",
        workflowStatus: "BOOKING_SUBMITTED",
        exceptionReason: "reconciliation_escalated",
      }),
    ).toBe("Resolve exception: reconciliation_escalated");
    // Known appointment exceptions say what to do, in staff words.
    expect(
      appointmentNextAction({
        caseType: "RESCHEDULING_REQUEST",
        state: "EXCEPTION",
        workflowStatus: "ORIGINAL_CANCELLATION_PENDING",
        exceptionReason:
          "original_cancellation_unconfirmed:both_appointments_may_exist",
      }),
    ).toMatch(/may both exist/);
    expect(
      appointmentNextAction({
        caseType: "APPOINTMENT_REQUEST",
        state: "EXCEPTION",
        workflowStatus: "BOOKING_SUBMITTED",
        exceptionReason: "booking_outcome_unknown",
      }),
    ).toMatch(/^Check the destination system/);
  });
});
