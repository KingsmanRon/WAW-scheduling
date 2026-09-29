import { randomUUID } from "node:crypto";
import type {
  ActorType,
  CaseState,
  CaseType,
  Channel,
  EffortType,
  InteractionIntent,
  ObservationSource,
  ObservationType,
  Operation,
  ResolutionCode,
  StaffRole,
  Subject,
  VerificationLevel,
  WorkItemKind,
} from "@access/contracts";
import {
  isTerminal,
  planObservation,
  transition,
  type ObservationPlan,
} from "@access/domain";
import { appendEvidence } from "./evidence.js";
import { AppError, conflict, notFound, type DbClient } from "./runtime.js";

export interface ActorRef {
  type: ActorType;
  id: string;
  role: StaffRole | null;
}
export const SYSTEM_ACTOR: ActorRef = {
  type: "SYSTEM",
  id: "access-core",
  role: null,
};
export const WORKER_ACTOR: ActorRef = {
  type: "SYSTEM",
  id: "access-worker",
  role: null,
};
export type CaseOwner = StaffRole | "SYSTEM" | null;

export interface CaseRow {
  id: string;
  tenant_id: string;
  case_type: CaseType;
  current_state: CaseState;
  current_owner: CaseOwner;
  exception_reason: string | null;
  version: number;
  opened_at: Date;
  resolved_at: Date | null;
  outcome_at: Date | null;
  resolution_code: ResolutionCode | null;
  resolution_source: ObservationSource | null;
}
const caseColumns =
  "id,tenant_id,case_type,current_state,current_owner,exception_reason,version,opened_at,resolved_at,outcome_at,resolution_code,resolution_source";

