import {
  isAppointmentCaseType,
  type AppointmentWorkflowStatus,
  type CaseState,
  type QueueFilter,
  type StaffRole,
} from "@access/contracts";
import {
  appointmentsForReferral,
  bookingReadiness,
  caseMetrics,
  findAppointment,
  findRequest,
  notFound,
  referralAccessStatus,
  requestsForReferral,
  verifyEvidenceChain,
  type AppointmentRow,
  type CaseRow,
  type DbClient,
} from "@access/db";
import {
  appointmentNextAction,
  availabilityIsFresh,
  nextRequiredAction,
  workflowFinished,
} from "@access/domain";
import { can } from "@access/policy";

/** Patient-safe display reference derived from the opaque case id. */
export function displayRef(caseId: string): string {
  return `REF-${caseId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

const FILTERS: Record<QueueFilter, string> = {
  all: "TRUE",
  needs_attention: `(c.current_state IN ('IDENTITY_PENDING','INFORMATION_MISSING','EXCEPTION')
     OR (c.current_state='READY' AND coalesce(r.destination_mode,'MANUAL')='MANUAL')
     OR (c.current_state IN ('READY_FOR_BOOKING','WAITING') AND r.follow_up_due_at <= now())
     OR (c.case_type<>'REFERRAL' AND c.current_state='READY_FOR_BOOKING')
     OR EXISTS (SELECT 1 FROM work_items w WHERE w.tenant_id=c.tenant_id AND w.case_id=c.id AND w.status='OPEN'))`,
  identity_pending: "c.current_state='IDENTITY_PENDING'",
  information_missing: "c.current_state='INFORMATION_MISSING'",
  ready: "c.current_state IN ('READY','DESTINATION_PENDING')",
  // Referral lenses; appointment operations cases have their own below.
  ready_for_booking:
    "c.case_type='REFERRAL' AND c.current_state='READY_FOR_BOOKING'",
  waiting: "c.case_type='REFERRAL' AND c.current_state='WAITING'",
  booked: "c.case_type='REFERRAL' AND c.current_state='BOOKED'",
  booking_in_progress:
    "c.case_type='APPOINTMENT_REQUEST' AND c.current_state NOT IN ('BOOKED','CLOSED','REJECTED')",
  reschedule:
    "c.case_type='RESCHEDULING_REQUEST' AND c.current_state NOT IN ('BOOKED','CLOSED','REJECTED')",
  cancellation:
    "c.case_type='CANCELLATION_REQUEST' AND c.current_state NOT IN ('BOOKED','CLOSED','REJECTED')",
  closed: "c.case_type='REFERRAL' AND c.current_state IN ('CLOSED','REJECTED')",
  exceptions: "c.current_state='EXCEPTION'",
};

interface QueueRow {
  case_id: string;
  referral_id: string | null;
  case_type: string;
  current_state: CaseState;
  current_owner: string | null;
  exception_reason: string | null;
  opened_at: Date;
  updated_at: Date;
  version: number;
  resolution_code: string | null;
  outcome_at: Date | null;
  destination_mode: "CONNECTOR" | "MANUAL" | null;
  destination_reference_source: string | null;
  follow_up_due_at: Date | null;
  missing: string[] | null;
  latest_execution_status: string | null;
  latest_execution_escalated: boolean | null;
  open_work: string[] | null;
  workflow_status: AppointmentWorkflowStatus | null;
  origin_referral_case_id: string | null;
}

export async function queue(
  c: DbClient,
  tenantId: string,
  filter: QueueFilter,
  limit: number,
  offset: number,
) {
  const rows = await c.query<QueueRow>(
    `SELECT c.id AS case_id, r.id AS referral_id, c.case_type, c.current_state, c.current_owner, c.exception_reason,
            c.opened_at, c.updated_at, c.version, c.resolution_code, c.outcome_at,
            r.destination_mode, r.destination_reference_source, r.follow_up_due_at,
            (SELECT array_agg(x) FROM jsonb_array_elements_text(coalesce(r.rule_decision->'missing_documents','[]'::jsonb)
                || coalesce(r.rule_decision->'missing_fields','[]'::jsonb)
                || coalesce(r.rule_decision->'unmet_prerequisites','[]'::jsonb)) x) AS missing,
            e.status AS latest_execution_status, e.escalated_at IS NOT NULL AS latest_execution_escalated,
            (SELECT array_agg(w.kind ORDER BY w.created_at) FROM work_items w
              WHERE w.tenant_id=c.tenant_id AND w.case_id=c.id AND w.status='OPEN') AS open_work,
            ar.workflow_status, ar.origin_referral_case_id
       FROM access_cases c
       LEFT JOIN referrals r ON r.tenant_id=c.tenant_id AND r.case_id=c.id
       LEFT JOIN appointment_requests ar ON ar.tenant_id=c.tenant_id AND ar.case_id=c.id
       -- Referrals: the latest execution. Appointment requests: the step the
       -- request waits on, else the latest step that ran (a planned step has
       -- not happened; one settled by staff no longer speaks for the case).
       LEFT JOIN LATERAL (SELECT x.status, x.escalated_at FROM executions x
                            LEFT JOIN outbox ob ON ob.tenant_id=x.tenant_id AND ob.execution_id=x.id
                           WHERE x.tenant_id=c.tenant_id AND x.case_id=c.id
                             AND (c.case_type='REFERRAL' OR (ob.status IS DISTINCT FROM 'BLOCKED' AND x.superseded_at IS NULL))
                           ORDER BY (x.id = ar.pending_execution_id) IS TRUE DESC, x.created_at DESC, ob.id DESC NULLS LAST
                           LIMIT 1) e ON TRUE
      WHERE c.tenant_id=$1 AND ${FILTERS[filter]}
      ORDER BY c.opened_at ASC, c.id
      LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  const now = Date.now();
  return rows.rows.map((row) => ({
    case_id: row.case_id,
    referral_id: row.referral_id,
    display_ref: displayRef(row.case_id),
    case_type: row.case_type,
    state: row.current_state,
    version: row.version,
    age_seconds: Math.round((now - new Date(row.opened_at).getTime()) / 1000),
    opened_at: row.opened_at,
    owner: row.current_owner,
    exception_reason: row.exception_reason,
    open_work_items: row.open_work ?? [],
    next_action: row.workflow_status
      ? appointmentNextAction({
          caseType: row.case_type,
          state: row.current_state,
          workflowStatus: row.workflow_status,
          exceptionReason: row.exception_reason,
        })
      : nextRequiredAction({
          state: row.current_state,
          destinationMode: row.destination_mode,
          missing: row.missing ?? [],
          exceptionReason: row.exception_reason,
        }),
    workflow_status: row.workflow_status,
    origin_referral_case_id: row.origin_referral_case_id,
    origin_display_ref: row.origin_referral_case_id
      ? displayRef(row.origin_referral_case_id)
      : null,
    destination_status: destinationStatus(row),
    outcome_status:
      row.current_state === "BOOKED"
        ? "BOOKED"
        : row.resolution_code
          ? `CLOSED: ${row.resolution_code}`
          : row.workflow_status
            ? "In progress"
            : row.current_state === "WAITING"
              ? "Awaiting response"
              : row.current_state === "READY_FOR_BOOKING"
                ? "Awaiting booking"
                : "Not yet bookable",
    follow_up_due_at: row.follow_up_due_at,
  }));
}
function destinationStatus(row: QueueRow): string {
  if (row.destination_reference_source === "CONNECTOR")
    return "Committed (connector)";
  if (row.destination_reference_source === "MANUAL")
    return "Committed (manual entry)";
  if (row.latest_execution_status === "AMBIGUOUS")
    return row.latest_execution_escalated
      ? "Unknown - staff check required"
      : "Reconciling";
  if (row.latest_execution_status)
    return `Connector: ${row.latest_execution_status}`;
  if (row.current_state === "READY") return "Manual entry required";
  return "Not sent";
}

