import { randomUUID } from "node:crypto";
import type {
  AppointmentCaseType,
  AppointmentSearch,
  AppointmentSlot,
  AppointmentStatus,
  AppointmentWorkflowStatus,
  BookingContext,
  CancellationReason,
  ConfirmationStatus,
  HoldStatus,
} from "@access/contracts";
import {
  bookingEligibility,
  patientAccessStatus,
  workflowFinished,
  workflowStep,
  type AccessStatus,
} from "@access/domain";
import {
  evaluateReferralRules,
  unmetBookingPrerequisites,
  type ReferralFacts,
} from "@access/rules";
import {
  caseSubject,
  evidence,
  lockCase,
  recordObservation,
  resolveWorkItems,
  type ActorRef,
  type CaseRow,
} from "./cases.js";
import { loadApplicableRuleSet, loadRuleSet } from "./rules.js";
import { conflict, notFound, type DbClient } from "./runtime.js";

/**
 * Data access for appointment operations. Every write happens inside the
 * caller's transaction, under the lock of the owning case; every update of a
 * request or an appointment increments its version exactly once (enforced by
 * the 0006 triggers).
 */

export interface AvailabilitySnapshot {
  execution_id: string;
  observed_at: string;
  slots: AppointmentSlot[];
}
export interface AppointmentRequestRow {
  tenant_id: string;
  case_id: string;
  case_type: AppointmentCaseType;
  origin_referral_case_id: string | null;
  original_appointment_id: string | null;
  appointment_id: string | null;
  booking_context: BookingContext;
  search: AppointmentSearch | null;
  timezone: string;
  workflow_status: AppointmentWorkflowStatus;
  availability: AvailabilitySnapshot | null;
  availability_observed_at: Date | null;
  selected_slot: AppointmentSlot | null;
  selected_slot_reference: string | null;
  selected_at: Date | null;
  current_hold_id: string | null;
  pending_execution_id: string | null;
  cancellation_reason: CancellationReason | null;
  last_failure_code: string | null;
  last_failure_at: Date | null;
  recheck_requested_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const requestColumns =
  "tenant_id,case_id,case_type,origin_referral_case_id,original_appointment_id,appointment_id,booking_context,search,timezone," +
  "workflow_status,availability,availability_observed_at,selected_slot,selected_slot_reference,selected_at,current_hold_id," +
  "pending_execution_id,cancellation_reason,last_failure_code,last_failure_at,recheck_requested_at,version,created_at,updated_at";

export async function findRequest(
  c: DbClient,
  tenantId: string,
  caseId: string,
  lock = false,
): Promise<AppointmentRequestRow | undefined> {
  const row = await c.query<AppointmentRequestRow>(
    `SELECT ${requestColumns} FROM appointment_requests WHERE tenant_id=$1 AND case_id=$2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, caseId],
  );
  return row.rows[0];
}
export async function lockRequest(
  c: DbClient,
  tenantId: string,
  caseId: string,
): Promise<AppointmentRequestRow> {
  const row = await findRequest(c, tenantId, caseId, true);
  if (!row) throw notFound("appointment request");
  return row;
}

export async function insertRequest(
  c: DbClient,
  input: {
    tenantId: string;
    caseId: string;
    caseType: AppointmentCaseType;
    originReferralCaseId: string | null;
    originalAppointmentId: string | null;
    bookingContext: BookingContext;
    search: AppointmentSearch | null;
    timezone: string;
    workflowStatus: AppointmentWorkflowStatus;
    pendingExecutionId: string | null;
    cancellationReason?: CancellationReason | null;
  },
): Promise<AppointmentRequestRow> {
  try {
    const row = await c.query<AppointmentRequestRow>(
      `INSERT INTO appointment_requests(tenant_id,case_id,case_type,origin_referral_case_id,original_appointment_id,booking_context,
                                        search,timezone,workflow_status,pending_execution_id,cancellation_reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${requestColumns}`,
      [
        input.tenantId,
        input.caseId,
        input.caseType,
        input.originReferralCaseId,
        input.originalAppointmentId,
        input.bookingContext,
        input.search,
        input.timezone,
        input.workflowStatus,
        input.pendingExecutionId,
        input.cancellationReason ?? null,
      ],
    );
    return row.rows[0]!;
  } catch (error) {
    // The partial unique indexes: one active booking per referral, one active
    // change per appointment.
    if ((error as { code?: string }).code === "23505")
      throw conflict(
        input.caseType === "APPOINTMENT_REQUEST"
          ? "BOOKING_ALREADY_ACTIVE"
          : "APPOINTMENT_CHANGE_ACTIVE",
        input.caseType === "APPOINTMENT_REQUEST"
          ? "a booking is already in progress for this referral"
          : "a reschedule or cancellation is already in progress for this appointment",
      );
    throw error;
  }
}

export type RequestPatch = Partial<
  Pick<
    AppointmentRequestRow,
    | "workflow_status"
    | "appointment_id"
    | "search"
    | "availability"
    | "availability_observed_at"
    | "selected_slot"
    | "selected_slot_reference"
    | "selected_at"
    | "current_hold_id"
    | "pending_execution_id"
    | "last_failure_code"
    | "last_failure_at"
    | "recheck_requested_at"
  >
>;
const patchable: (keyof RequestPatch)[] = [
  "workflow_status",
  "appointment_id",
  "search",
  "availability",
  "availability_observed_at",
  "selected_slot",
  "selected_slot_reference",
  "selected_at",
  "current_hold_id",
  "pending_execution_id",
  "last_failure_code",
  "last_failure_at",
  "recheck_requested_at",
];
/** Update a locked request; a workflow change must be a permitted step. */
export async function updateRequest(
  c: DbClient,
  row: AppointmentRequestRow,
  patch: RequestPatch,
): Promise<AppointmentRequestRow> {
  if (
    patch.workflow_status !== undefined &&
    patch.workflow_status !== row.workflow_status
  )
    workflowStep(row.case_type, row.workflow_status, patch.workflow_status);
  const keys = patchable.filter((k) => patch[k] !== undefined);
  const updated = await c.query<AppointmentRequestRow>(
    `UPDATE appointment_requests SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(",")}${keys.length ? "," : ""}
            version=version+1,updated_at=now()
      WHERE tenant_id=$1 AND case_id=$2 RETURNING ${requestColumns}`,
    [row.tenant_id, row.case_id, ...keys.map((k) => patch[k])],
  );
  return updated.rows[0]!;
}

/** The active booking request of a referral, if any. */
export async function activeBookingForReferral(
  c: DbClient,
  tenantId: string,
  referralCaseId: string,
): Promise<AppointmentRequestRow | undefined> {
  const row = await c.query<AppointmentRequestRow>(
    `SELECT ${requestColumns} FROM appointment_requests
      WHERE tenant_id=$1 AND origin_referral_case_id=$2 AND case_type='APPOINTMENT_REQUEST'
        AND workflow_status NOT IN ('BOOKED','WITHDRAWN')`,
    [tenantId, referralCaseId],
  );
  return row.rows[0];
}
/** Every appointment operations request that serves a referral. */
export async function requestsForReferral(
  c: DbClient,
  tenantId: string,
  referralCaseId: string,
): Promise<AppointmentRequestRow[]> {
  const rows = await c.query<AppointmentRequestRow>(
    `SELECT ${requestColumns} FROM appointment_requests
      WHERE tenant_id=$1 AND (origin_referral_case_id=$2 OR original_appointment_id IN
            (SELECT id FROM appointments WHERE tenant_id=$1 AND origin_referral_case_id=$2))
      ORDER BY created_at`,
    [tenantId, referralCaseId],
  );
  return rows.rows;
}

export interface AppointmentRow {
  id: string;
  tenant_id: string;
  source_case_id: string;
  origin_referral_case_id: string | null;
  destination: string;
  external_reference: string;
  slot_reference: string;
  provider_reference: string | null;
  location_reference: string | null;
  service_code: string | null;
  patient_reference: string | null;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  status: AppointmentStatus;
  committed_at: Date;
  commit_source: "CONNECTOR" | "RECONCILIATION";
  create_execution_id: string;
  cancelled_at: Date | null;
  cancellation_source: "CONNECTOR" | "RECONCILIATION" | "STAFF" | null;
  replaces_appointment_id: string | null;
  superseded_by_id: string | null;
  confirmation_status: ConfirmationStatus;
  confirmed_at: Date | null;
  confirmation_source: "STAFF" | null;
  confirmation_method: string | null;
  confirmed_by: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const appointmentColumns =
  "id,tenant_id,source_case_id,origin_referral_case_id,destination,external_reference,slot_reference,provider_reference," +
  "location_reference,service_code,patient_reference,starts_at,ends_at,timezone,status,committed_at,commit_source," +
  "create_execution_id,cancelled_at,cancellation_source,replaces_appointment_id,superseded_by_id,confirmation_status," +
  "confirmed_at,confirmation_source,confirmation_method,confirmed_by,version,created_at,updated_at";

export async function findAppointment(
  c: DbClient,
  tenantId: string,
  id: string,
  lock = false,
): Promise<AppointmentRow | undefined> {
  const row = await c.query<AppointmentRow>(
    `SELECT ${appointmentColumns} FROM appointments WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, id],
  );
  return row.rows[0];
}
export async function lockAppointment(
  c: DbClient,
  tenantId: string,
  id: string,
): Promise<AppointmentRow> {
  const row = await findAppointment(c, tenantId, id, true);
  if (!row) throw notFound("appointment");
  return row;
}
export async function appointmentByExecution(
  c: DbClient,
  tenantId: string,
  executionId: string,
): Promise<AppointmentRow | undefined> {
  const row = await c.query<AppointmentRow>(
    `SELECT ${appointmentColumns} FROM appointments WHERE tenant_id=$1 AND create_execution_id=$2`,
    [tenantId, executionId],
  );
  return row.rows[0];
}
export async function appointmentsForReferral(
  c: DbClient,
  tenantId: string,
  referralCaseId: string,
): Promise<AppointmentRow[]> {
  const rows = await c.query<AppointmentRow>(
    `SELECT ${appointmentColumns} FROM appointments WHERE tenant_id=$1 AND origin_referral_case_id=$2 ORDER BY committed_at,id`,
    [tenantId, referralCaseId],
  );
  return rows.rows;
}