export async function lockCase(
  c: DbClient,
  tenantId: string,
  caseId: string,
): Promise<CaseRow> {
  const row = await c.query<CaseRow>(
    `SELECT ${caseColumns} FROM access_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [tenantId, caseId],
  );
  if (!row.rows[0]) throw notFound();
  return row.rows[0];
}
export function assertVersion(row: CaseRow, expected: number | undefined) {
  if (expected !== undefined && row.version !== expected)
    throw conflict(
      "VERSION_CONFLICT",
      `case version is ${row.version}, expected ${expected}`,
    );
}

export interface CaseEvent {
  eventType: string;
  payload: object;
}
interface Ctx {
  tenantId: string;
  correlationId: string;
  actor: ActorRef;
}
export function caseSubject(caseRow: Pick<CaseRow, "id">): Subject {
  return { type: "case", id: caseRow.id };
}

export async function evidence(
  c: DbClient,
  ctx: Ctx,
  caseRow: Pick<CaseRow, "id" | "version">,
  subject: Subject,
  event: CaseEvent,
) {
  return appendEvidence(c, {
    tenantId: ctx.tenantId,
    caseId: caseRow.id,
    subject,
    aggregateVersion: caseRow.version,
    eventType: event.eventType,
    payload: event.payload,
    correlationId: ctx.correlationId,
    actor: { type: ctx.actor.type, id: ctx.actor.id },
  });
}

export async function createCase(
  c: DbClient,
  ctx: Ctx & {
    caseId: string;
    caseType: CaseType;
    channel: Channel;
    subject: Subject;
  },
): Promise<CaseRow> {
  const inserted = await c.query<CaseRow>(
    `INSERT INTO access_cases(id,tenant_id,case_type,source_channel,current_state,current_owner,opened_at)
     VALUES($1,$2,$3,$4,'RECEIVED','SYSTEM',now()) RETURNING ${caseColumns}`,
    [ctx.caseId, ctx.tenantId, ctx.caseType, ctx.channel],
  );
  const row = inserted.rows[0]!;
  await c.query(
    `INSERT INTO access_case_transitions(tenant_id,case_id,from_state,to_state,version,actor_type,actor_id,reason,occurred_at)
     VALUES($1,$2,NULL,'RECEIVED',0,$3,$4,'case_opened',$5)`,
    [ctx.tenantId, row.id, ctx.actor.type, ctx.actor.id, row.opened_at],
  );
  await evidence(c, ctx, row, ctx.subject, {
    eventType: "case_created",
    payload: {
      case_type: ctx.caseType,
      channel: ctx.channel,
      subject: ctx.subject,
    },
  });
  return row;
}

export interface Resolution {
  code: ResolutionCode;
  outcomeAt: Date;
  source: ObservationSource;
  actorId: string;
  reference?: string | null;
}
/**
 * The only way a case changes state: locked row, domain + database guard,
 * version increment, state history and evidence in the caller's transaction.
 */
export async function transitionCase(
  c: DbClient,
  ctx: Ctx,
  caseRow: CaseRow,
  input: {
    to: CaseState;
    reason: string;
    owner?: CaseOwner;
    exceptionReason?: string | null;
    resolution?: Resolution;
    clearResolution?: boolean;
    details?: object;
  },
): Promise<CaseRow> {
  transition(caseRow.current_state, input.to);
  const terminal = isTerminal(input.to);
  if (terminal && !input.resolution)
    throw new AppError(
      422,
      "RESOLUTION_REQUIRED",
      "a terminal case state requires a resolution code",
    );
  const resolution = terminal ? input.resolution! : null;
  const updated = await c.query<CaseRow>(
    `UPDATE access_cases SET current_state=$3,version=version+1,current_owner=$4,exception_reason=$5,
            resolution_code=$6,resolved_at=CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,outcome_at=$7,
            resolution_source=$8,resolution_actor_id=$9,resolution_reference=$10,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING ${caseColumns}`,
    [
      ctx.tenantId,
      caseRow.id,
      input.to,
      terminal ? null : (input.owner ?? caseRow.current_owner),
      input.to === "EXCEPTION" ? (input.exceptionReason ?? "exception") : null,
      resolution?.code ?? null,
      resolution?.outcomeAt ?? null,
      resolution?.source ?? null,
      resolution?.actorId ?? null,
      resolution?.reference ?? null,
    ],
  );
  const row = updated.rows[0]!;
  await c.query(
    `INSERT INTO access_case_transitions(tenant_id,case_id,from_state,to_state,version,actor_type,actor_id,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ctx.tenantId,
      row.id,
      caseRow.current_state,
      row.current_state,
      row.version,
      ctx.actor.type,
      ctx.actor.id,
      input.reason,
    ],
  );
  await evidence(c, ctx, row, caseSubject(row), {
    eventType: terminal
      ? row.current_state === "BOOKED"
        ? "case_booked"
        : row.current_state === "REJECTED"
          ? "case_rejected"
          : "case_closed"
      : "case_state_changed",
    payload: {
      from: caseRow.current_state,
      to: row.current_state,
      reason: input.reason,
      ...(resolution
        ? {
            resolution_code: resolution.code,
            outcome_at: resolution.outcomeAt.toISOString(),
            resolution_source: resolution.source,
            resolution_reference: resolution.reference ?? null,
          }
        : {}),
      ...(input.details ?? {}),
    },
  });
  if (terminal)
    await resolveWorkItems(c, ctx, row, {
      resolution: "case_resolved",
      note: null,
      staffSeconds: undefined,
      automatic: true,
    });
  return row;
}

