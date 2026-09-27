import { z } from "zod";
export const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// Platform vocabulary. Every enum below is mirrored by a PostgreSQL CHECK
// constraint; change both together through a new migration.
// ---------------------------------------------------------------------------

export const CASE_TYPES = [
  "REFERRAL",
  "APPOINTMENT_REQUEST",
  "STATUS_ENQUIRY",
  "MISSING_INFORMATION",
  "CANCELLATION_REQUEST",
  "RESCHEDULING_REQUEST",
] as const;
export type CaseType = (typeof CASE_TYPES)[number];
/**
 * Case types that execute. STATUS_ENQUIRY and MISSING_INFORMATION stay
 * defined but fail closed: they are interactions on a referral, not
 * independent automated cases.
 */
export const ENABLED_CASE_TYPES: readonly CaseType[] = [
  "REFERRAL",
  "APPOINTMENT_REQUEST",
  "CANCELLATION_REQUEST",
  "RESCHEDULING_REQUEST",
];
/**
 * Appointment operations cases. They are never created directly: an
 * APPOINTMENT_REQUEST starts from a referral that is ready for booking, and
 * the change requests start from a committed appointment.
 */
export const APPOINTMENT_CASE_TYPES = [
  "APPOINTMENT_REQUEST",
  "RESCHEDULING_REQUEST",
  "CANCELLATION_REQUEST",
] as const;
export type AppointmentCaseType = (typeof APPOINTMENT_CASE_TYPES)[number];
export function isAppointmentCaseType(
  caseType: string,
): caseType is AppointmentCaseType {
  return (APPOINTMENT_CASE_TYPES as readonly string[]).includes(caseType);
}

export const CASE_STATES = [
  "RECEIVED",
  "IDENTITY_PENDING",
  "INFORMATION_MISSING",
  "READY",
  "DESTINATION_PENDING",
  "READY_FOR_BOOKING",
  "WAITING",
  "BOOKED",
  "CLOSED",
  "EXCEPTION",
  "REJECTED",
] as const;
export type CaseState = (typeof CASE_STATES)[number];
export const TERMINAL_CASE_STATES: readonly CaseState[] = [
  "BOOKED",
  "CLOSED",
  "REJECTED",
];

export const CHANNELS = [
  "STAFF_UPLOAD",
  "API",
  "EMAIL",
  "WHATSAPP",
  "VOICE",
  "PATIENT_PORTAL",
] as const;
export type Channel = (typeof CHANNELS)[number];
/** EMAIL, WHATSAPP, VOICE and PATIENT_PORTAL are defined but disabled. */
export const ENABLED_CHANNELS: readonly Channel[] = ["STAFF_UPLOAD", "API"];

export const INTERACTION_DIRECTIONS = ["INBOUND", "OUTBOUND"] as const;
export const ACTOR_TYPES = [
  "STAFF",
  "SYSTEM",
  "INTEGRATION",
  "CONNECTOR",
  "PATIENT",
  "PROVIDER",
] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export const INTERACTION_INTENTS = [
  "NEW_REFERRAL",
  "MISSING_INFORMATION",
  "STATUS_ENQUIRY",
  "FOLLOW_UP",
  "OUTCOME_REPORT",
  "APPOINTMENT_REQUEST",
  "CANCELLATION_REQUEST",
  "RESCHEDULING_REQUEST",
  "OTHER",
] as const;
export type InteractionIntent = (typeof INTERACTION_INTENTS)[number];
export const IDENTITY_VERIFICATION_LEVELS = [
  "NONE",
  "CLAIMED",
  "STAFF_VERIFIED",
  "SYSTEM_VERIFIED",
] as const;

export const RESOLUTION_CODES = [
  "BOOKED",
  "PATIENT_UNREACHABLE",
  "PATIENT_DECLINED",
  "PROVIDER_DECLINED",
  "DUPLICATE_REFERRAL",
  "INVALID_REFERRAL",
  "MISSING_INFORMATION",
  "REFERRED_ELSEWHERE",
  "CANCELLED",
  "UNKNOWN",
  /** A request withdrawn before it took effect; nothing external changed. */
  "WITHDRAWN",
] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];
/** Closure reasons for a referral (WITHDRAWN applies to requests only). */
export const REFERRAL_RESOLUTION_CODES = RESOLUTION_CODES.filter(
  (code) => code !== "WITHDRAWN",
) as [
  Exclude<ResolutionCode, "WITHDRAWN">,
  ...Exclude<ResolutionCode, "WITHDRAWN">[],
];