/**
 * Record a committed foreign appointment. Idempotent per committing
 * execution: settling the same result twice returns the same row.
 */
export async function insertAppointment(
  c: DbClient,
  input: {
    tenantId: string;
    sourceCaseId: string;
    originReferralCaseId: string | null;
    destination: string;
    externalReference: string;
    slotReference: string;
    providerReference: string | null;
    locationReference: string | null;
    serviceCode: string | null;
    patientReference: string | null;
    startsAt: string;
    endsAt: string;
    timezone: string;
    commitSource: "CONNECTOR" | "RECONCILIATION";
    createExecutionId: string;
    replacesAppointmentId: string | null;
  },
): Promise<AppointmentRow> {
  const inserted = await c.query<AppointmentRow>(
    `INSERT INTO appointments(id,tenant_id,source_case_id,origin_referral_case_id,destination,external_reference,slot_reference,
                              provider_reference,location_reference,service_code,patient_reference,starts_at,ends_at,timezone,
                              status,committed_at,commit_source,create_execution_id,replaces_appointment_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'BOOKED',now(),$15,$16,$17)
     ON CONFLICT (tenant_id,create_execution_id) DO NOTHING RETURNING ${appointmentColumns}`,
    [
      randomUUID(),
      input.tenantId,
      input.sourceCaseId,
      input.originReferralCaseId,
      input.destination,
      input.externalReference,
      input.slotReference,
      input.providerReference,
      input.locationReference,
      input.serviceCode,
      input.patientReference,
      input.startsAt,
      input.endsAt,
      input.timezone,
      input.commitSource,
      input.createExecutionId,
      input.replacesAppointmentId,
    ],
  );
  return (
    inserted.rows[0] ??
    (await appointmentByExecution(c, input.tenantId, input.createExecutionId))!
  );
}