export interface WorkItemInput {
  kind: WorkItemKind;
  reason: string;
  ownerRole: StaffRole;
  evidence?: object;
  referralId?: string | null;
  dueAt?: Date | null;
}
/** Idempotent: at most one OPEN work item per case and kind. */
export async function openWorkItem(
  c: DbClient,
  ctx: Ctx,
  caseRow: Pick<CaseRow, "id" | "version">,
  input: WorkItemInput,
): Promise<{ id: string; created: boolean }> {
  const inserted = await c.query<{ id: string }>(
    `INSERT INTO work_items(tenant_id,case_id,referral_id,kind,status,reason,evidence,owner_role,due_at)
     VALUES($1,$2,$3,$4,'OPEN',$5,$6,$7,$8)
     ON CONFLICT (tenant_id,case_id,kind) WHERE status='OPEN' DO NOTHING RETURNING id`,
    [
      ctx.tenantId,
      caseRow.id,
      input.referralId ?? null,
      input.kind,
      input.reason,
      input.evidence ?? {},
      input.ownerRole,
      input.dueAt ?? null,
    ],
  );
  if (!inserted.rows[0]) {
    const existing = await c.query<{ id: string }>(
      "SELECT id FROM work_items WHERE tenant_id=$1 AND case_id=$2 AND kind=$3 AND status='OPEN'",
      [ctx.tenantId, caseRow.id, input.kind],
    );
    return { id: existing.rows[0]!.id, created: false };
  }
  const id = inserted.rows[0].id;
  await recordEffort(c, ctx, caseRow.id, {
    type: "WORK_ITEM_OPENED",
    source: "SYSTEM",
    workItemId: id,
  });
  await evidence(c, ctx, caseRow, caseSubject(caseRow), {
    eventType: "work_item_opened",
    payload: { work_item_id: id, kind: input.kind, reason: input.reason },
  });
  return { id, created: true };
}
/** Refresh the reason of the open item (e.g. a shorter missing list). */
export async function updateOpenWorkItemReason(
  c: DbClient,
  tenantId: string,
  caseId: string,
  kind: WorkItemKind,
  reason: string,
  details: object,
) {
  await c.query(
    "UPDATE work_items SET reason=$4,evidence=$5 WHERE tenant_id=$1 AND case_id=$2 AND kind=$3 AND status='OPEN'",
    [tenantId, caseId, kind, reason, details],
  );
}
export async function resolveWorkItems(
  c: DbClient,
  ctx: Ctx,
  caseRow: Pick<CaseRow, "id" | "version">,
  input: {
    kinds?: readonly WorkItemKind[];
    id?: string;
    resolution: string;
    note: string | null;
    staffSeconds: number | undefined;
    /** Side effect of another action: never counted as a human touch. */
    automatic?: boolean;
  },
): Promise<string[]> {
  const resolved = await c.query<{ id: string; kind: string }>(
    `UPDATE work_items SET status='RESOLVED',resolved_at=now(),resolved_by=$3,resolution=$4
      WHERE tenant_id=$1 AND case_id=$2 AND status='OPEN'
        AND ($5::text[] IS NULL OR kind = ANY($5)) AND ($6::uuid IS NULL OR id=$6)
      RETURNING id,kind`,
    [
      ctx.tenantId,
      caseRow.id,
      `${ctx.actor.type.toLowerCase()}:${ctx.actor.id}`,
      { resolution: input.resolution, note: input.note },
      input.kinds ?? null,
      input.id ?? null,
    ],
  );
  for (const [index, item] of resolved.rows.entries()) {
    const staff = ctx.actor.type === "STAFF" && !input.automatic;
    await recordEffort(c, ctx, caseRow.id, {
      type: "WORK_ITEM_RESOLVED",
      source: staff ? "STAFF" : "SYSTEM",
      workItemId: item.id,
      // Attribute self-reported time once, to the first item resolved.
      seconds: staff && index === 0 ? input.staffSeconds : undefined,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "work_item_resolved",
      payload: {
        work_item_id: item.id,
        kind: item.kind,
        resolution: input.resolution,
      },
    });
  }
  return resolved.rows.map((r) => r.id);
}