export const OBSERVATION_TYPES = [
  "REFERRAL_RECEIVED",
  "REFERRAL_VERIFIED",
  "REFERRAL_READY",
  "DESTINATION_COMMITTED",
  "BOOKING_REQUESTED",
  "APPOINTMENT_BOOKED",
  "APPOINTMENT_CANCELLED",
  "PATIENT_UNREACHABLE",
  "PROVIDER_DECLINED",
  "PATIENT_DECLINED",
  "REFERRAL_CLOSED",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];
export const OBSERVATION_SOURCES = [
  "CONNECTOR",
  "CALLBACK",
  "RECONCILIATION",
  "STAFF",
  "IMPORT",
  "SYSTEM",
] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];
export const VERIFICATION_LEVELS = [
  "OBSERVED",
  "EXTERNAL_CONFIRMED",
  "HUMAN_ATTESTED",
  "DERIVED",
  "UNKNOWN",
] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];
export const OBSERVATION_DISPOSITIONS = [
  "APPLIED",
  "RECORDED",
  "PENDING",
  "REVIEW",
  "SUPERSEDED",
] as const;
export type ObservationDisposition = (typeof OBSERVATION_DISPOSITIONS)[number];

export const EFFORT_TYPES = [
  "WORK_ITEM_OPENED",
  "WORK_ITEM_RESOLVED",
  "MANUAL_CORRECTION",
  "STATUS_CONTACT",
  "FOLLOW_UP",
  "MANUAL_DESTINATION_ACTION",
  "OUTCOME_RECORDED",
] as const;
export type EffortType = (typeof EFFORT_TYPES)[number];

export const WORK_ITEM_KINDS = [
  "IDENTITY",
  "COMPLETENESS",
  "SAFETY",
  "FILE_SAFETY",
  "CONNECTOR",
  "MANUAL_DESTINATION",
  "OUTCOME_REVIEW",
  "FOLLOW_UP",
  "ESCALATION",
] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

