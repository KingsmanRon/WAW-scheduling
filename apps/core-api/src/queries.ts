import {
  ENABLED_CASE_TYPES,
  type CaseState,
  type QueueFilter,
  type StaffRole,
} from "@access/contracts";
import {
  caseMetrics,
  notFound,
  verifyEvidenceChain,
  type DbClient,
} from "@access/db";
import { nextRequiredAction } from "@access/domain";
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
     OR EXISTS (SELECT 1 FROM work_items w WHERE w.tenant_id=c.tenant_id AND w.case_id=c.id AND w.status='OPEN'))`,
  identity_pending: "c.current_state='IDENTITY_PENDING'",
  information_missing: "c.current_state='INFORMATION_MISSING'",
  ready: "c.current_state IN ('READY','DESTINATION_PENDING')",
  ready_for_booking: "c.current_state='READY_FOR_BOOKING'",
  waiting: "c.current_state='WAITING'",
  booked: "c.current_state='BOOKED'",
  closed: "c.current_state IN ('CLOSED','REJECTED')",
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
              WHERE w.tenant_id=c.tenant_id AND w.case_id=c.id AND w.status='OPEN') AS open_work
       FROM access_cases c
       LEFT JOIN referrals r ON r.tenant_id=c.tenant_id AND r.case_id=c.id
       LEFT JOIN LATERAL (SELECT status, escalated_at FROM executions x WHERE x.tenant_id=c.tenant_id AND x.case_id=c.id
                           ORDER BY x.created_at DESC LIMIT 1) e ON TRUE
      WHERE c.tenant_id=$1 AND c.case_type = ANY($4) AND ${FILTERS[filter]}
      ORDER BY c.opened_at ASC, c.id
      LIMIT $2 OFFSET $3`,
    // Cases of retired types (appointment operations v1) are history only.
    [tenantId, limit, offset, ENABLED_CASE_TYPES],
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
    next_action: nextRequiredAction({
      state: row.current_state,
      destinationMode: row.destination_mode,
      missing: row.missing ?? [],
      exceptionReason: row.exception_reason,
    }),
    destination_status: destinationStatus(row),
    outcome_status:
      row.current_state === "BOOKED"
        ? "BOOKED"
        : row.resolution_code
          ? `CLOSED: ${row.resolution_code}`
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

/** A pg client runs one query at a time, so issue them in order. */
type Resolved<T extends readonly unknown[]> = {
  -readonly [K in keyof T]: T[K] extends () => Promise<infer R> ? R : never;
};
async function inSequence<T extends readonly (() => Promise<unknown>)[] | []>(
  steps: T,
): Promise<Resolved<T>> {
  const results: unknown[] = [];
  for (const step of steps) results.push(await step());
  return results as unknown as Resolved<T>;
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
  ] = await inSequence([
    () =>
      c.query(
        `SELECT id,channel,direction,actor_type,actor_id,intent,received_at,content_reference,identity_verification_level,correlation_id
         FROM access_interactions WHERE tenant_id=$1 AND case_id=$2 ORDER BY received_at,id`,
        [tenantId, caseId],
      ),
    () =>
      c.query(
        `SELECT id,observation_type,occurred_at,recorded_at,source_type,source_reference,verification_level,actor_id,disposition,disposition_reason,applied_at
         FROM access_case_observations WHERE tenant_id=$1 AND case_id=$2 ORDER BY occurred_at,recorded_at`,
        [tenantId, caseId],
      ),
    () =>
      c.query(
        `SELECT sequence,event_type,aggregate_version,subject_type,subject_id,actor_type,actor_id,hash,previous_hash,hash_version,correlation_id,created_at${showPayloads ? ",payload" : ""}
         FROM evidence_events WHERE tenant_id=$1 AND case_id=$2 ORDER BY sequence`,
        [tenantId, caseId],
      ),
    () =>
      c.query(
        `SELECT id,kind,status,reason,owner_role,due_at,created_at,resolved_at,resolved_by${showPayloads ? ",resolution" : ""}
         FROM work_items WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at`,
        [tenantId, caseId],
      ),
    () =>
      c.query(
        `SELECT id,operation,status,attempts,reconcile_attempts,external_id,last_error,first_ambiguous_at,last_reconcile_at,
              next_reconcile_at,escalated_at,superseded_at,superseded_reason,created_at,updated_at
         FROM executions WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at`,
        [tenantId, caseId],
      ),
    () =>
      c.query(
        `SELECT from_state,to_state,version,actor_type,actor_id,reason,occurred_at
         FROM access_case_transitions WHERE tenant_id=$1 AND case_id=$2 ORDER BY id`,
        [tenantId, caseId],
      ),
    () =>
      c.query(
        `SELECT type,seconds,source,actor_id,created_at FROM case_effort_events WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at`,
        [tenantId, caseId],
      ),
  ]);
  const chain = await verifyEvidenceChain(c, tenantId, caseId);
  return {
    case: { ...caseRow, display_ref: displayRef(caseId) },
    referral: r
      ? {
          ...r,
          extraction: redactExtraction(r.extraction, role),
          supplied_fields: showPayloads ? r.supplied_fields : "[restricted]",
        }
      : null,
    next_action: nextRequiredAction({
      state: caseRow.current_state,
      destinationMode: r?.destination_mode ?? null,
      missing: [
        ...(r?.rule_decision?.missing_documents ?? []),
        ...(r?.rule_decision?.missing_fields ?? []),
        ...(r?.rule_decision?.unmet_prerequisites ?? []),
      ],
      exceptionReason: caseRow.exception_reason,
    }),
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