/** Fields shown only to roles permitted to see patient details. */
function redactExtraction(extraction: unknown, role: StaffRole): unknown {
  if (can(role, "case.read_patient_details") || !extraction) return extraction;
  const e = extraction as {
    documents?: unknown;
    schema_version?: unknown;
    requested_service?: unknown;
  };
  return {
    schema_version: e.schema_version,
    documents: e.documents,
    requested_service: e.requested_service ?? null,
    patient: "[restricted]",
  };
}

export async function caseDetail(
  c: DbClient,
  tenantId: string,
  caseId: string,
  role: StaffRole,
) {
  const kase = await c.query(
    `SELECT id,case_type,source_channel,current_state,current_owner,exception_reason,opened_at,resolved_at,outcome_at,
            resolution_code,resolution_source,resolution_actor_id,resolution_reference,version,created_at,updated_at,legacy_referral_state
       FROM access_cases WHERE tenant_id=$1 AND id=$2`,
    [tenantId, caseId],
  );
  const caseRow = kase.rows[0];
  if (!caseRow) throw notFound();
  const referral = await c.query(
    `SELECT id,extraction,referring_provider,requested_service,referral_date,completeness_status,identity_status,
            identity_confirmed_by,supplied_documents,supplied_fields,rule_set_id,rule_set_version,rule_decision,policy_decision,
            destination_mode,destination_reference,destination_reference_source,destination_committed_at,follow_up_due_at,follow_up_count
       FROM referrals WHERE tenant_id=$1 AND case_id=$2`,
    [tenantId, caseId],
  );
  const r = referral.rows[0];
  const showPayloads = can(role, "case.read_patient_details");
  const [
    interactions,
    observations,
    events,
    work,
    executions,
    transitions,
    effort,
  ] = await Promise.all([
    c.query(
      `SELECT id,channel,direction,actor_type,actor_id,intent,received_at,content_reference,identity_verification_level,correlation_id
         FROM access_interactions WHERE tenant_id=$1 AND case_id=$2 ORDER BY received_at,id`,
      [tenantId, caseId],
    ),
    c.query(
      `SELECT id,observation_type,occurred_at,recorded_at,source_type,source_reference,verification_level,actor_id,disposition,disposition_reason,applied_at
         FROM access_case_observations WHERE tenant_id=$1 AND case_id=$2 ORDER BY occurred_at,recorded_at`,
      [tenantId, caseId],
    ),
    c.query(
      `SELECT sequence,event_type,aggregate_version,subject_type,subject_id,actor_type,actor_id,hash,previous_hash,hash_version,correlation_id,created_at${showPayloads ? ",payload" : ""}
         FROM evidence_events WHERE tenant_id=$1 AND case_id=$2 ORDER BY sequence`,
      [tenantId, caseId],
    ),
    c.query(
      `SELECT id,kind,status,reason,owner_role,due_at,created_at,resolved_at,resolved_by${showPayloads ? ",resolution" : ""}
         FROM work_items WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at`,
      [tenantId, caseId],
    ),
    c.query(
      `SELECT e.id,e.operation,e.status,e.attempts,e.reconcile_attempts,e.external_id,e.last_error,e.first_ambiguous_at,e.last_reconcile_at,
              e.next_reconcile_at,e.escalated_at,e.superseded_at,e.superseded_reason,e.created_at,e.updated_at,
              coalesce(o.status='BLOCKED',false) AS planned
         FROM executions e LEFT JOIN outbox o ON o.tenant_id=e.tenant_id AND o.execution_id=e.id
        WHERE e.tenant_id=$1 AND e.case_id=$2 ORDER BY e.created_at, o.id NULLS LAST, e.id`,
      [tenantId, caseId],
    ),
    c.query(
      `SELECT from_state,to_state,version,actor_type,actor_id,reason,occurred_at
         FROM access_case_transitions WHERE tenant_id=$1 AND case_id=$2 ORDER BY id`,
      [tenantId, caseId],
    ),
    c.query(
      `SELECT type,seconds,source,actor_id,created_at FROM case_effort_events WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at`,
      [tenantId, caseId],
    ),
  ]);
  const chain = await verifyEvidenceChain(c, tenantId, caseId);
  const booking = await bookingView(c, tenantId, caseRow, role);
  return {
    case: { ...caseRow, display_ref: displayRef(caseId) },
    referral: r
      ? {
          ...r,
          extraction: redactExtraction(r.extraction, role),
          supplied_fields: showPayloads ? r.supplied_fields : "[restricted]",
        }
      : null,
    next_action:
      booking.nextAction ??
      nextRequiredAction({
        state: caseRow.current_state,
        destinationMode: r?.destination_mode ?? null,
        missing: [
          ...(r?.rule_decision?.missing_documents ?? []),
          ...(r?.rule_decision?.missing_fields ?? []),
          ...(r?.rule_decision?.unmet_prerequisites ?? []),
        ],
        exceptionReason: caseRow.exception_reason,
      }),
    access_status: booking.accessStatus,
    booking: booking.eligibility,
    appointment_request: booking.request,
    appointment_requests: booking.requests,
    appointments: booking.appointments,
    interactions: interactions.rows,
    observations: observations.rows,
    evidence: { verification: chain, events: events.rows },
    work_items: work.rows,
    executions: executions.rows,
    transitions: transitions.rows,
    effort: effort.rows,
    metrics: await caseMetrics(c, tenantId, caseId),
  };
}