export const EXECUTION_STATUSES = [
  "PENDING",
  "LEASED",
  "RETRYABLE",
  "AMBIGUOUS",
  "RECONCILING",
  "SUCCEEDED",
  "PERMANENT",
  "POISON",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const STAFF_ROLES = [
  "ADMIN",
  "PRACTICE_MANAGER",
  "REFERRAL_COORDINATOR",
  "READ_ONLY",
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const DOCUMENT_TYPES = [
  "referral_letter",
  "insurance",
  "demographics",
  "medical_aid_card",
  "identity_document",
  "consent_form",
  "prior_results",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const MEASURE_PROVENANCE = [
  "OBSERVED",
  "DERIVED",
  "ESTIMATED",
  "UNKNOWN",
] as const;
export type MeasureProvenance = (typeof MEASURE_PROVENANCE)[number];

// ---------------------------------------------------------------------------
// Connector capabilities and operations.
// ---------------------------------------------------------------------------

export const CAPABILITIES = [
  "patient.lookup",
  "patient.create",
  "patient.update",
  "referral.create",
  "referral.attach_document",
  "referral.status.read",
  "referral.status.update",
  "appointment.availability.read",
  /**
   * Temporary reservation of a slot. A destination that cannot hold does not
   * declare it; its slots are unheld and booking revalidates at commit.
   */
  "appointment.hold",
  "appointment.create",
  "appointment.reschedule",
  "appointment.cancel",
  "appointment.status.read",
  "message.prepare",
  "message.send",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface OperationSpec {
  capability: Capability;
  /** Case types allowed to authorise this operation. */
  caseTypes: readonly CaseType[];
  /** A consequential operation changes a foreign system of record. */
  consequential: boolean;
}
/**
 * Operations the execution plane understands. An outbox item naming an
 * operation that is absent here, or whose case type is not listed, is refused
 * before any foreign I/O.
 */
export const OPERATIONS = {
  "referral.create": {
    capability: "referral.create",
    caseTypes: ["REFERRAL"],
    consequential: true,
  },
  /** A read: never mutates the destination; retried freely. */
  "appointment.availability.read": {
    capability: "appointment.availability.read",
    caseTypes: ["APPOINTMENT_REQUEST", "RESCHEDULING_REQUEST"],
    consequential: false,
  },
  /** Creates a reservation at the destination: reconciled, never re-sent. */
  "appointment.hold": {
    capability: "appointment.hold",
    caseTypes: ["APPOINTMENT_REQUEST", "RESCHEDULING_REQUEST"],
    consequential: true,
  },
  /** Releasing a hold twice is harmless; an unreleased hold expires. */
  "appointment.hold.release": {
    capability: "appointment.hold",
    caseTypes: ["APPOINTMENT_REQUEST", "RESCHEDULING_REQUEST"],
    consequential: false,
  },
  "appointment.create": {
    capability: "appointment.create",
    caseTypes: ["APPOINTMENT_REQUEST"],
    consequential: true,
  },
  "appointment.cancel": {
    capability: "appointment.cancel",
    caseTypes: ["CANCELLATION_REQUEST"],
    consequential: true,
  },
  /** Step 1 of a reschedule: commit the replacement appointment B. */
  "appointment.reschedule": {
    capability: "appointment.reschedule",
    caseTypes: ["RESCHEDULING_REQUEST"],
    consequential: true,
  },
  /**
   * Read a committed appointment back from the destination. Every booking
   * and every reschedule's replacement B is verified before it counts; a
   * reschedule touches A only after this succeeds for B.
   */
  "appointment.verify": {
    capability: "appointment.status.read",
    caseTypes: ["APPOINTMENT_REQUEST", "RESCHEDULING_REQUEST"],
    consequential: false,
  },
  /** Step 3: cancel the original appointment A, only after B is verified. */
  "appointment.reschedule.cancel_original": {
    capability: "appointment.reschedule",
    caseTypes: ["RESCHEDULING_REQUEST"],
    consequential: true,
  },
} as const satisfies Record<string, OperationSpec>;
export type Operation = keyof typeof OPERATIONS;
export const OPERATION_NAMES = Object.keys(OPERATIONS) as Operation[];

export const subjectSchema = z
  .object({
    type: z.enum(["referral", "case"]),
    id: uuid,
  })
  .strict();
export type Subject = z.infer<typeof subjectSchema>;

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

export const COMMAND_TYPES = [
  "referral.ingest",
  "case.interaction",
  "case.action",
  "work.resolve",
  "observation.import",
  "rule_set.create",
  "rule_set.publish",
  "rule_set.retire",
  "membership.upsert",
  /** A step of the booking sub-flow on an appointment operations case. */
  "appointment.action",
  /** Confirmation, reschedule or cancellation of a committed appointment. */
  "appointment.change",
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const actorSchema = z
  .object({
    type: z.enum(ACTOR_TYPES),
    id: z.string().min(1).max(200),
    role: z.enum(STAFF_ROLES).nullable(),
  })
  .strict();
export type Actor = z.infer<typeof actorSchema>;

export const commandSchema = z
  .object({
    schema_version: z.literal("command.v2"),
    command_id: uuid,
    tenant_id: uuid,
    type: z.enum(COMMAND_TYPES),
    actor: actorSchema,
    case_id: uuid.nullable(),
    subject: subjectSchema.nullable(),
    correlation_id: uuid,
    causation_id: uuid.nullable(),
    expected_version: z.number().int().nonnegative().nullable(),
    issued_at: z.iso.datetime(),
    /** SHA-256 of the canonical, material request content. */
    request_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;

// ---------------------------------------------------------------------------
// Referral extraction. v1 is the historical fixture contract; v2 adds the
// administrative fields the versioned rule sets evaluate. Neither schema
// carries clinical classification.
// ---------------------------------------------------------------------------

const patientSchema = z
  .object({
    given_name: z.string().min(1).max(200),
    family_name: z.string().min(1).max(200),
    date_of_birth: z.iso.date(),
    external_id: z.string().min(1).max(100).optional(),
  })
  .strict();
export const extractedReferralSchema = z
  .object({
    schema_version: z.literal("referral-extraction.v1"),
    patient: patientSchema,
    referrer: z.object({ name: z.string().min(1) }),
    reason: z.string().min(1),
    documents: z.array(
      z.enum(["referral_letter", "insurance", "demographics"]),
    ),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export const FUNDING_TYPES = [
  "MEDICAL_AID",
  "SELF_PAY",
  "OTHER",
  "UNKNOWN",
] as const;
export const extractedReferralV2Schema = z
  .object({
    schema_version: z.literal("referral-extraction.v2"),
    patient: patientSchema,
    referrer: z.object({ name: z.string().min(1).max(200) }).strict(),
    /** Free text from the referral. Stored, never logged, never interpreted. */
    reason: z.string().max(4000).optional(),
    requested_service: z
      .string()
      .regex(/^[A-Z0-9_]{2,64}$/)
      .optional(),
    referral_date: z.iso.date().optional(),
    funding: z
      .object({
        type: z.enum(FUNDING_TYPES),
        scheme: z.string().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
    documents: z.array(z.enum(DOCUMENT_TYPES)),
    confidence: z.number().min(0).max(1),
    /** How the fields were obtained: never presented as machine-verified. */
    provenance: z.enum(["FIXTURE", "STAFF_ENTERED"]),
  })
  .strict();
export type ExtractedReferral = z.infer<typeof extractedReferralSchema>;
export type ExtractedReferralV2 = z.infer<typeof extractedReferralV2Schema>;
export const anyExtractionSchema = z.union([
  extractedReferralSchema,
  extractedReferralV2Schema,
]);
export type AnyExtraction = z.infer<typeof anyExtractionSchema>;

// ---------------------------------------------------------------------------
// Connector contracts.
// ---------------------------------------------------------------------------

export const connectorRequestSchema = z
  .object({
    schema_version: z.literal("connector-request.v1"),
    execution_id: uuid,
    tenant_id: uuid,
    case_id: uuid,
    subject: subjectSchema,
    operation: z.enum(OPERATION_NAMES as [Operation, ...Operation[]]),
    correlation_id: uuid,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ConnectorRequest = z.infer<typeof connectorRequestSchema>;

export const connectorResultSchema = z.discriminatedUnion("status", [
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("SUCCEEDED"),
    external_id: z.string().min(1).max(200),
    /**
     * Operation-specific result (appointment operations). Validated by the
     * dispatcher against the schema for the operation before it is used.
     */
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  /**
   * Read-back only: the destination authoritatively holds no effect for this
   * execution_id. It is the one result that permits a retry after ambiguity.
   */
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("NOT_COMMITTED"),
    basis: z.string().min(1).max(200),
  }),
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("RETRYABLE"),
    code: z.string(),
  }),
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("PERMANENT"),
    code: z.string(),
  }),
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("DEFERRED"),
    descriptor: z.string(),
  }),
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("AMBIGUOUS"),
    unknown: z.string(),
  }),
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("UNSUPPORTED_OPERATION"),
    capability: z.string(),
  }),
]);
export type ConnectorResult = z.infer<typeof connectorResultSchema>;

export const referralStatusSchema = z
  .object({
    schema_version: z.literal("referral-status.v1"),
    destination_reference: z.string().min(1),
    status: z.enum([
      "NOT_FOUND",
      "RECEIVED",
      "ACCEPTED",
      "BOOKING_REQUESTED",
      "CLOSED",
      "UNKNOWN",
    ]),
    observed_at: z.iso.datetime(),
  })
  .strict();
export type ReferralStatus = z.infer<typeof referralStatusSchema>;

export const appointmentOutcomeSchema = z
  .object({
    schema_version: z.literal("appointment-outcome.v1"),
    destination_reference: z.string().min(1),
    outcome: z.enum([
      "NONE",
      "BOOKING_REQUESTED",
      "BOOKED",
      "CANCELLED",
      "PATIENT_UNREACHABLE",
      "PATIENT_DECLINED",
      "PROVIDER_DECLINED",
      "UNKNOWN",
    ]),
    occurred_at: z.iso.datetime().nullable(),
    /** Stable identifier of the foreign event; makes re-reads idempotent. */
    source_reference: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type AppointmentOutcome = z.infer<typeof appointmentOutcomeSchema>;

// ---------------------------------------------------------------------------
// Appointment operations. Business state of the booking sub-flow lives on the
// appointment request; connector execution state stays on executions.
// ---------------------------------------------------------------------------

export const APPOINTMENT_WORKFLOW_STATUSES = [
  // APPOINTMENT_REQUEST and RESCHEDULING_REQUEST
  "AVAILABILITY_REQUESTED",
  "AVAILABILITY_RETURNED",
  "NO_AVAILABILITY",
  "SLOT_SELECTED",
  "HOLD_REQUESTED",
  "HELD",
  "BOOKING_SUBMITTED",
  // APPOINTMENT_REQUEST: committed at the destination, then read back.
  "COMMITTED",
  "BOOKED",
  // RESCHEDULING_REQUEST: B committed, then verified, then A cancelled.
  "REPLACEMENT_BOOKED",
  "ORIGINAL_CANCELLATION_PENDING",
  "COMPLETED",
  // CANCELLATION_REQUEST
  "CANCELLATION_REQUESTED",
  "CANCELLATION_SUBMITTED",
  "CANCELLED",
  // Any request withdrawn before it took effect.
  "WITHDRAWN",
] as const;
export type AppointmentWorkflowStatus =
  (typeof APPOINTMENT_WORKFLOW_STATUSES)[number];
export const APPOINTMENT_STATUSES = [
  "BOOKED",
  "CANCELLED",
  "SUPERSEDED",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export const HOLD_STATUSES = [
  "ACTIVE",
  "CONSUMED",
  "RELEASED",
  "EXPIRED",
] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];
export const CONFIRMATION_STATUSES = ["UNCONFIRMED", "CONFIRMED"] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];
/**
 * How staff learned that the patient confirmed. "Booked" and "patient
 * confirmed" are different facts; ACCESS sends no messages in v1, so a
 * confirmation is always a staff attestation.
 */
export const CONFIRMATION_METHODS = [
  "PHONE",
  "IN_PERSON",
  "WRITTEN",
  "OTHER",
] as const;
export const CANCELLATION_REASONS = [
  "PATIENT_REQUEST",
  "PROVIDER_REQUEST",
  "DUPLICATE_BOOKING",
  "ADMINISTRATIVE",
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/** IANA time zone, validated by the runtime's own time zone database. */
export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/.test(tz);
    } catch {
      return false;
    }
  }, "unknown time zone");
