import { z } from "zod";
import {
  BLOCK_REASON_CODES,
  BOOKING_CHANNELS,
  CANCELLATION_REASON_CODES,
  EXCEPTION_REASON_CODES,
  PRACTICE_ROLES,
  PROFESSIONS,
} from "./scheduling.js";

/**
 * Request contracts of the practice scheduling API (/v1/practices/:id/...).
 * Every body is strict: unknown fields are rejected, never ignored. Tenant,
 * practice and actor never come from a body - only from the verified session
 * and the path.
 */
const id = z.string().uuid();
/** An instant with an explicit offset or Z, e.g. 2026-10-05T09:00:00+02:00. */
export const instantSchema = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v));
const localDate = z.iso.date();
const channel = z.enum(BOOKING_CHANNELS);
const note = z.string().trim().max(500);
const version = z.number().int().nonnegative();
const idList = z
  .string()
  .max(2000)
  .transform((v) => v.split(",").filter(Boolean))
  .pipe(z.array(id).max(50));
const boolFlag = z.enum(["true", "false"]).transform((v) => v === "true");
const e164 = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// --- Scheduling -----------------------------------------------------------

export const slotAvailabilityQuerySchema = z.object({
  appointment_type_id: id,
  from: instantSchema,
  to: instantSchema,
  practitioner_id: id.optional(),
  location_id: id.optional(),
  /** Staff moving this appointment: its own time is not an obstacle. */
  reschedule_of: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export const calendarQuerySchema = z.object({
  from: instantSchema,
  to: instantSchema,
  practitioner_ids: idList.optional(),
  location_id: id.optional(),
  include_cancelled: boolFlag.optional(),
});
export const APPOINTMENT_STATUS_VALUES = [
  "HELD",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "RESCHEDULED",
  "EXPIRED",
] as const;
export const appointmentListQuerySchema = z.object({
  from: instantSchema.optional(),
  to: instantSchema.optional(),
  practitioner_id: id.optional(),
  location_id: id.optional(),
  patient_id: id.optional(),
  status: z
    .string()
    .max(200)
    .transform((v) => v.split(",").filter(Boolean))
    .pipe(z.array(z.enum(APPOINTMENT_STATUS_VALUES)))
    .optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const bookAppointmentSchema = z
  .object({
    patient_id: id,
    appointment_type_id: id,
    practitioner_id: id,
    location_id: id,
    start: instantSchema,
    /** How the booking reached the practice. */
    source_channel: channel,
    referral_id: id.nullable().optional(),
    notes: note.nullable().optional(),
    override_availability: z.boolean().optional(),
    waitlist_entry_id: id.optional(),
  })
  .strict();
export const createHoldSchema = z
  .object({
    patient_id: id,
    appointment_type_id: id,
    practitioner_id: id,
    location_id: id,
    start: instantSchema,
    source_channel: channel,
    referral_id: id.nullable().optional(),
    reschedule_of_id: id.optional(),
    session_ref: z.string().min(1).max(200).optional(),
  })
  .strict();
export const confirmHoldSchema = z
  .object({ notes: note.nullable().optional() })
  .strict();
export const emptySchema = z.object({}).strict();
export const rescheduleSchema = z
  .object({
    start: instantSchema,
    practitioner_id: id.optional(),
    location_id: id.optional(),
    note: note.nullable().optional(),
    expected_version: version.optional(),
    override_availability: z.boolean().optional(),
    channel: channel.optional(),
  })
  .strict();
export const cancelSchema = z
  .object({
    reason_code: z.enum(CANCELLATION_REASON_CODES),
    note: note.nullable().optional(),
    expected_version: version.optional(),
    channel: channel.optional(),
  })
  .strict();
export const lifecycleSchema = z
  .object({
    expected_version: version.optional(),
    channel: channel.optional(),
  })
  .strict();
export const notesSchema = z
  .object({ notes: note.nullable(), expected_version: version })
  .strict();

// --- Patients -------------------------------------------------------------

const contactSchema = z
  .object({
    kind: z.enum(["MOBILE", "EMAIL", "LANDLINE"]),
    value: z.string().trim().min(3).max(254),
    is_primary: z.boolean().optional(),
    whatsapp_capable: z.boolean().optional(),
    verified_by_staff: z.boolean().optional(),
  })
  .strict();
const identifierSchema = z
  .object({
    system: z.enum(["NATIONAL_ID", "PASSPORT", "EXTERNAL"]),
    issuer: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
    value: z.string().trim().min(1).max(120),
  })
  .strict();
const personName = z.string().trim().min(1).max(100);
export const createPatientSchema = z
  .object({
    given_name: personName,
    family_name: personName,
    preferred_name: personName.nullable().optional(),
    date_of_birth: localDate.nullable().optional(),
    administrative_sex: z
      .enum(["FEMALE", "MALE", "OTHER", "UNKNOWN"])
      .nullable()
      .optional(),
    preferred_language: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
      .optional(),
    source_channel: channel,
    identity_verified: z.boolean().optional(),
    contacts: z.array(contactSchema).max(10).optional(),
    identifiers: z.array(identifierSchema).max(5).optional(),
  })
  .strict();
export const updatePatientSchema = z
  .object({
    given_name: personName.optional(),
    family_name: personName.optional(),
    preferred_name: personName.nullable().optional(),
    date_of_birth: localDate.nullable().optional(),
    administrative_sex: z
      .enum(["FEMALE", "MALE", "OTHER", "UNKNOWN"])
      .nullable()
      .optional(),
    preferred_language: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
      .optional(),
    identity_verified: z.boolean().optional(),
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
    expected_version: version,
  })
  .strict();
export const addContactSchema = contactSchema;
export const addIdentifierSchema = identifierSchema;
export const patientSearchSchema = z.object({
  q: z.string().trim().min(2).max(100).optional(),
  mobile: z.string().trim().min(5).max(25).optional(),
  email: z.string().trim().min(3).max(254).optional(),
  patient_number: z.string().trim().min(3).max(32).optional(),
  national_id: z.string().trim().min(4).max(30).optional(),
  date_of_birth: localDate.optional(),
  include_archived: boolFlag.optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const duplicateReviewSchema = z
  .object({ decision: z.enum(["DISMISSED", "CONFIRMED"]) })
  .strict();

// --- Configuration --------------------------------------------------------

export const practiceSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().min(1).max(64).optional(),
    contact_phone: e164.nullable().optional(),
    contact_email: z.email().nullable().optional(),
    hold_ttl_seconds: z.number().int().min(60).max(1800).optional(),
    default_slot_interval_minutes: z.number().int().min(5).max(120).optional(),
    reminder_24h_enabled: z.boolean().optional(),
    near_term_reminder_minutes: z
      .number()
      .int()
      .min(15)
      .max(720)
      .nullable()
      .optional(),
    waitlist_offer_ttl_minutes: z.number().int().min(5).max(1440).optional(),
    referral_verification_required: z.boolean().optional(),
    patient_change_cutoff_minutes: z
      .number()
      .int()
      .min(0)
      .max(10080)
      .optional(),
    expected_version: version.optional(),
  })
  .strict();
export const locationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    timezone: z.string().min(1).max(64),
    address_line1: z.string().max(200).nullable().optional(),
    address_line2: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    postal_code: z.string().max(20).nullable().optional(),
    phone: e164.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export const locationPatchSchema = locationSchema
  .partial()
  .extend({ expected_version: version.optional() })
  .strict();
export const practitionerSchema = z
  .object({
    display_name: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(20).nullable().optional(),
    given_name: personName.nullable().optional(),
    family_name: personName,
    profession: z.enum(PROFESSIONS).optional(),
    registration_number: z
      .string()
      .regex(/^[A-Za-z0-9/ -]{1,40}$/)
      .nullable()
      .optional(),
    calendar_color: color.nullable().optional(),
    active: z.boolean().optional(),
    bookable_by_patients: z.boolean().optional(),
    location_ids: z.array(id).max(20).optional(),
  })
  .strict();
export const practitionerPatchSchema = practitionerSchema
  .partial()
  .extend({ expected_version: version.optional() })
  .strict();
export const appointmentTypeSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9_]{2,40}$/),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(500).nullable().optional(),
    duration_minutes: z.number().int().min(5).max(480),
    buffer_before_minutes: z.number().int().min(0).max(240).optional(),
    buffer_after_minutes: z.number().int().min(0).max(240).optional(),
    slot_interval_minutes: z
      .number()
      .int()
      .min(5)
      .max(240)
      .nullable()
      .optional(),
    requires_referral: z.boolean().optional(),
    new_patient_allowed: z.boolean().optional(),
    follow_up_only: z.boolean().optional(),
    min_notice_minutes: z.number().int().min(0).max(43200).optional(),
    max_advance_days: z.number().int().min(1).max(730).optional(),
    patient_bookable: z.boolean().optional(),
    calendar_color: color.nullable().optional(),
    active: z.boolean().optional(),
    practitioner_ids: z.array(id).max(100).optional(),
    location_ids: z.array(id).max(50).optional(),
  })
  .strict();