export type AppointmentPatch = Partial<
  Pick<
    AppointmentRow,
    | "status"
    | "cancelled_at"
    | "cancellation_source"
    | "superseded_by_id"
    | "confirmation_status"
    | "confirmed_at"
    | "confirmation_source"
    | "confirmation_method"
    | "confirmed_by"
  >
>;
export async function updateAppointment(
  c: DbClient,
  row: AppointmentRow,
  patch: AppointmentPatch,
): Promise<AppointmentRow> {
  const keys = (Object.keys(patch) as (keyof AppointmentPatch)[]).filter(
    (k) => patch[k] !== undefined,
  );
  const updated = await c.query<AppointmentRow>(
    `UPDATE appointments SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(",")}${keys.length ? "," : ""}
            version=version+1,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING ${appointmentColumns}`,
    [row.tenant_id, row.id, ...keys.map((k) => patch[k])],
  );
  return updated.rows[0]!;
}

export interface HoldRow {
  id: string;
  tenant_id: string;
  case_id: string;
  slot_reference: string;
  hold_reference: string;
  execution_id: string;
  status: HoldStatus;
  created_at: Date;
  expires_at: Date;
  closed_at: Date | null;
}
const holdColumns =
  "id,tenant_id,case_id,slot_reference,hold_reference,execution_id,status,created_at,expires_at,closed_at";