/** Opaque destination identifiers: no free text, no patient data. */
export const referenceSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);

export const appointmentSlotSchema = z
  .object({
    slot_reference: referenceSchema,
    provider_reference: referenceSchema.nullable(),
    location_reference: referenceSchema.nullable(),
    start_at: z.iso.datetime(),
    end_at: z.iso.datetime(),
    timezone: timezoneSchema,
    /** The destination can reserve this slot before commit. */
    hold_supported: z.boolean(),
    /** Set when the slot is already held for this request. */
    hold_expires_at: z.iso.datetime().nullable(),
  })
  .strict()
  .refine((s) => s.end_at > s.start_at, "slot must end after it starts");
export type AppointmentSlot = z.infer<typeof appointmentSlotSchema>;

/**
 * Administrative context the destination needs to book: the referral as the
 * destination knows it and the requested service. Never names or dates of
 * birth; the destination already holds the patient record.
 */
export const bookingContextSchema = z
  .object({
    destination_referral_reference: z.string().min(1).max(200),
    patient_reference: z.string().min(1).max(100).nullable(),
    service_code: z
      .string()
      .regex(/^[A-Z0-9_]{2,64}$/)
      .nullable(),
    destination_queue: referenceSchema.nullable(),
  })
  .strict();
export type BookingContext = z.infer<typeof bookingContextSchema>;