/** Appointment fields shown to every role; the patient reference is not. */
function appointmentView(a: AppointmentRow, role: StaffRole) {
  return {
    id: a.id,
    source_case_id: a.source_case_id,
    origin_referral_case_id: a.origin_referral_case_id,
    external_reference: a.external_reference,
    slot_reference: a.slot_reference,
    provider_reference: a.provider_reference,
    location_reference: a.location_reference,
    service_code: a.service_code,
    patient_reference:
      a.patient_reference && !can(role, "case.read_patient_details")
        ? "[restricted]"
        : a.patient_reference,
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    timezone: a.timezone,
    status: a.status,
    committed_at: a.committed_at,
    commit_source: a.commit_source,
    cancelled_at: a.cancelled_at,
    cancellation_source: a.cancellation_source,
    replaces_appointment_id: a.replaces_appointment_id,
    superseded_by_id: a.superseded_by_id,
    confirmation_status: a.confirmation_status,
    confirmed_at: a.confirmed_at,
    confirmation_method: a.confirmation_method,
    confirmed_by: a.confirmed_by,
    version: a.version,
  };
}

/**
 * The booking side of a case: for a referral, whether it may start booking,
 * its requests, appointments and plain-language status; for an appointment
 * operations case, its request (availability, selection, hold, pending
 * step) and the appointments it concerns.
 */