export async function findHold(
  c: DbClient,
  tenantId: string,
  id: string,
): Promise<HoldRow | undefined> {
  const row = await c.query<HoldRow>(
    `SELECT ${holdColumns} FROM appointment_slot_holds WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [tenantId, id],
  );
  return row.rows[0];
}
export async function holdsForRequest(
  c: DbClient,
  tenantId: string,
  caseId: string,
): Promise<HoldRow[]> {
  const rows = await c.query<HoldRow>(
    `SELECT ${holdColumns} FROM appointment_slot_holds WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at,id`,
    [tenantId, caseId],
  );
  return rows.rows;
}
/** A hold that is already past its expiry is recorded as EXPIRED. */
export async function insertHold(
  c: DbClient,
  input: {
    tenantId: string;
    caseId: string;
    slotReference: string;
    holdReference: string;
    executionId: string;
    expiresAt: string;
  },
): Promise<HoldRow> {
  const inserted = await c.query<HoldRow>(
    `INSERT INTO appointment_slot_holds(id,tenant_id,case_id,slot_reference,hold_reference,execution_id,status,expires_at,closed_at)
     VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::timestamptz > now() THEN 'ACTIVE' ELSE 'EXPIRED' END,$7,
            CASE WHEN $7::timestamptz > now() THEN NULL ELSE now() END)
     ON CONFLICT (tenant_id,execution_id) DO NOTHING RETURNING ${holdColumns}`,
    [
      randomUUID(),
      input.tenantId,
      input.caseId,
      input.slotReference,
      input.holdReference,
      input.executionId,
      input.expiresAt,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await c.query<HoldRow>(
    `SELECT ${holdColumns} FROM appointment_slot_holds WHERE tenant_id=$1 AND execution_id=$2`,
    [input.tenantId, input.executionId],
  );
  return existing.rows[0]!;
}
/** Close an ACTIVE hold once; a closed hold is left as it is. */
export async function closeHold(
  c: DbClient,
  tenantId: string,
  id: string,
  status: Exclude<HoldStatus, "ACTIVE">,
): Promise<boolean> {
  const updated = await c.query(
    "UPDATE appointment_slot_holds SET status=$3,closed_at=now() WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
    [tenantId, id, status],
  );
  return (updated.rowCount ?? 0) > 0;
}

/** Release BLOCKED steps of a case's plan for dispatch. */
export async function releaseStep(
  c: DbClient,
  tenantId: string,
  executionId: string,
): Promise<boolean> {
  const updated = await c.query(
    `UPDATE outbox o SET status='PENDING',available_at=now()
      WHERE o.tenant_id=$1 AND o.execution_id=$2 AND o.status='BLOCKED'
        AND EXISTS (SELECT 1 FROM executions e WHERE e.tenant_id=o.tenant_id AND e.id=o.execution_id AND e.superseded_at IS NULL)`,
    [tenantId, executionId],
  );
  return (updated.rowCount ?? 0) > 0;
}
/** Close BLOCKED steps that will never run; their executions never started. */
export async function cancelBlockedSteps(
  c: DbClient,
  tenantId: string,
  caseId: string,
  by: string,
): Promise<string[]> {
  const closed = await c.query<{ execution_id: string }>(
    `UPDATE outbox SET status='DONE',last_error='NOT_ATTEMPTED' WHERE tenant_id=$1 AND case_id=$2 AND status='BLOCKED'
     RETURNING execution_id`,
    [tenantId, caseId],
  );
  const ids = closed.rows.map((r) => r.execution_id);
  if (ids.length)
    await c.query(
      `UPDATE executions SET status='PERMANENT',last_error='NOT_ATTEMPTED',superseded_at=now(),superseded_by=$3,
              superseded_reason='plan_cancelled',updated_at=now()
        WHERE tenant_id=$1 AND id = ANY($2) AND status='PENDING'`,
      [tenantId, ids, by],
    );
  return ids;
}
/** The planned (BLOCKED) step of a case for one operation. */
export async function blockedStep(
  c: DbClient,
  tenantId: string,
  caseId: string,
  operation: string,
): Promise<string | undefined> {
  const row = await c.query<{ execution_id: string }>(
    "SELECT execution_id FROM outbox WHERE tenant_id=$1 AND case_id=$2 AND operation=$3 AND status='BLOCKED' ORDER BY id LIMIT 1",
    [tenantId, caseId, operation],
  );
  return row.rows[0]?.execution_id;
}

// ---------------------------------------------------------------------------
// Shared by the API (staff commands) and the worker (settlement)
// ---------------------------------------------------------------------------

type Ctx = { tenantId: string; correlationId: string; actor: ActorRef };

export interface BookingReadiness {
  eligible: boolean;
  /** Stable reason codes; never patient data. */
  reasons: string[];
  /** What the destination needs to book; null until the referral is there. */
  context: BookingContext | null;
  /** Follow-up interval of the pinned rule set, restored on withdrawal. */
  readyForBookingHours: number;
}
/**
 * May this referral start (or still commit) an automated booking? The same
 * rule set that made it ready decides its booking prerequisites.
 */
export async function bookingReadiness(
  c: DbClient,
  tenantId: string,
  referral: CaseRow,
  options: { ignoreActiveRequest?: boolean } = {},
): Promise<BookingReadiness> {
  const found = await c.query<{
    extraction: ReferralFacts["extraction"];
    supplied_documents: ReferralFacts["supplied_documents"];
    supplied_fields: ReferralFacts["supplied_fields"];
    identity_confirmed_by: string | null;
    rule_set_id: string | null;
    destination_reference: string | null;
  }>(
    `SELECT extraction,supplied_documents,supplied_fields,identity_confirmed_by,rule_set_id,destination_reference
       FROM referrals WHERE tenant_id=$1 AND case_id=$2`,
    [tenantId, referral.id],
  );
  const r = found.rows[0];
  if (!r || referral.case_type !== "REFERRAL")
    return {
      eligible: false,
      reasons: ["NOT_A_REFERRAL"],
      context: null,
      readyForBookingHours: 48,
    };
  const ruleSet = r.rule_set_id
    ? await loadRuleSet(c, tenantId, r.rule_set_id)
    : await loadApplicableRuleSet(c, tenantId);
  const facts: ReferralFacts = {
    extraction: r.extraction,
    supplied_documents: r.supplied_documents,
    supplied_fields: r.supplied_fields,
    identity_confirmed_by_staff: Boolean(r.identity_confirmed_by),
  };
  const open = await c.query<{ kind: string }>(
    "SELECT kind FROM work_items WHERE tenant_id=$1 AND case_id=$2 AND status='OPEN'",
    [tenantId, referral.id],
  );
  const active = options.ignoreActiveRequest
    ? undefined
    : await activeBookingForReferral(c, tenantId, referral.id);
  const { eligible, reasons } = bookingEligibility({
    caseType: referral.case_type,
    state: referral.current_state,
    openWorkKinds: open.rows.map((w) => w.kind),
    unmetPrerequisites: ruleSet
      ? unmetBookingPrerequisites(
          ruleSet.definition,
          facts,
          r.destination_reference,
        )
      : ["rule_set"],
    activeRequest: Boolean(active),
  });
  const decision = ruleSet ? evaluateReferralRules(ruleSet, facts) : null;
  return {
    eligible,
    reasons,
    context: r.destination_reference
      ? {
          destination_referral_reference: r.destination_reference,
          // The destination already holds the patient behind its referral.
          patient_reference: null,
          service_code: decision?.service?.recognised
            ? decision.service.code
            : null,
          destination_queue: decision?.routing?.destination_queue ?? null,
        }
      : null,
    readyForBookingHours:
      ruleSet?.definition.follow_up.ready_for_booking_hours ?? 48,
  };
}

/**
 * The appointment operations case records the booking fact and becomes
 * BOOKED (or the fact is held for review while a person has work open).
 */
export async function bookAppointmentCase(
  c: DbClient,
  ctx: Ctx,
  caseRow: CaseRow,
  appointmentId: string,
  source: "CONNECTOR" | "RECONCILIATION" | "STAFF",
): Promise<CaseRow> {
  if (caseRow.current_state === "EXCEPTION")
    await resolveWorkItems(c, ctx, caseRow, {
      kinds: ["CONNECTOR"],
      resolution: "outcome_confirmed",
      note: null,
      staffSeconds: undefined,
      automatic: true,
    });
  const open = await c.query(
    "SELECT 1 FROM work_items WHERE tenant_id=$1 AND case_id=$2 AND status='OPEN' AND kind IN ('SAFETY','FILE_SAFETY','MANUAL_DESTINATION','OUTCOME_REVIEW')",
    [ctx.tenantId, caseRow.id],
  );
  const result = await recordObservation(c, ctx, caseRow, {
    type: "APPOINTMENT_BOOKED",
    occurredAt: new Date(),
    sourceType: source,
    sourceReference: `appointment:${appointmentId}`,
    verificationLevel:
      source === "STAFF" ? "HUMAN_ATTESTED" : "EXTERNAL_CONFIRMED",
    actorId: source === "STAFF" ? ctx.actor.id : null,
    payload: { appointment_id: appointmentId },
    plan: open.rowCount
      ? { disposition: "REVIEW", reason: "open_work_items" }
      : { disposition: "APPLIED", to: "BOOKED", resolution: "BOOKED" },
  });
  return result.caseRow;
}

/**
 * Replacement committed and verified, original cancelled (read back by the
 * worker or attested by a manager): one current appointment.
 */
export async function completeReschedule(
  c: DbClient,
  ctx: Ctx,
  caseRowIn: CaseRow,
  row: AppointmentRequestRow,
  via: "CONNECTOR" | "RECONCILIATION" | "STAFF",
  details: Record<string, unknown>,
): Promise<CaseRow> {
  let caseRow = caseRowIn;
  if (caseRow.current_state === "EXCEPTION")
    await resolveWorkItems(c, ctx, caseRow, {
      kinds: ["CONNECTOR"],
      resolution: "original_cancellation_confirmed",
      note: null,
      staffSeconds: undefined,
      automatic: true,
    });
  caseRow = await bookAppointmentCase(
    c,
    ctx,
    caseRow,
    row.appointment_id!,
    via,
  );
  await evidence(c, ctx, caseRow, caseSubject(caseRow), {
    eventType: "original_superseded",
    payload: {
      ...details,
      original_appointment_id: row.original_appointment_id,
      replacement_appointment_id: row.appointment_id,
      via,
    },
  });
  const original = await findAppointment(
    c,
    ctx.tenantId,
    row.original_appointment_id!,
  );
  if (original) {
    const source = await lockCase(c, ctx.tenantId, original.source_case_id);
    await evidence(c, ctx, source, caseSubject(source), {
      eventType: "appointment_superseded",
      payload: {
        appointment_id: original.id,
        superseded_by_id: row.appointment_id,
        rescheduling_case_id: row.case_id,
      },
    });
  }
  if (row.origin_referral_case_id) {
    const referral = await lockCase(
      c,
      ctx.tenantId,
      row.origin_referral_case_id,
    );
    // Agrees with the referral's booked outcome: recorded, not reviewed.
    const observed = await recordObservation(c, ctx, referral, {
      type: "APPOINTMENT_BOOKED",
      occurredAt: new Date(),
      sourceType: via,
      sourceReference: `appointment:${row.appointment_id}`,
      verificationLevel:
        via === "STAFF" ? "HUMAN_ATTESTED" : "EXTERNAL_CONFIRMED",
      actorId: via === "STAFF" ? ctx.actor.id : null,
      payload: {
        appointment_id: row.appointment_id,
        replaces_appointment_id: row.original_appointment_id,
      },
    });
    await evidence(c, ctx, observed.caseRow, caseSubject(observed.caseRow), {
      eventType: "appointment_rescheduled",
      payload: {
        from_appointment_id: row.original_appointment_id,
        to_appointment_id: row.appointment_id,
        rescheduling_case_id: row.case_id,
      },
    });
  }
  return caseRow;
}

/**
 * "What is happening with this referral?" from authoritative state: the
 * referral, its active appointment operations request, its appointments.
 */
export async function referralAccessStatus(
  c: DbClient,
  tenantId: string,
  referral: Pick<CaseRow, "id" | "current_state" | "resolution_code">,
): Promise<{ status: AccessStatus; label: string }> {
  const requests = await requestsForReferral(c, tenantId, referral.id);
  const active = requests.find((r) => !workflowFinished(r.workflow_status));
  const activeCase = active
    ? (
        await c.query<{ current_state: CaseRow["current_state"] }>(
          "SELECT current_state FROM access_cases WHERE tenant_id=$1 AND id=$2",
          [tenantId, active.case_id],
        )
      ).rows[0]
    : undefined;
  const open = await c.query<{ kind: string }>(
    "SELECT kind FROM work_items WHERE tenant_id=$1 AND case_id=$2 AND status='OPEN'",
    [tenantId, referral.id],
  );
  const appointments = await appointmentsForReferral(c, tenantId, referral.id);
  return patientAccessStatus({
    referralState: referral.current_state,
    referralResolution: referral.resolution_code,
    openWorkKinds: open.rows.map((w) => w.kind),
    activeRequest:
      active && activeCase
        ? {
            caseType: active.case_type,
            state: activeCase.current_state,
            workflowStatus: active.workflow_status,
          }
        : null,
    appointments: appointments.map((a) => ({
      status: a.status,
      confirmationStatus: a.confirmation_status,
    })),
  });
}