export const appointmentSearchSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    timezone: timezoneSchema,
    provider_reference: referenceSchema.optional(),
    location_reference: referenceSchema.optional(),
    duration_minutes: z.number().int().min(5).max(480).optional(),
  })
  .strict()
  .refine((s) => new Date(s.to) > new Date(s.from), {
    message: "search window must end after it starts",
  })
  .refine(
    (s) =>
      new Date(s.to).getTime() - new Date(s.from).getTime() <=
      62 * 24 * 3600_000,
    { message: "search window is limited to 62 days" },
  );
export type AppointmentSearch = z.infer<typeof appointmentSearchSchema>;

/** Payload of appointment.availability.read. A read: nothing is reserved. */
export const availabilityQuerySchema = z
  .object({
    schema_version: z.literal("appointment-availability-query.v1"),
    context: bookingContextSchema,
    search: appointmentSearchSchema,
  })
  .strict();
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/** SUCCEEDED.data of appointment.availability.read. */
export const availabilityResultSchema = z
  .object({
    schema_version: z.literal("appointment-availability.v1"),
    observed_at: z.iso.datetime(),
    slots: z.array(appointmentSlotSchema).max(200),
  })
  .strict();
export type AvailabilityResult = z.infer<typeof availabilityResultSchema>;

/** Payload of appointment.hold. */
export const holdRequestSchema = z
  .object({
    schema_version: z.literal("appointment-hold-request.v1"),
    context: bookingContextSchema,
    slot: appointmentSlotSchema,
    ttl_seconds: z.number().int().min(30).max(3600),
  })
  .strict();
/** SUCCEEDED.data of appointment.hold (and of its read-back). */
export const holdResultSchema = z
  .object({
    schema_version: z.literal("appointment-hold.v1"),
    hold_reference: referenceSchema,
    slot_reference: referenceSchema,
    expires_at: z.iso.datetime(),
  })
  .strict();
export type HoldResult = z.infer<typeof holdResultSchema>;

/** Payload of appointment.hold.release. */
export const holdReleaseSchema = z
  .object({
    schema_version: z.literal("appointment-hold-release.v1"),
    hold_reference: referenceSchema,
    slot_reference: referenceSchema,
  })
  .strict();

/**
 * Payload of appointment.create and appointment.reschedule: the exact slot
 * selected by staff, the hold to consume (if any) and, for a reschedule, the
 * appointment being replaced.
 */
