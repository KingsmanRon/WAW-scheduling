import type { ActorKind } from "./availability.js";
import { SchedulingError } from "./errors.js";

/**
 * Deterministic booking eligibility. Evaluated by the Scheduling Core inside
 * the booking transaction, after the rows involved are locked, for every
 * channel alike. No model output or free text can bypass it: referral
 * requirements, patient eligibility and channel restrictions are data.
 */
export interface EligibilityInput {
  actor: ActorKind;
  appointmentType: {
    active: boolean;
    requiresReferral: boolean;
    newPatientAllowed: boolean;
    followUpOnly: boolean;
    patientBookable: boolean;
    allowsPractitioner: boolean;
    allowsLocation: boolean;
  };
  practitioner: { active: boolean; bookableByPatients: boolean };
  location: { active: boolean };
  patient: {
    active: boolean;
    /** Has a COMPLETED appointment at this practice. */
    hasCompletedAppointment: boolean;
    /** Has a COMPLETED appointment with this practitioner. */
    hasCompletedWithPractitioner: boolean;
  };
  /** Local calendar date of the appointment (location zone). */
  appointmentDate: string;
  referral: ReferralFacts | null;
  referralVerificationRequired: boolean;
}
export interface ReferralFacts {
  patientMatches: boolean;
  status: "RECEIVED" | "VERIFIED" | "REJECTED" | "CANCELLED";
  /** null = any appointment type. */
  appointmentTypeMatches: boolean | null;
  validUntil: string | null;
  maxAppointments: number | null;
  /** Non-cancelled appointments already using it (excluding this booking). */
  appointmentsUsed: number;
}

export function assertBookingEligibility(input: EligibilityInput): void {
  const t = input.appointmentType;
  if (!t.active) throw new SchedulingError("APPOINTMENT_TYPE_INACTIVE");
  if (!input.practitioner.active)
    throw new SchedulingError("PRACTITIONER_INACTIVE");
  if (!input.location.active) throw new SchedulingError("LOCATION_INACTIVE");
  if (!t.allowsPractitioner)
    throw new SchedulingError("PRACTITIONER_NOT_ALLOWED");
  if (!t.allowsLocation) throw new SchedulingError("LOCATION_NOT_ALLOWED");
  if (
    input.actor === "PATIENT" &&
    (!t.patientBookable || !input.practitioner.bookableByPatients)
  )
    throw new SchedulingError("CHANNEL_NOT_PERMITTED");
  if (!input.patient.active) throw new SchedulingError("PATIENT_INACTIVE");
  if (t.followUpOnly && !input.patient.hasCompletedWithPractitioner)
    throw new SchedulingError("FOLLOW_UP_ONLY");
  if (!t.newPatientAllowed && !input.patient.hasCompletedAppointment)
    throw new SchedulingError("NEW_PATIENT_NOT_ALLOWED");
  if (input.referral) assertReferralCovers(input, input.referral);
  else if (t.requiresReferral) throw new SchedulingError("REFERRAL_REQUIRED");
}

function assertReferralCovers(input: EligibilityInput, r: ReferralFacts) {
  if (!r.patientMatches || r.appointmentTypeMatches === false)
    throw new SchedulingError("REFERRAL_MISMATCH");
  if (r.status === "REJECTED" || r.status === "CANCELLED")
    throw new SchedulingError("REFERRAL_NOT_VERIFIED");
  if (r.status !== "VERIFIED" && input.referralVerificationRequired)
    throw new SchedulingError("REFERRAL_NOT_VERIFIED");
  if (r.validUntil !== null && input.appointmentDate > r.validUntil)
    throw new SchedulingError("REFERRAL_EXPIRED");
  if (r.maxAppointments !== null && r.appointmentsUsed >= r.maxAppointments)
    throw new SchedulingError("REFERRAL_EXHAUSTED");
}

/**
 * Patients changing their own booking through a channel must do so before
 * the practice's cutoff; staff are not limited (they speak to the patient).
 */
export function assertPatientChangeAllowed(input: {
  actor: ActorKind;
  startsAt: Date;
  now: Date;
  cutoffMinutes: number;
}): void {
  if (
    input.actor === "PATIENT" &&
    +input.startsAt - +input.now < input.cutoffMinutes * 60_000
  )
    throw new SchedulingError("PATIENT_CHANGE_CUTOFF");
}