export async function recordEffort(
  c: DbClient,
  ctx: Ctx,
  caseId: string,
  input: {
    type: EffortType;
    source: "STAFF" | "SYSTEM" | "INTEGRATION";
    seconds?: number | undefined;
    workItemId?: string;
    commandId?: string;
  },
) {
  await c.query(
    `INSERT INTO case_effort_events(tenant_id,case_id,type,seconds,source,actor_id,work_item_id,command_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ctx.tenantId,
      caseId,
      input.type,
      input.seconds ?? null,
      input.source,
      input.source === "STAFF" ? ctx.actor.id : null,
      input.workItemId ?? null,
      input.commandId ?? null,
    ],
  );
}

export interface InteractionInput {
  channel: Channel;
  direction: "INBOUND" | "OUTBOUND";
  actorType: ActorType;
  actorId: string;
  intent: InteractionIntent;
  contentReference: string | null;
  identityVerificationLevel:
    "NONE" | "CLAIMED" | "STAFF_VERIFIED" | "SYSTEM_VERIFIED";
  idempotencyKey: string;
  commandId: string | null;
  id?: string;
}
/** Append an interaction; a replay of the same idempotency key is refused. */
export async function recordInteraction(
  c: DbClient,
  ctx: Ctx,
  caseRow: Pick<CaseRow, "id" | "version">,
  input: InteractionInput,
): Promise<string> {
  const inserted = await c.query<{ id: string }>(
    `INSERT INTO access_interactions(id,tenant_id,case_id,channel,direction,actor_type,actor_id,intent,received_at,content_reference,identity_verification_level,idempotency_key,command_id,correlation_id)
     VALUES($13,$1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12)
     ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id`,
    [
      ctx.tenantId,
      caseRow.id,
      input.channel,
      input.direction,
      input.actorType,
      input.actorId,
      input.intent,
      input.contentReference,
      input.identityVerificationLevel,
      input.idempotencyKey,
      input.commandId,
      ctx.correlationId,
      input.id ?? randomUUID(),
    ],
  );
  if (!inserted.rows[0])
    throw conflict(
      "INTERACTION_DUPLICATE",
      "idempotency_key already recorded for a different command",
    );
  await evidence(c, ctx, caseRow, caseSubject(caseRow), {
    eventType: "interaction_received",
    payload: {
      interaction_id: inserted.rows[0].id,
      channel: input.channel,
      direction: input.direction,
      intent: input.intent,
      actor_type: input.actorType,
      content_reference: input.contentReference,
    },
  });
  return inserted.rows[0].id;
}

export interface ObservationInput {
  type: ObservationType;
  occurredAt: Date;
  sourceType: ObservationSource;
  sourceReference: string;
  verificationLevel: VerificationLevel;
  actorId: string | null;
  payload?: object;
  resolutionCode?: ResolutionCode;
  authority?: "EXTERNAL" | "STAFF";
}
export interface ObservationResult {
  observationId: string;
  deduplicated: boolean;
  plan: ObservationPlan;
  caseRow: CaseRow;
}
/**
 * Uniform entry point for every outcome source (connector readback, staff,
 * import, reconciliation). Duplicate facts are idempotent; the decision is
 * planned against the locked case so ordering cannot race.
 */
export async function recordObservation(
  c: DbClient,
  ctx: Ctx,
  caseRowIn: CaseRow,
  input: ObservationInput,
): Promise<ObservationResult> {
  if (
    input.sourceType === "STAFF" &&
    input.verificationLevel !== "HUMAN_ATTESTED"
  )
    throw new AppError(
      500,
      "OBSERVATION_PROVENANCE",
      "staff observations are human-attested",
    );
  const existing = await c.query<{ id: string; disposition: string }>(
    `SELECT id,disposition FROM access_case_observations
      WHERE tenant_id=$1 AND case_id=$2 AND observation_type=$3 AND source_type=$4 AND source_reference=$5`,
    [
      ctx.tenantId,
      caseRowIn.id,
      input.type,
      input.sourceType,
      input.sourceReference,
    ],
  );
  if (existing.rows[0])
    return {
      observationId: existing.rows[0].id,
      deduplicated: true,
      plan: { disposition: "RECORDED", reason: "duplicate" },
      caseRow: caseRowIn,
    };
  const plan = planObservation({
    state: caseRowIn.current_state,
    type: input.type,
    occurredAt: input.occurredAt,
    ...(input.resolutionCode ? { resolutionCode: input.resolutionCode } : {}),
    caseOutcome: { code: caseRowIn.resolution_code, at: caseRowIn.outcome_at },
    authority: input.authority ?? "EXTERNAL",
  });
  const inserted = await c.query<{ id: string }>(
    `INSERT INTO access_case_observations(tenant_id,case_id,observation_type,occurred_at,source_type,source_reference,verification_level,actor_id,payload,correlation_id,disposition,disposition_reason,applied_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $11='APPLIED' THEN now() END) RETURNING id`,
    [
      ctx.tenantId,
      caseRowIn.id,
      input.type,
      input.occurredAt,
      input.sourceType,
      input.sourceReference,
      input.verificationLevel,
      input.actorId,
      {
        ...(input.payload ?? {}),
        ...(input.resolutionCode
          ? { resolution_code: input.resolutionCode }
          : {}),
      },
      ctx.correlationId,
      plan.disposition,
      plan.disposition === "APPLIED" ? null : plan.reason,
    ],
  );
  const observationId = inserted.rows[0]!.id;
  await evidence(c, ctx, caseRowIn, caseSubject(caseRowIn), {
    eventType: "outcome_observed",
    payload: {
      observation_id: observationId,
      observation_type: input.type,
      occurred_at: input.occurredAt.toISOString(),
      source_type: input.sourceType,
      source_reference: input.sourceReference,
      verification_level: input.verificationLevel,
      disposition: plan.disposition,
      reason: plan.disposition === "APPLIED" ? null : plan.reason,
    },
  });
  let caseRow = caseRowIn;
  if (plan.disposition === "APPLIED") {
    caseRow = await applyPlan(c, ctx, caseRow, plan, input, observationId);
  } else if (plan.disposition === "REVIEW")
    await openWorkItem(c, ctx, caseRow, {
      kind: "OUTCOME_REVIEW",
      reason: `${input.type.toLowerCase()}:${plan.reason}`,
      ownerRole: "PRACTICE_MANAGER",
      evidence: {
        observation_id: observationId,
        source_type: input.sourceType,
      },
    });
  return { observationId, deduplicated: false, plan, caseRow };
}

async function applyPlan(
  c: DbClient,
  ctx: Ctx,
  caseRow: CaseRow,
  plan: Extract<ObservationPlan, { disposition: "APPLIED" }>,
  input: Pick<
    ObservationInput,
    "type" | "occurredAt" | "sourceType" | "actorId" | "sourceReference"
  >,
  observationId: string,
): Promise<CaseRow> {
  let row = await transitionCase(c, ctx, caseRow, {
    to: plan.to,
    reason: `observation:${input.type.toLowerCase()}`,
    owner:
      plan.to === "WAITING" || plan.to === "READY_FOR_BOOKING"
        ? "REFERRAL_COORDINATOR"
        : null,
    ...(plan.resolution
      ? {
          resolution: {
            code: plan.resolution,
            outcomeAt: input.occurredAt,
            source: input.sourceType,
            actorId:
              input.actorId ??
              `${input.sourceType.toLowerCase()}:${input.sourceReference}`,
            reference: observationId,
          },
        }
      : {}),
    details: { observation_id: observationId },
  });
  if (row.current_state === "READY_FOR_BOOKING")
    row = await applyPendingObservations(c, ctx, row);
  return row;
}

/**
 * Settle outcomes that arrived before the destination commit, earliest
 * first. The first applicable terminal outcome wins; later conflicting ones
 * go to human review, agreeing ones are only recorded.
 */
export async function applyPendingObservations(
  c: DbClient,
  ctx: Ctx,
  caseRowIn: CaseRow,
): Promise<CaseRow> {
  let caseRow = caseRowIn;
  const pending = await c.query<{
    id: string;
    observation_type: ObservationType;
    occurred_at: Date;
    source_type: ObservationSource;
    source_reference: string;
    actor_id: string | null;
    payload: { resolution_code?: ResolutionCode };
  }>(
    `SELECT id,observation_type,occurred_at,source_type,source_reference,actor_id,payload
       FROM access_case_observations WHERE tenant_id=$1 AND case_id=$2 AND disposition='PENDING'
      ORDER BY occurred_at,recorded_at,id FOR UPDATE`,
    [ctx.tenantId, caseRow.id],
  );
  for (const p of pending.rows) {
    const plan = planObservation({
      state: caseRow.current_state,
      type: p.observation_type,
      occurredAt: new Date(p.occurred_at),
      ...(p.payload.resolution_code
        ? { resolutionCode: p.payload.resolution_code }
        : {}),
      caseOutcome: { code: caseRow.resolution_code, at: caseRow.outcome_at },
    });
    if (plan.disposition === "PENDING") continue;
    await c.query(
      `UPDATE access_case_observations SET disposition=$3,disposition_reason=$4,applied_at=CASE WHEN $3='APPLIED' THEN now() END
        WHERE tenant_id=$1 AND id=$2`,
      [
        ctx.tenantId,
        p.id,
        plan.disposition,
        plan.disposition === "APPLIED" ? null : plan.reason,
      ],
    );
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "pending_observation_settled",
      payload: {
        observation_id: p.id,
        disposition: plan.disposition,
        reason: plan.disposition === "APPLIED" ? null : plan.reason,
      },
    });
    if (plan.disposition === "APPLIED")
      caseRow = await transitionCase(c, ctx, caseRow, {
        to: plan.to,
        reason: `observation:${p.observation_type.toLowerCase()}`,
        owner: plan.to === "WAITING" ? "REFERRAL_COORDINATOR" : null,
        ...(plan.resolution
          ? {
              resolution: {
                code: plan.resolution,
                outcomeAt: new Date(p.occurred_at),
                source: p.source_type,
                actorId:
                  p.actor_id ??
                  `${p.source_type.toLowerCase()}:${p.source_reference}`,
                reference: p.id,
              },
            }
          : {}),
        details: { observation_id: p.id, applied_late: true },
      });
    else if (plan.disposition === "REVIEW")
      await openWorkItem(c, ctx, caseRow, {
        kind: "OUTCOME_REVIEW",
        reason: `${p.observation_type.toLowerCase()}:${plan.reason}`,
        ownerRole: "PRACTICE_MANAGER",
        evidence: { observation_id: p.id },
      });
  }
  return caseRow;
}

/** Record a lifecycle milestone once per case and source (idempotent). */
export async function recordMilestone(
  c: DbClient,
  ctx: Ctx,
  caseRow: CaseRow,
  type:
    | "REFERRAL_RECEIVED"
    | "REFERRAL_VERIFIED"
    | "REFERRAL_READY"
    | "DESTINATION_COMMITTED",
  input: {
    occurredAt?: Date;
    sourceType: ObservationSource;
    verificationLevel: VerificationLevel;
    sourceReference?: string;
    actorId?: string | null;
    payload?: object;
  },
) {
  return recordObservation(c, ctx, caseRow, {
    type,
    occurredAt: input.occurredAt ?? new Date(),
    sourceType: input.sourceType,
    sourceReference: input.sourceReference ?? "milestone",
    verificationLevel: input.verificationLevel,
    actorId: input.actorId ?? null,
    payload: input.payload ?? {},
  });
}

export interface ExecutionSummary {
  id: string;
  status: string;
  escalated_at: Date | null;
  superseded_at: Date | null;
}
export async function caseExecutions(
  c: DbClient,
  tenantId: string,
  caseId: string,
): Promise<ExecutionSummary[]> {
  const rows = await c.query<ExecutionSummary>(
    "SELECT id,status,escalated_at,superseded_at FROM executions WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at",
    [tenantId, caseId],
  );
  return rows.rows;
}
/** The worker may still act on the foreign system for this execution. */
export function executionInFlight(e: ExecutionSummary): boolean {
  return (
    ["PENDING", "LEASED", "RETRYABLE", "RECONCILING"].includes(e.status) ||
    (e.status === "AMBIGUOUS" && !e.escalated_at)
  );
}
/** Foreign effect unknown and not yet settled by a staff decision. */
export function executionUnresolved(e: ExecutionSummary): boolean {
  return executionInFlight(e) || (e.status === "AMBIGUOUS" && !e.superseded_at);
}

/** Enqueue a consequential destination action in the caller's transaction. */
export async function enqueueDestination(
  c: DbClient,
  ctx: Ctx,
  caseRow: CaseRow,
  input: {
    operation: Operation;
    subject: Subject;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const executionId = randomUUID();
  await c.query(
    `INSERT INTO executions(id,tenant_id,case_id,referral_id,subject_type,subject_id,operation,status,attempts,correlation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',0,$8)`,
    [
      executionId,
      ctx.tenantId,
      caseRow.id,
      input.subject.type === "referral" ? input.subject.id : null,
      input.subject.type,
      input.subject.id,
      input.operation,
      ctx.correlationId,
    ],
  );
  await c.query(
    `INSERT INTO outbox(tenant_id,case_id,referral_id,subject_type,subject_id,operation,aggregate_version,execution_id,payload,correlation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      ctx.tenantId,
      caseRow.id,
      input.subject.type === "referral" ? input.subject.id : null,
      input.subject.type,
      input.subject.id,
      input.operation,
      caseRow.version,
      executionId,
      {
        schema_version: "connector-request.v1",
        execution_id: executionId,
        tenant_id: ctx.tenantId,
        case_id: caseRow.id,
        subject: input.subject,
        operation: input.operation,
        correlation_id: ctx.correlationId,
        payload: input.payload,
      },
      ctx.correlationId,
    ],
  );
  await evidence(c, ctx, caseRow, input.subject, {
    eventType: "destination_dispatch_requested",
    payload: { execution_id: executionId, operation: input.operation },
  });
  return executionId;
}