export const bookingRequestSchema = z
  .object({
    schema_version: z.literal("appointment-booking-request.v1"),
    context: bookingContextSchema,
    slot: appointmentSlotSchema,
    hold_reference: referenceSchema.nullable(),
    replaces_appointment_reference: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type BookingRequest = z.infer<typeof bookingRequestSchema>;

/** SUCCEEDED.data of a committed appointment (create, reschedule, read-back). */
export const appointmentCommitSchema = z
  .object({
    schema_version: z.literal("appointment-commit.v1"),
    appointment_reference: z.string().min(1).max(200),
    slot_reference: referenceSchema,
    start_at: z.iso.datetime(),
    end_at: z.iso.datetime(),
    timezone: timezoneSchema,
    provider_reference: referenceSchema.nullable(),
    location_reference: referenceSchema.nullable(),
    patient_reference: z.string().min(1).max(100).nullable(),
  })
  .strict();
export type AppointmentCommit = z.infer<typeof appointmentCommitSchema>;

/**
 * Payload of appointment.verify as sent. The planned outbox row names only
 * the committing execution; the worker fills in its appointment's reference.
 */
export const verifyRequestSchema = z
  .object({
    schema_version: z.literal("appointment-verify-request.v1"),
    appointment_reference: z.string().min(1).max(200),
  })
  .strict();
/** SUCCEEDED.data of appointment.verify. */
export const appointmentVerificationSchema = z
  .object({
    schema_version: z.literal("appointment-status.v1"),
    appointment_reference: z.string().min(1).max(200),
    status: z.enum(["BOOKED", "CANCELLED", "NOT_FOUND"]),
    observed_at: z.iso.datetime(),
  })
  .strict();
export type AppointmentVerification = z.infer<
  typeof appointmentVerificationSchema
>;

/** Payload of appointment.cancel and appointment.reschedule.cancel_original. */
export const cancellationRequestSchema = z
  .object({
    schema_version: z.literal("appointment-cancellation-request.v1"),
    appointment_reference: z.string().min(1).max(200),
    reason: z.enum([...CANCELLATION_REASONS, "RESCHEDULED"] as const),
    replaced_by_reference: z.string().min(1).max(200).nullable(),
  })
  .strict();
/** SUCCEEDED.data of a cancellation (and of its read-back). */
export const cancellationResultSchema = z
  .object({
    schema_version: z.literal("appointment-cancellation.v1"),
    appointment_reference: z.string().min(1).max(200),
    cancelled_at: z.iso.datetime(),
  })
  .strict();
export type CancellationResult = z.infer<typeof cancellationResultSchema>;

// ---------------------------------------------------------------------------
// HTTP request contracts.
// ---------------------------------------------------------------------------

const artifactUpload = {
  filename: z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/),
  media_type: z.enum(["application/pdf", "application/json", "text/plain"]),
  content_base64: z.string().min(1).max(14_000_000),
};

export const structuredReferralSchema = z
  .object({
    patient: patientSchema,
    referrer: z.object({ name: z.string().min(1).max(200) }).strict(),
    requested_service: z
      .string()
      .regex(/^[A-Z0-9_]{2,64}$/)
      .optional(),
    referral_date: z.iso.date().optional(),
    funding: z
      .object({
        type: z.enum(FUNDING_TYPES),
        scheme: z.string().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
    documents: z.array(z.enum(DOCUMENT_TYPES)).max(20),
    reason: z.string().max(4000).optional(),
    /**
     * Staff judgement that the referral looks urgent or clinical. ACCESS does
     * not interpret this: it routes the case to the human safety workflow.
     */
    safety_flag: z.boolean().default(false),
  })
  .strict();
export type StructuredReferral = z.infer<typeof structuredReferralSchema>;

export const ingestRequestSchema = z
  .object({
    command_id: uuid,
    /** Optional: must equal the authenticated tenant when present. */
    tenant_id: uuid.optional(),
    referral_id: uuid,
    correlation_id: uuid,
    expected_version: z.literal(0),
    channel: z.enum(CHANNELS).default("STAFF_UPLOAD"),
    idempotency_key: z.string().min(8).max(200).optional(),
    ...artifactUpload,
    /** Synthetic-only deterministic extractor fixture. */
    fixture: z
      .enum(["complete", "missing-insurance", "ambiguous-identity", "urgent"])
      .optional(),
    structured: structuredReferralSchema.optional(),
  })
  .strict()
  .refine((x) => !(x.fixture && x.structured), {
    message: "supply either fixture or structured, not both",
  });
export type IngestRequest = z.infer<typeof ingestRequestSchema>;

export const createCaseRequestSchema = z
  .object({ case_type: z.enum(CASE_TYPES) })
  .passthrough();

const fieldsPatch = z
  .object({
    requested_service: z
      .string()
      .regex(/^[A-Z0-9_]{2,64}$/)
      .optional(),
    referral_date: z.iso.date().optional(),
    funding: z
      .object({
        type: z.enum(FUNDING_TYPES),
        scheme: z.string().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
    patient_external_id: z.string().min(1).max(100).optional(),
    referrer_name: z.string().min(1).max(200).optional(),
  })
  .strict();
export type FieldsPatch = z.infer<typeof fieldsPatch>;

export const interactionRequestSchema = z
  .object({
    command_id: uuid,
    correlation_id: uuid,
    idempotency_key: z.string().min(8).max(200).optional(),
    channel: z.enum(CHANNELS).default("STAFF_UPLOAD"),
    intent: z.enum([
      "MISSING_INFORMATION",
      "STATUS_ENQUIRY",
      "OUTCOME_REPORT",
      "OTHER",
    ]),
    actor_type: z.enum(["STAFF", "PATIENT", "PROVIDER", "INTEGRATION"]),
    expected_version: z.number().int().nonnegative().optional(),
    note: z.string().min(1).max(1000).optional(),
    staff_seconds: z.number().int().positive().max(86_400).optional(),
    artifact: z
      .object({
        ...artifactUpload,
        document_types: z.array(z.enum(DOCUMENT_TYPES)).min(1).max(10),
      })
      .strict()
      .optional(),
    fields: fieldsPatch.optional(),
  })
  .strict();
export type InteractionRequest = z.infer<typeof interactionRequestSchema>;

const actionBase = {
  command_id: uuid,
  correlation_id: uuid,
  expected_version: z.number().int().nonnegative(),
  note: z.string().trim().min(1).max(1000),
  /** Optional, self-reported handling time; unknown stays unknown. */
  staff_seconds: z.number().int().positive().max(86_400).optional(),
};
export const caseActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm_identity"), ...actionBase }).strict(),
  z
    .object({
      action: z.literal("provide_information"),
      ...actionBase,
      documents: z.array(z.enum(DOCUMENT_TYPES)).max(10).default([]),
      fields: fieldsPatch.optional(),
      structured: structuredReferralSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve_exception"),
      ...actionBase,
      work_item_id: uuid,
      resolution: z.enum([
        "safety_reviewed",
        "file_reviewed",
        "retry_destination",
        "acknowledge",
      ]),
      /** Required when retrying after an unresolved ambiguous write. */
      attest_not_committed: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal("record_destination_reference"),
      ...actionBase,
      destination_reference: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("record_follow_up"),
      ...actionBase,
      follow_up_due_at: z.iso.datetime().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("record_booking"),
      ...actionBase,
      occurred_at: z.iso.datetime(),
      appointment_reference: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("record_patient_unreachable"),
      ...actionBase,
      occurred_at: z.iso.datetime().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("record_patient_declined"),
      ...actionBase,
      occurred_at: z.iso.datetime().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("record_provider_declined"),
      ...actionBase,
      occurred_at: z.iso.datetime().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("close"),
      ...actionBase,
      resolution_code: z.enum(REFERRAL_RESOLUTION_CODES),
      occurred_at: z.iso.datetime().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reject"),
      ...actionBase,
      resolution_code: z.enum(["INVALID_REFERRAL", "DUPLICATE_REFERRAL"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("correct_outcome"),
      ...actionBase,
      observation_id: uuid,
    })
    .strict(),
  /**
   * Open an APPOINTMENT_REQUEST for a referral that is ready for booking and
   * ask the destination for availability. Nothing is reserved or booked.
   */
  z
    .object({
      action: z.literal("start_booking"),
      ...actionBase,
      search: appointmentSearchSchema,
    })
    .strict(),
]);
export type CaseAction = z.infer<typeof caseActionSchema>;
export type CaseActionName = CaseAction["action"];
export const CASE_ACTIONS = caseActionSchema.options.map(
  (o) => o.shape.action.value,
) as [CaseActionName, ...CaseActionName[]];

/** Legacy v1 resolution endpoint, mapped onto case actions. */
export const resolutionSchema = z
  .object({
    command_id: uuid,
    correlation_id: uuid,
    expected_version: z.number().int().positive(),
    resolution: z.enum([
      "confirm_identity",
      "provide_insurance",
      "approve_deferred",
      "reject",
    ]),
    note: z.string().min(1).max(500),
  })
  .strict();

export const observationImportSchema = z
  .object({
    command_id: uuid,
    correlation_id: uuid,
    source_label: z.string().min(1).max(120),
    rows: z
      .array(
        z
          .object({
            case_id: uuid,
            observation_type: z.enum([
              "BOOKING_REQUESTED",
              "APPOINTMENT_BOOKED",
              "APPOINTMENT_CANCELLED",
              "PATIENT_UNREACHABLE",
              "PATIENT_DECLINED",
              "PROVIDER_DECLINED",
              "REFERRAL_CLOSED",
            ]),
            occurred_at: z.iso.datetime(),
            source_reference: z.string().min(1).max(200),
            resolution_code: z.enum(REFERRAL_RESOLUTION_CODES).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type ObservationImport = z.infer<typeof observationImportSchema>;

export const membershipUpsertSchema = z
  .object({
    command_id: uuid,
    user_id: uuid,
    role: z.enum(STAFF_ROLES),
    status: z.enum(["ACTIVE", "SUSPENDED"]),
  })
  .strict();

export const cohortQuerySchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .strict();

const appointmentActionBase = {
  command_id: uuid,
  correlation_id: uuid,
  /**
   * Version of the appointment request (the booking sub-flow). Every step
   * and every destination result increments it, so a stale view is refused.
   */
  expected_version: z.number().int().nonnegative(),
  note: z.string().trim().min(1).max(1000).optional(),
  staff_seconds: z.number().int().positive().max(86_400).optional(),
};
const requiredNote = z.string().trim().min(1).max(1000);
/**
 * Steps of the booking sub-flow on an APPOINTMENT_REQUEST,
 * RESCHEDULING_REQUEST or CANCELLATION_REQUEST case. Each is a command; the
 * worker performs every foreign effect.
 */
export const appointmentActionSchema = z.discriminatedUnion("action", [
  /** Ask the destination for (fresh) availability. A read. */
  z
    .object({
      action: z.literal("search"),
      ...appointmentActionBase,
      search: appointmentSearchSchema.optional(),
    })
    .strict(),
  /** Choose one slot from the latest, still fresh availability. */
  z
    .object({
      action: z.literal("select"),
      ...appointmentActionBase,
      slot_reference: referenceSchema,
    })
    .strict(),
  /** Reserve the selected slot, where the destination supports holds. */
  z.object({ action: z.literal("hold"), ...appointmentActionBase }).strict(),
  /**
   * Consequential: book the selected slot (APPOINTMENT_REQUEST), commit the
   * replacement then cancel the original (RESCHEDULING_REQUEST), or cancel the
   * appointment (CANCELLATION_REQUEST).
   */
  z.object({ action: z.literal("commit"), ...appointmentActionBase }).strict(),
  /** Abandon the request. Refused while any foreign effect is unresolved. */
  z
    .object({
      action: z.literal("withdraw"),
      ...appointmentActionBase,
      note: requiredNote,
    })
    .strict(),
  /** Read the destination again after automated checking stopped. */
  z.object({ action: z.literal("recheck"), ...appointmentActionBase }).strict(),
  /** Staff checked the destination: the unresolved write is not there. */
  z
    .object({
      action: z.literal("attest_not_committed"),
      ...appointmentActionBase,
      note: requiredNote,
    })
    .strict(),
  /**
   * Reschedule only: staff checked the destination and the original
   * appointment is cancelled there. Closes the "both may exist" exception.
   */
  z
    .object({
      action: z.literal("attest_original_cancelled"),
      ...appointmentActionBase,
      note: requiredNote,
    })
    .strict(),
]);
export type AppointmentAction = z.infer<typeof appointmentActionSchema>;
export type AppointmentActionName = AppointmentAction["action"];
export const APPOINTMENT_ACTIONS = appointmentActionSchema.options.map(
  (o) => o.shape.action.value,
) as [AppointmentActionName, ...AppointmentActionName[]];

const appointmentChangeBase = {
  command_id: uuid,
  correlation_id: uuid,
  /** Version of the appointment itself. */
  expected_version: z.number().int().nonnegative(),
};
/** Actions on a committed appointment. */
export const appointmentChangeSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("confirm"),
      ...appointmentChangeBase,
      method: z.enum(CONFIRMATION_METHODS),
      note: z.string().trim().min(1).max(1000).optional(),
    })
    .strict(),
  /** Open a RESCHEDULING_REQUEST and search for a replacement. */
  z
    .object({
      action: z.literal("reschedule"),
      ...appointmentChangeBase,
      note: requiredNote,
      search: appointmentSearchSchema,
    })
    .strict(),
  /** Open a CANCELLATION_REQUEST; it is committed separately. */
  z
    .object({
      action: z.literal("cancel"),
      ...appointmentChangeBase,
      note: requiredNote,
      reason: z.enum(CANCELLATION_REASONS),
    })
    .strict(),
]);
export type AppointmentChange = z.infer<typeof appointmentChangeSchema>;
export type AppointmentChangeName = AppointmentChange["action"];
export const APPOINTMENT_CHANGES = appointmentChangeSchema.options.map(
  (o) => o.shape.action.value,
) as [AppointmentChangeName, ...AppointmentChangeName[]];

export const QUEUE_FILTERS = [
  "all",
  "needs_attention",
  "identity_pending",
  "information_missing",
  "ready",
  "ready_for_booking",
  "booking_in_progress",
  "waiting",
  "booked",
  "reschedule",
  "cancellation",
  "closed",
  "exceptions",
] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace.
 * Evidence hashes, rule-set hashes and request fingerprints are computed over
 * this form so that they are reproducible from stored data.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((k) => object[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(object[k])}`)
    .join(",")}}`;
}