export const appointmentTypePatchSchema = appointmentTypeSchema
  .partial()
  .extend({ expected_version: version.optional() })
  .strict();
export const availabilityRuleSchema = z
  .object({
    practitioner_id: id,
    location_id: id,
    weekday: z.number().int().min(1).max(7),
    start_minute: z.number().int().min(0).max(1439),
    end_minute: z.number().int().min(1).max(1440),
    valid_from: localDate,
    valid_until: localDate.nullable().optional(),
  })
  .strict()
  .refine((r) => r.end_minute > r.start_minute, {
    message: "end must be after start",
  });
const periodFields = {
  practitioner_id: id,
  location_id: id.nullable().optional(),
  start: instantSchema,
  end: instantSchema,
  note: z.string().trim().max(200).nullable().optional(),
  acknowledge_conflicts: z.boolean().optional(),
};
export const scheduleBlockSchema = z
  .object({ ...periodFields, reason_code: z.enum(BLOCK_REASON_CODES) })
  .strict();
export const availabilityExceptionSchema = z
  .object({
    ...periodFields,
    kind: z.enum(["UNAVAILABLE", "AVAILABLE"]),
    reason_code: z.enum(EXCEPTION_REASON_CODES),
  })
  .strict();
export const removalSchema = z
  .object({ reason: z.string().trim().max(200).nullable().optional() })
  .strict();
export const exceptionListQuerySchema = z.object({
  practitioner_id: id.optional(),
  from: instantSchema,
  to: instantSchema,
});
export const membershipSchema = z
  .object({
    user_id: id,
    role: z.enum(PRACTICE_ROLES),
    status: z.enum(["ACTIVE", "SUSPENDED"]),
    display_name: z.string().trim().min(1).max(120),
    email: z.email().nullable().optional(),
    practitioner_id: id.nullable().optional(),
  })
  .strict();
export const auditQuerySchema = z.object({
  resource_type: z
    .string()
    .regex(/^[a-z_]{2,40}$/)
    .optional(),
  resource_id: z.string().max(200).optional(),
  before_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