async function bookingView(
  c: DbClient,
  tenantId: string,
  caseRow: CaseRow,
  role: StaffRole,
) {
  if (caseRow.case_type === "REFERRAL") {
    const requests = await requestsForReferral(c, tenantId, caseRow.id);
    const states = new Map<string, CaseState>();
    for (const r of requests) {
      const k = await c.query<{ current_state: CaseState }>(
        "SELECT current_state FROM access_cases WHERE tenant_id=$1 AND id=$2",
        [tenantId, r.case_id],
      );
      states.set(r.case_id, k.rows[0]!.current_state);
    }
    const readiness = await bookingReadiness(c, tenantId, caseRow);
    const active = requests.find((r) => !workflowFinished(r.workflow_status));
    return {
      nextAction: active
        ? active.case_type === "APPOINTMENT_REQUEST"
          ? "Booking in progress: continue it from the appointment request"
          : "Appointment change in progress: continue it from its request"
        : null,
      accessStatus: await referralAccessStatus(c, tenantId, caseRow),
      eligibility: { eligible: readiness.eligible, reasons: readiness.reasons },
      request: null,
      requests: requests.map((r) => ({
        case_id: r.case_id,
        display_ref: displayRef(r.case_id),
        case_type: r.case_type,
        state: states.get(r.case_id) ?? null,
        workflow_status: r.workflow_status,
        original_appointment_id: r.original_appointment_id,
        appointment_id: r.appointment_id,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
      appointments: (
        await appointmentsForReferral(c, tenantId, caseRow.id)
      ).map((a) => appointmentView(a, role)),
    };
  }
  if (!isAppointmentCaseType(caseRow.case_type))
    return {
      nextAction: null,
      accessStatus: null,
      eligibility: null,
      request: null,
      requests: [],
      appointments: [],
    };
  const request = await findRequest(c, tenantId, caseRow.id);
  if (!request)
    return {
      nextAction: null,
      accessStatus: null,
      eligibility: null,
      request: null,
      requests: [],
      appointments: [],
    };
  const hold = request.current_hold_id
    ? (
        await c.query<{
          id: string;
          slot_reference: string;
          status: string;
          created_at: Date;
          expires_at: Date;
          closed_at: Date | null;
        }>(
          "SELECT id,slot_reference,status,created_at,expires_at,closed_at FROM appointment_slot_holds WHERE tenant_id=$1 AND id=$2",
          [tenantId, request.current_hold_id],
        )
      ).rows[0]
    : undefined;
  const pending = request.pending_execution_id
    ? (
        await c.query<{
          id: string;
          operation: string;
          status: string;
          escalated_at: Date | null;
          superseded_at: Date | null;
        }>(
          "SELECT id,operation,status,escalated_at,superseded_at FROM executions WHERE tenant_id=$1 AND id=$2",
          [tenantId, request.pending_execution_id],
        )
      ).rows[0]
    : undefined;
  const appointments: AppointmentRow[] = [];
  for (const id of [request.original_appointment_id, request.appointment_id])
    if (id) {
      const a = await findAppointment(c, tenantId, id);
      if (a) appointments.push(a);
    }
  const current = appointments.find((a) => a.id === request.appointment_id);
  const origin = request.origin_referral_case_id
    ? (
        await c.query<CaseRow>(
          "SELECT id,case_type,current_state,resolution_code FROM access_cases WHERE tenant_id=$1 AND id=$2",
          [tenantId, request.origin_referral_case_id],
        )
      ).rows[0]
    : undefined;
  return {
    nextAction: appointmentNextAction({
      caseType: caseRow.case_type,
      state: caseRow.current_state,
      workflowStatus: request.workflow_status,
      exceptionReason: caseRow.exception_reason,
      confirmationStatus: current?.confirmation_status ?? null,
    }),
    accessStatus: origin
      ? await referralAccessStatus(c, tenantId, origin)
      : null,
    eligibility: null,
    request: {
      case_type: request.case_type,
      workflow_status: request.workflow_status,
      version: request.version,
      origin_referral_case_id: request.origin_referral_case_id,
      origin_display_ref: request.origin_referral_case_id
        ? displayRef(request.origin_referral_case_id)
        : null,
      original_appointment_id: request.original_appointment_id,
      appointment_id: request.appointment_id,
      booking_context: request.booking_context,
      search: request.search,
      timezone: request.timezone,
      availability: request.availability
        ? {
            observed_at: request.availability.observed_at,
            fresh: availabilityIsFresh(request.availability_observed_at),
            slots: request.availability.slots,
          }
        : null,
      selected_slot: request.selected_slot,
      selected_at: request.selected_at,
      hold: hold ?? null,
      pending_execution: pending
        ? {
            id: pending.id,
            operation: pending.operation,
            status: pending.status,
            escalated: Boolean(pending.escalated_at),
            superseded: Boolean(pending.superseded_at),
          }
        : null,
      cancellation_reason: request.cancellation_reason,
      last_failure_code: request.last_failure_code,
      last_failure_at: request.last_failure_at,
      recheck_requested_at: request.recheck_requested_at,
      created_at: request.created_at,
      updated_at: request.updated_at,
    },
    requests: [],
    appointments: appointments.map((a) => appointmentView(a, role)),
  };
}

/** One appointment, the cases around it and any change in progress. */
export async function appointmentDetail(
  c: DbClient,
  tenantId: string,
  appointmentId: string,
  role: StaffRole,
) {
  const appointment = await findAppointment(c, tenantId, appointmentId);
  if (!appointment) throw notFound("appointment");
  const changes = await c.query<{
    case_id: string;
    case_type: string;
    workflow_status: AppointmentWorkflowStatus;
    version: number;
    created_at: Date;
  }>(
    `SELECT case_id,case_type,workflow_status,version,created_at FROM appointment_requests
      WHERE tenant_id=$1 AND original_appointment_id=$2 ORDER BY created_at`,
    [tenantId, appointmentId],
  );
  return {
    appointment: appointmentView(appointment, role),
    source_display_ref: displayRef(appointment.source_case_id),
    origin_display_ref: appointment.origin_referral_case_id
      ? displayRef(appointment.origin_referral_case_id)
      : null,
    changes: changes.rows.map((r) => ({
      ...r,
      display_ref: displayRef(r.case_id),
      active: !workflowFinished(r.workflow_status),
    })),
  };
}
