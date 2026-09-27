import type { Pool } from "pg";
import {
  appointmentOutcomeSchema,
  connectorRequestSchema,
  connectorResultSchema,
  isAppointmentCaseType,
  type ConnectorRequest,
  type ConnectorResult,
  type ObservationType,
  type Operation,
  type Subject,
  type WorkItemKind,
} from "@access/contracts";
import {
  WORKER_ACTOR,
  applyPendingObservations,
  caseSubject,
  evidence,
  lockCase,
  loadRuleSet,
  openWorkItem,
  recordMilestone,
  recordObservation,
  tenantTx,
  transitionCase,
  type ActorRef,
  type CaseRow,
  type DbClient,
} from "@access/db";
import { errorFields, log } from "@access/observability";
import { authorizeOperation } from "@access/policy";
import { ownerFor, type RuleDefinition } from "@access/rules";
import { AppointmentSettlement, validAppointmentData } from "./appointments.js";
import {
  AmbiguousConnectorError,
  InvalidConnectorResponseError,
  PermanentConnectorError,
  SafeRetryableConnectorError,
  UnsupportedOperationError,
  type CapabilityGate,
  type Connector,
} from "./connector.js";

export interface DispatcherOptions {
  maxDispatch: number;
  retrySeconds: number;
  maxReconcile: number;
  reconcileBaseSeconds: number;
  leaseSeconds?: number;
  /** Restrict this dispatcher to some tenants (sharding, tests). */
  tenantIds?: readonly string[] | undefined;
}
interface OutboxItem {
  id: string;
  tenant_id: string;
  case_id: string;
  case_type: string;
  subject_type: "referral" | "case";
  subject_id: string;
  operation: string;
  execution_id: string;
  payload: Record<string, unknown>;
  correlation_id: string;
  attempts: number;
  prior_status: "PENDING" | "LEASED";
  created_at: Date;
}
type Outcome =
  | { kind: "succeeded"; externalId: string; data?: Record<string, unknown> }
  | { kind: "retryable"; code: string }
  | { kind: "failed"; code: string; workKind: WorkItemKind }
  | { kind: "ambiguous"; code: string }
  /** Appointment steps no longer expected: never sent. */
  | { kind: "skipped"; code: string };
type ReconcileOutcome =
  | { kind: "succeeded"; externalId: string; data?: Record<string, unknown> }
  | { kind: "inconclusive"; code: string }
  | { kind: "final"; code: string }
  /** Appointment operations: read-back proved the effect absent. */
  | { kind: "not_committed" };
interface DueExecution {
  id: string;
  case_id: string;
  subject_type: "referral" | "case";
  subject_id: string;
  operation: string;
  reconcile_attempts: number;
  correlation_id: string;
  payload: Record<string, unknown>;
  case_type: string;
}

const connectorActor = (connector: Connector): ActorRef => ({
  type: "CONNECTOR",
  id: `connector:${connector.name}`,
  role: null,
});

/**
 * Leased, case-ordered outbox dispatcher, ambiguous-write reconciler,
 * closed-loop outcome readback and administrative timers.
 */
export class Dispatcher {
  private leaseSeconds: number;
  private appointments: AppointmentSettlement;
  constructor(
    private pool: Pool,
    private connector: Connector,
    private gate: CapabilityGate,
    private options: DispatcherOptions,
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.appointments = new AppointmentSettlement(connector.name, () =>
      gate.isEnabled("appointment.hold"),
    );
  }

  private async tenants(): Promise<string[]> {
    const rows = await this.pool.query<{ id: string }>(
      "SELECT id FROM organisations ORDER BY id",
    );
    const all = rows.rows.map((r) => r.id);
    return this.options.tenantIds
      ? all.filter((t) => this.options.tenantIds!.includes(t))
      : all;
  }
  private tx<T>(tenantId: string, fn: (c: DbClient) => Promise<T>) {
    return tenantTx(tenantId, fn, this.pool);
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  async tick(): Promise<boolean> {
    for (const tenant of await this.tenants())
      if (await this.claimAndDispatch(tenant)) return true;
    return false;
  }

  private async claim(tenantId: string): Promise<OutboxItem | undefined> {
    return this.tx(tenantId, async (c) => {
      const claimed = await c.query<OutboxItem>(
        `SELECT o.id,o.tenant_id,o.case_id,c.case_type,o.subject_type,o.subject_id,o.operation,o.execution_id,o.payload,
                o.correlation_id,o.attempts,o.status AS prior_status,o.created_at
           FROM outbox o JOIN access_cases c ON c.tenant_id=o.tenant_id AND c.id=o.case_id
          WHERE o.tenant_id=$1 AND (o.status='PENDING' OR (o.status='LEASED' AND o.lease_until<now())) AND o.available_at<=now()
            AND NOT EXISTS (SELECT 1 FROM outbox earlier WHERE earlier.tenant_id=o.tenant_id AND earlier.case_id=o.case_id
                            AND earlier.status IN ('PENDING','LEASED') AND earlier.aggregate_version<o.aggregate_version)
          ORDER BY o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`,
        [tenantId],
      );
      const item = claimed.rows[0];
      if (!item) return undefined;
      item.attempts++;
      await c.query(
        `UPDATE outbox SET status='LEASED',lease_until=now()+($3||' seconds')::interval,attempts=$4 WHERE tenant_id=$1 AND id=$2`,
        [tenantId, item.id, this.leaseSeconds, item.attempts],
      );
      await c.query(
        `INSERT INTO executions(id,tenant_id,case_id,referral_id,subject_type,subject_id,operation,status,attempts,correlation_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,'LEASED',$8,$9)
         ON CONFLICT (tenant_id,id) DO UPDATE SET status='LEASED',attempts=$8,updated_at=now()`,
        [
          item.execution_id,
          tenantId,
          item.case_id,
          item.subject_type === "referral" ? item.subject_id : null,
          item.subject_type,
          item.subject_id,
          item.operation,
          item.attempts,
          item.correlation_id,
        ],
      );
      return item;
    });
  }

  private request(item: OutboxItem): ConnectorRequest {
    const parsed = connectorRequestSchema.safeParse(item.payload);
    if (parsed.success) {
      if (
        parsed.data.execution_id !== item.execution_id ||
        parsed.data.case_id !== item.case_id
      )
        throw new InvalidConnectorResponseError(
          "outbox payload identity mismatch",
          "PAYLOAD_IDENTITY_MISMATCH",
        );
      return parsed.data;
    }
    // Pre-v1.1 outbox rows carry only { execution_id, referral_id }.
    return {
      schema_version: "connector-request.v1",
      execution_id: item.execution_id,
      tenant_id: item.tenant_id,
      case_id: item.case_id,
      subject: { type: item.subject_type, id: item.subject_id },
      operation: item.operation as Operation,
      correlation_id: item.correlation_id,
      payload: { referral_id: item.subject_id },
    };
  }

  private async claimAndDispatch(tenantId: string): Promise<boolean> {
    const item = await this.claim(tenantId);
    if (!item) return false;
    log("info", "outbox_claimed", {
      tenant_id: tenantId,
      case_id: item.case_id,
      execution_id: item.execution_id,
      correlation_id: item.correlation_id,
      operation: item.operation,
      retry_attempt: item.attempts,
      queue_age_ms: Date.now() - new Date(item.created_at).getTime(),
    });
    const decision = authorizeOperation(item.case_type, item.operation);
    if (!decision.allowed) {
      await this.settle(item, {
        kind: "failed",
        code: decision.code,
        workKind: "CONNECTOR",
      });
      return true;
    }
    if (!this.gate.isEnabled(decision.capability)) {
      await this.settle(item, {
        kind: "failed",
        code: "UNSUPPORTED_OPERATION",
        workKind: "MANUAL_DESTINATION",
      });
      return true;
    }
    // An expired lease means the previous worker may have sent the request.
    // Re-sending is only safe if the destination de-duplicates execution_id.
    if (
      item.prior_status === "LEASED" &&
      decision.consequential &&
      !this.gate.descriptor(decision.capability)?.idempotentByExecutionId
    ) {
      await this.settle(item, {
        kind: "ambiguous",
        code: "LEASE_EXPIRED_POSSIBLE_SEND",
      });
      return true;
    }
    // An appointment step is sent only while its request still expects it,
    // exactly as recorded; nothing reaches the destination otherwise.
    let prepared: ConnectorRequest | undefined;
    if (isAppointmentCaseType(item.case_type)) {
      const step = await this.tx(tenantId, (c) =>
        this.appointments.prepare(c, item),
      );
      if ("skip" in step) {
        await this.settle(item, { kind: "skipped", code: step.skip });
        return true;
      }
      prepared = step.request;
    }
    let outcome: Outcome;
    try {
      const request = prepared ?? this.request(item);
      outcome = this.interpret(
        request,
        await this.connector.execute(request),
        decision.consequential,
      );
    } catch (error) {
      outcome = this.classify(error, decision.consequential);
    }
    await this.settle(item, outcome);
    return true;
  }

  /** Validate and bind a connector result to the intended execution. */
  private interpret(
    request: ConnectorRequest,
    raw: unknown,
    consequential: boolean,
  ): Outcome {
    const executionId = request.execution_id;
    const parsed = connectorResultSchema.safeParse(raw);
    if (!parsed.success)
      return consequential
        ? { kind: "ambiguous", code: "INVALID_CONNECTOR_RESPONSE" }
        : { kind: "retryable", code: "INVALID_CONNECTOR_RESPONSE" };
    const result: ConnectorResult = parsed.data;
    if (result.execution_id !== executionId) {
      log("error", "connector_execution_id_mismatch", {
        execution_id: executionId,
        code: "EXECUTION_ID_MISMATCH",
      });
      // Never apply someone else's result; our own effect is unknown.
      return consequential
        ? { kind: "ambiguous", code: "EXECUTION_ID_MISMATCH" }
        : { kind: "retryable", code: "EXECUTION_ID_MISMATCH" };
    }
    switch (result.status) {
      case "SUCCEEDED":
        if (!validAppointmentData(request.operation, result.data, request))
          return consequential
            ? { kind: "ambiguous", code: "INVALID_OPERATION_DATA" }
            : { kind: "retryable", code: "INVALID_OPERATION_DATA" };
        return {
          kind: "succeeded",
          externalId: result.external_id,
          ...(result.data ? { data: result.data } : {}),
        };
      case "RETRYABLE":
        return { kind: "retryable", code: result.code };
      case "PERMANENT":
        return { kind: "failed", code: result.code, workKind: "CONNECTOR" };
      case "DEFERRED":
        return {
          kind: "failed",
          code: "DEFERRED",
          workKind: "MANUAL_DESTINATION",
        };
      case "UNSUPPORTED_OPERATION":
        return {
          kind: "failed",
          code: "UNSUPPORTED_OPERATION",
          workKind: "MANUAL_DESTINATION",
        };
      case "AMBIGUOUS":
        return { kind: "ambiguous", code: "CONNECTOR_REPORTED_AMBIGUOUS" };
      case "NOT_COMMITTED":
        // A read-back result has no meaning for a write: its effect is unknown.
        return consequential
          ? { kind: "ambiguous", code: "UNEXPECTED_READBACK_RESULT" }
          : { kind: "retryable", code: "UNEXPECTED_READBACK_RESULT" };
    }
  }
  /** Thrown errors: only an explicit known-not-sent error is retried. */
  private classify(error: unknown, consequential: boolean): Outcome {
    if (error instanceof SafeRetryableConnectorError)
      return { kind: "retryable", code: error.code };
    if (error instanceof PermanentConnectorError)
      return { kind: "failed", code: error.code, workKind: "CONNECTOR" };
    if (error instanceof UnsupportedOperationError)
      return {
        kind: "failed",
        code: "UNSUPPORTED_OPERATION",
        workKind: "MANUAL_DESTINATION",
      };
    const code =
      error instanceof AmbiguousConnectorError ||
      error instanceof InvalidConnectorResponseError
        ? error.code
        : "UNCLASSIFIED_CONNECTOR_ERROR";
    return consequential
      ? { kind: "ambiguous", code }
      : { kind: "retryable", code };
  }

  /** Apply an outcome only while this worker still holds the lease (fence). */
  private async settle(item: OutboxItem, outcome: Outcome) {
    await this.tx(item.tenant_id, async (c) => {
      const held = await c.query(
        "SELECT 1 FROM outbox WHERE tenant_id=$1 AND id=$2 AND status='LEASED' AND attempts=$3 FOR UPDATE",
        [item.tenant_id, item.id, item.attempts],
      );
      if (!held.rowCount) {
        log("warn", "dispatch_lease_lost", {
          execution_id: item.execution_id,
          retry_attempt: item.attempts,
        });
        return;
      }
      const ctx = {
        tenantId: item.tenant_id,
        correlationId: item.correlation_id,
        actor: connectorActor(this.connector),
      };
      const subject: Subject = { type: item.subject_type, id: item.subject_id };
      // Appointment operations settle against their request; referral
      // settlement below is unchanged.
      const appointment = isAppointmentCaseType(item.case_type);
      switch (outcome.kind) {
        case "succeeded":
          await c.query(
            "UPDATE outbox SET status='DONE',lease_until=null,last_error=null WHERE tenant_id=$1 AND id=$2",
            [item.tenant_id, item.id],
          );
          if (appointment)
            await this.appointments.succeeded(
              c,
              ctx,
              item,
              outcome.externalId,
              outcome.data,
              "CONNECTOR",
            );
          else
            await this.commitDestination(
              c,
              ctx,
              item.case_id,
              subject,
              item.execution_id,
              outcome.externalId,
              "CONNECTOR",
            );
          break;
        case "retryable":
          if (item.attempts < this.options.maxDispatch) {
            await c.query(
              "UPDATE outbox SET status='PENDING',available_at=now()+($3||' seconds')::interval,lease_until=null,last_error=$4 WHERE tenant_id=$1 AND id=$2",
              [
                item.tenant_id,
                item.id,
                this.options.retrySeconds,
                outcome.code,
              ],
            );
            await c.query(
              "UPDATE executions SET status='RETRYABLE',last_error=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
              [item.tenant_id, item.execution_id, outcome.code],
            );
            log("warn", "dispatch_retry_scheduled", {
              execution_id: item.execution_id,
              retry_attempt: item.attempts,
              code: outcome.code,
            });
            break;
          }
          await c.query(
            "UPDATE outbox SET status='POISON',lease_until=null,last_error=$3 WHERE tenant_id=$1 AND id=$2",
            [item.tenant_id, item.id, outcome.code],
          );
          await c.query(
            "UPDATE executions SET status='POISON',last_error=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
            [item.tenant_id, item.execution_id, outcome.code],
          );
          // Every attempt was known not to have committed: a refusal.
          if (appointment)
            await this.appointments.failed(
              c,
              { ...ctx, actor: WORKER_ACTOR },
              item,
              outcome.code,
              "CONNECTOR",
            );
          else
            await this.escalate(
              c,
              { ...ctx, actor: WORKER_ACTOR },
              item.case_id,
              subject,
              "dispatch_poisoned",
              "CONNECTOR",
              {
                execution_id: item.execution_id,
                attempts: item.attempts,
                code: outcome.code,
              },
            );
          log("error", "dispatch_became_poison", {
            execution_id: item.execution_id,
            retry_attempt: item.attempts,
            code: outcome.code,
          });
          break;
        case "failed":
          await c.query(
            "UPDATE outbox SET status='DONE',lease_until=null,last_error=$3 WHERE tenant_id=$1 AND id=$2",
            [item.tenant_id, item.id, outcome.code],
          );
          await c.query(
            "UPDATE executions SET status='PERMANENT',last_error=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
            [item.tenant_id, item.execution_id, outcome.code],
          );
          if (appointment)
            await this.appointments.failed(
              c,
              ctx,
              item,
              outcome.code,
              outcome.workKind,
            );
          else
            await this.escalate(
              c,
              ctx,
              item.case_id,
              subject,
              "destination_failed",
              outcome.workKind,
              {
                execution_id: item.execution_id,
                code: outcome.code,
              },
            );
          log("warn", "dispatch_failed", {
            execution_id: item.execution_id,
            code: outcome.code,
          });
          break;
        case "ambiguous": {
          await c.query(
            "UPDATE outbox SET status='DONE',lease_until=null,last_error=$3 WHERE tenant_id=$1 AND id=$2",
            [item.tenant_id, item.id, outcome.code],
          );
          await c.query(
            `UPDATE executions SET status='AMBIGUOUS',last_error=$3,first_ambiguous_at=coalesce(first_ambiguous_at,now()),
                    next_reconcile_at=now()+($4||' seconds')::interval,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
            [
              item.tenant_id,
              item.execution_id,
              outcome.code,
              this.options.reconcileBaseSeconds,
            ],
          );
          if (appointment)
            await this.appointments.ambiguous(c, ctx, item, outcome.code);
          else {
            // Evidence without a state change: the case stays DESTINATION_PENDING.
            const caseRow = await lockCase(c, item.tenant_id, item.case_id);
            await evidence(c, ctx, caseRow, subject, {
              eventType: "destination_ambiguous",
              payload: { execution_id: item.execution_id, code: outcome.code },
            });
          }
          log("warn", "ambiguous_execution_detected", {
            execution_id: item.execution_id,
            code: outcome.code,
          });
          break;
        }
        case "skipped":
          await c.query(
            "UPDATE outbox SET status='DONE',lease_until=null,last_error=$3 WHERE tenant_id=$1 AND id=$2",
            [item.tenant_id, item.id, outcome.code],
          );
          await this.appointments.skipped(
            c,
            { ...ctx, actor: WORKER_ACTOR },
            item,
            outcome.code,
          );
          log("warn", "appointment_step_skipped", {
            case_id: item.case_id,
            execution_id: item.execution_id,
            code: outcome.code,
          });
          break;
      }
    });
  }

  /** Move the case to EXCEPTION (if possible) and open exactly one work item. */
  private async escalate(
    c: DbClient,
    ctx: { tenantId: string; correlationId: string; actor: ActorRef },
    caseId: string,
    subject: Subject,
    eventType: string,
    workKind: WorkItemKind,
    details: Record<string, unknown>,
  ) {
    let caseRow = await lockCase(c, ctx.tenantId, caseId);
    const definition = await this.ruleDefinition(c, ctx.tenantId, caseId);
    const reason = `${eventType}:${String(details.code ?? "")}`.replace(
      /:$/,
      "",
    );
    if (caseRow.current_state === "DESTINATION_PENDING")
      caseRow = await transitionCase(c, ctx, caseRow, {
        to: "EXCEPTION",
        reason: eventType,
        owner: ownerFor(definition, workKind),
        exceptionReason: reason,
        details,
      });
    await evidence(c, ctx, caseRow, subject, { eventType, payload: details });
    await openWorkItem(c, ctx, caseRow, {
      kind: workKind,
      reason,
      ownerRole: ownerFor(definition, workKind),
      referralId: subject.type === "referral" ? subject.id : null,
      evidence: details,
    });
  }

  private async ruleDefinition(
    c: DbClient,
    tenantId: string,
    caseId: string,
  ): Promise<RuleDefinition | null> {
    const row = await c.query<{ rule_set_id: string | null }>(
      "SELECT rule_set_id FROM referrals WHERE tenant_id=$1 AND case_id=$2",
      [tenantId, caseId],
    );
    const id = row.rows[0]?.rule_set_id;
    return id ? (await loadRuleSet(c, tenantId, id)).definition : null;
  }

  /** Destination accepted the referral: open for booking, not complete. */
  private async commitDestination(
    c: DbClient,
    ctx: { tenantId: string; correlationId: string; actor: ActorRef },
    caseId: string,
    subject: Subject,
    executionId: string,
    externalId: string,
    via: "CONNECTOR" | "RECONCILIATION",
  ) {
    await c.query(
      `UPDATE executions SET status='SUCCEEDED',external_id=$3,last_error=NULL,next_reconcile_at=NULL,reconcile_lease_until=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [ctx.tenantId, executionId, externalId],
    );
    let caseRow = await lockCase(c, ctx.tenantId, caseId);
    if (caseRow.current_state !== "DESTINATION_PENDING") {
      // Committed, but the case moved on (e.g. staff intervened): human review.
      await evidence(c, ctx, caseRow, subject, {
        eventType: "destination_committed_unexpected_state",
        payload: {
          execution_id: executionId,
          external_id: externalId,
          state: caseRow.current_state,
        },
      });
      await openWorkItem(c, ctx, caseRow, {
        kind: "CONNECTOR",
        reason: `committed_while_${caseRow.current_state.toLowerCase()}`,
        ownerRole: "PRACTICE_MANAGER",
        evidence: { execution_id: executionId },
      });
      return;
    }
    const definition = await this.ruleDefinition(c, ctx.tenantId, caseId);
    await c.query(
      `UPDATE referrals SET destination_reference=$3,destination_reference_source='CONNECTOR',destination_committed_at=now(),
              follow_up_due_at=now()+($4||' hours')::interval,outcome_next_poll_at=now()+($5||' minutes')::interval,updated_at=now()
        WHERE tenant_id=$1 AND case_id=$2`,
      [
        ctx.tenantId,
        caseId,
        externalId,
        definition?.follow_up.ready_for_booking_hours ?? 48,
        definition?.outcome_polling.interval_minutes ?? 60,
      ],
    );
    caseRow = await transitionCase(c, ctx, caseRow, {
      to: "READY_FOR_BOOKING",
      reason:
        via === "CONNECTOR"
          ? "destination_committed"
          : "destination_committed_by_reconciliation",
      owner: "REFERRAL_COORDINATOR",
      details: { execution_id: executionId, destination_source: "CONNECTOR" },
    });
    await evidence(c, ctx, caseRow, subject, {
      eventType:
        via === "CONNECTOR"
          ? "destination_committed"
          : "reconciliation_succeeded",
      payload: { execution_id: executionId, external_id: externalId },
    });
    await recordMilestone(c, ctx, caseRow, "DESTINATION_COMMITTED", {
      sourceType: via,
      verificationLevel: "EXTERNAL_CONFIRMED",
      sourceReference: executionId,
      payload: { execution_id: executionId },
    });
    await applyPendingObservations(c, ctx, caseRow);
    log("info", "destination_committed", {
      case_id: caseId,
      execution_id: executionId,
      code: via,
    });
  }

  // -------------------------------------------------------------------------
  // Reconciliation of ambiguous writes (read back, never re-send)
  // -------------------------------------------------------------------------

  async reconcile(): Promise<number> {
    let count = 0;
    for (const tenant of await this.tenants()) {
      // Staff asked for another read-back after automated checking stopped.
      await this.tx(tenant, (c) => this.appointments.rearmRechecks(c, tenant));
      const due = await this.tx(tenant, async (c) => {
        const rows = await c.query<DueExecution>(
          `SELECT e.id,e.case_id,e.subject_type,e.subject_id,e.operation,e.reconcile_attempts,
                  coalesce(e.correlation_id,o.correlation_id) AS correlation_id,o.payload,c.case_type
             FROM executions e
             JOIN outbox o ON o.tenant_id=e.tenant_id AND o.execution_id=e.id
             JOIN access_cases c ON c.tenant_id=e.tenant_id AND c.id=e.case_id
            WHERE e.tenant_id=$1 AND e.status IN ('AMBIGUOUS','RECONCILING') AND e.escalated_at IS NULL AND e.superseded_at IS NULL
              AND e.next_reconcile_at<=now() AND (e.reconcile_lease_until IS NULL OR e.reconcile_lease_until<now())
            ORDER BY e.next_reconcile_at LIMIT 20 FOR UPDATE OF e SKIP LOCKED`,
          [tenant],
        );
        for (const row of rows.rows)
          await c.query(
            "UPDATE executions SET status='RECONCILING',reconcile_lease_until=now()+($3||' seconds')::interval WHERE tenant_id=$1 AND id=$2",
            [tenant, row.id, this.leaseSeconds],
          );
        return rows.rows;
      });
      for (const x of due) {
        const attempt = x.reconcile_attempts + 1;
        log("info", "reconciliation_attempted", {
          execution_id: x.id,
          correlation_id: x.correlation_id,
          retry_attempt: attempt,
        });
        const outcome = isAppointmentCaseType(x.case_type)
          ? await this.readBackAppointment(tenant, x)
          : await this.readBackReferral(tenant, x);
        await this.applyReconcile(tenant, x, attempt, outcome);
        count++;
      }
    }
    return count;
  }

  private async readBackReferral(
    tenant: string,
    x: DueExecution,
  ): Promise<ReconcileOutcome> {
    if (!this.gate.isEnabled("referral.status.read"))
      return { kind: "final", code: "READBACK_UNSUPPORTED" };
    try {
      const request: ConnectorRequest = connectorRequestSchema.safeParse(
        x.payload,
      ).success
        ? connectorRequestSchema.parse(x.payload)
        : {
            schema_version: "connector-request.v1",
            execution_id: x.id,
            tenant_id: tenant,
            case_id: x.case_id,
            subject: { type: x.subject_type, id: x.subject_id },
            operation: x.operation as Operation,
            correlation_id: x.correlation_id,
            payload: { referral_id: x.subject_id },
          };
      const parsed = connectorResultSchema.safeParse(
        await this.connector.reconcile(request),
      );
      if (!parsed.success)
        return { kind: "inconclusive", code: "INVALID_CONNECTOR_RESPONSE" };
      if (parsed.data.execution_id !== x.id)
        return { kind: "inconclusive", code: "EXECUTION_ID_MISMATCH" };
      if (parsed.data.status === "SUCCEEDED")
        return { kind: "succeeded", externalId: parsed.data.external_id };
      if (
        parsed.data.status === "AMBIGUOUS" ||
        parsed.data.status === "RETRYABLE"
      )
        return { kind: "inconclusive", code: "READBACK_INCONCLUSIVE" };
      return { kind: "final", code: `READBACK_${parsed.data.status}` };
    } catch (error) {
      return error instanceof UnsupportedOperationError
        ? { kind: "final", code: "READBACK_UNSUPPORTED" }
        : { kind: "inconclusive", code: "READBACK_ERROR" };
    }
  }

  /**
   * Read an appointment write back by its execution_id with the request
   * that was sent. Only NOT_COMMITTED - the destination authoritatively
   * holds no effect - ever permits the step to be tried again.
   */
  private async readBackAppointment(
    tenant: string,
    x: DueExecution,
  ): Promise<ReconcileOutcome> {
    if (!this.gate.isEnabled("appointment.status.read"))
      return { kind: "final", code: "READBACK_UNSUPPORTED" };
    const step = await this.tx(tenant, (c) =>
      this.appointments.prepare(c, this.appointmentItem(tenant, x)),
    );
    if ("skip" in step) return { kind: "final", code: `READBACK_${step.skip}` };
    try {
      const parsed = connectorResultSchema.safeParse(
        await this.connector.reconcile(step.request),
      );
      if (!parsed.success)
        return { kind: "inconclusive", code: "INVALID_CONNECTOR_RESPONSE" };
      if (parsed.data.execution_id !== x.id)
        return { kind: "inconclusive", code: "EXECUTION_ID_MISMATCH" };
      switch (parsed.data.status) {
        case "SUCCEEDED":
          return validAppointmentData(
            x.operation,
            parsed.data.data,
            step.request,
          )
            ? {
                kind: "succeeded",
                externalId: parsed.data.external_id,
                ...(parsed.data.data ? { data: parsed.data.data } : {}),
              }
            : { kind: "inconclusive", code: "INVALID_OPERATION_DATA" };
        case "NOT_COMMITTED":
          return { kind: "not_committed" };
        case "AMBIGUOUS":
        case "RETRYABLE":
          return { kind: "inconclusive", code: "READBACK_INCONCLUSIVE" };
        default:
          return { kind: "final", code: `READBACK_${parsed.data.status}` };
      }
    } catch (error) {
      if (error instanceof UnsupportedOperationError)
        return { kind: "final", code: "READBACK_UNSUPPORTED" };
      if (error instanceof PermanentConnectorError)
        return {
          kind: "final",
          code: error.code.startsWith("READBACK_")
            ? error.code
            : `READBACK_${error.code}`,
        };
      return { kind: "inconclusive", code: "READBACK_ERROR" };
    }
  }

  private appointmentItem(tenant: string, x: DueExecution) {
    return {
      tenant_id: tenant,
      case_id: x.case_id,
      operation: x.operation,
      execution_id: x.id,
      payload: x.payload,
    };
  }

  private async applyReconcile(
    tenantId: string,
    x: DueExecution,
    attempt: number,
    outcome: ReconcileOutcome,
  ) {
    await this.tx(tenantId, async (c) => {
      // Fence: only the reconciler that claimed this attempt may apply it.
      const held = await c.query(
        "SELECT 1 FROM executions WHERE tenant_id=$1 AND id=$2 AND status='RECONCILING' AND reconcile_attempts=$3 AND escalated_at IS NULL FOR UPDATE",
        [tenantId, x.id, x.reconcile_attempts],
      );
      if (!held.rowCount) return;
      const ctx = {
        tenantId,
        correlationId: x.correlation_id,
        actor: connectorActor(this.connector),
      };
      const subject: Subject = { type: x.subject_type, id: x.subject_id };
      const appointment = isAppointmentCaseType(x.case_type);
      if (outcome.kind === "succeeded") {
        await c.query(
          "UPDATE executions SET reconcile_attempts=$3,last_reconcile_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenantId, x.id, attempt],
        );
        if (appointment)
          await this.appointments.succeeded(
            c,
            ctx,
            this.appointmentItem(tenantId, x),
            outcome.externalId,
            outcome.data,
            "RECONCILIATION",
          );
        else
          await this.commitDestination(
            c,
            ctx,
            x.case_id,
            subject,
            x.id,
            outcome.externalId,
            "RECONCILIATION",
          );
        log("info", "reconciliation_succeeded", {
          execution_id: x.id,
          retry_attempt: attempt,
        });
        return;
      }
      if (outcome.kind === "not_committed") {
        await c.query(
          "UPDATE executions SET reconcile_attempts=$3,last_reconcile_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenantId, x.id, attempt],
        );
        await this.appointments.notCommitted(
          c,
          ctx,
          this.appointmentItem(tenantId, x),
        );
        log("info", "reconciliation_not_committed", {
          execution_id: x.id,
          retry_attempt: attempt,
          operation: x.operation,
        });
        return;
      }
      if (
        outcome.kind === "inconclusive" &&
        attempt < this.options.maxReconcile
      ) {
        // Technical-only: no case version change, no business evidence.
        const delay = Math.min(
          300,
          this.options.reconcileBaseSeconds * 2 ** (attempt - 1),
        );
        await c.query(
          `UPDATE executions SET reconcile_attempts=$3,last_reconcile_at=now(),next_reconcile_at=now()+($4||' seconds')::interval,
                  reconcile_lease_until=NULL,last_error=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
          [tenantId, x.id, attempt, delay, outcome.code],
        );
        log("warn", "reconciliation_remained_ambiguous", {
          execution_id: x.id,
          retry_attempt: attempt,
          code: outcome.code,
        });
        return;
      }
      // Effect still unknown: stop polling and hand to a person. Never re-send.
      await c.query(
        `UPDATE executions SET status='AMBIGUOUS',reconcile_attempts=$3,last_reconcile_at=now(),next_reconcile_at=NULL,
                reconcile_lease_until=NULL,escalated_at=now(),last_error=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [tenantId, x.id, attempt, outcome.code],
      );
      const code =
        outcome.code === "READBACK_INCONCLUSIVE"
          ? "RECONCILIATION_EXHAUSTED"
          : outcome.code;
      if (appointment)
        await this.appointments.escalated(
          c,
          ctx,
          this.appointmentItem(tenantId, x),
          code,
        );
      else
        await this.escalate(
          c,
          { ...ctx, actor: WORKER_ACTOR },
          x.case_id,
          subject,
          "reconciliation_escalated",
          "CONNECTOR",
          {
            execution_id: x.id,
            attempts: attempt,
            code,
          },
        );
      log("error", "reconciliation_escalated", {
        execution_id: x.id,
        retry_attempt: attempt,
        code: outcome.code,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Appointment timers: hold expiry, steps that will never run
  // -------------------------------------------------------------------------

  async sweepAppointments(): Promise<number> {
    let changed = 0;
    for (const tenant of await this.tenants())
      changed += await this.tx(tenant, async (c) => {
        const expired = await this.appointments.expireHolds(c, tenant);
        const closed = await this.appointments.closeSupersededSteps(c, tenant);
        return expired + closed;
      });
    return changed;
  }

  // -------------------------------------------------------------------------
  // Closed-loop readback of what happened after the destination commit
  // -------------------------------------------------------------------------

  async pollOutcomes(): Promise<number> {
    if (!this.gate.isEnabled("appointment.status.read")) return 0;
    let count = 0;
    for (const tenant of await this.tenants()) {
      const due = await this.tx(tenant, async (c) => {
        const rows = await c.query<{
          case_id: string;
          destination_reference: string;
          correlation_id: string;
        }>(
          `SELECT r.case_id, r.destination_reference, c.id AS correlation_id
             FROM referrals r JOIN access_cases c ON c.tenant_id=r.tenant_id AND c.id=r.case_id
            WHERE r.tenant_id=$1 AND c.current_state IN ('READY_FOR_BOOKING','WAITING')
              AND r.destination_reference_source='CONNECTOR' AND r.outcome_next_poll_at<=now()
            ORDER BY r.outcome_next_poll_at LIMIT 20 FOR UPDATE OF r SKIP LOCKED`,
          [tenant],
        );
        for (const row of rows.rows)
          await c.query(
            "UPDATE referrals SET outcome_next_poll_at=now()+interval '5 minutes' WHERE tenant_id=$1 AND case_id=$2",
            [tenant, row.case_id],
          );
        return rows.rows;
      });
      for (const row of due) {
        try {
          const parsed = appointmentOutcomeSchema.safeParse(
            await this.connector.getAppointmentOutcome({
              tenant_id: tenant,
              case_id: row.case_id,
              destination_reference: row.destination_reference,
            }),
          );
          if (
            !parsed.success ||
            parsed.data.destination_reference !== row.destination_reference
          ) {
            log("warn", "outcome_readback_rejected", {
              case_id: row.case_id,
              code: parsed.success ? "REFERENCE_MISMATCH" : "INVALID_RESPONSE",
            });
            continue;
          }
          await this.applyOutcome(tenant, row.case_id, parsed.data);
          count++;
        } catch (error) {
          log("warn", "outcome_readback_failed", {
            case_id: row.case_id,
            ...errorFields(error),
          });
        }
      }
    }
    return count;
  }

  private async applyOutcome(
    tenantId: string,
    caseId: string,
    outcome: import("@access/contracts").AppointmentOutcome,
  ) {
    const types: Partial<Record<typeof outcome.outcome, ObservationType>> = {
      BOOKING_REQUESTED: "BOOKING_REQUESTED",
      BOOKED: "APPOINTMENT_BOOKED",
      CANCELLED: "APPOINTMENT_CANCELLED",
      PATIENT_UNREACHABLE: "PATIENT_UNREACHABLE",
      PATIENT_DECLINED: "PATIENT_DECLINED",
      PROVIDER_DECLINED: "PROVIDER_DECLINED",
    };
    await this.tx(tenantId, async (c) => {
      const caseRow = await lockCase(c, tenantId, caseId);
      const definition = await this.ruleDefinition(c, tenantId, caseId);
      const type = types[outcome.outcome];
      let after: CaseRow = caseRow;
      if (type) {
        const result = await recordObservation(
          c,
          {
            tenantId,
            correlationId: caseId,
            actor: connectorActor(this.connector),
          },
          caseRow,
          {
            type,
            // When the destination does not say when, the time we observed it
            // is recorded and labelled as such - never a guessed event time.
            occurredAt: outcome.occurred_at
              ? new Date(outcome.occurred_at)
              : new Date(),
            sourceType: "CONNECTOR",
            sourceReference:
              outcome.source_reference ??
              `${outcome.destination_reference}:${outcome.outcome}`,
            verificationLevel: outcome.occurred_at
              ? "EXTERNAL_CONFIRMED"
              : "OBSERVED",
            actorId: null,
            payload: {
              occurred_at_source: outcome.occurred_at
                ? "destination"
                : "observation_time",
            },
          },
        );
        after = result.caseRow;
      }
      if (["READY_FOR_BOOKING", "WAITING"].includes(after.current_state))
        await c.query(
          "UPDATE referrals SET outcome_next_poll_at=now()+($3||' minutes')::interval WHERE tenant_id=$1 AND case_id=$2",
          [
            tenantId,
            caseId,
            definition?.outcome_polling.interval_minutes ?? 60,
          ],
        );
    });
  }

  // -------------------------------------------------------------------------
  // Administrative timers: follow-up due, stalled-case escalation
  // -------------------------------------------------------------------------

  async sweepTimers(): Promise<number> {
    let opened = 0;
    for (const tenant of await this.tenants())
      opened += await this.tx(tenant, async (c) => {
        let n = 0;
        const ruleSets = new Map<string, RuleDefinition>();
        const definitionFor = async (id: string | null) => {
          if (!id) return null;
          if (!ruleSets.has(id))
            ruleSets.set(id, (await loadRuleSet(c, tenant, id)).definition);
          return ruleSets.get(id)!;
        };
        const followUps = await c.query<{
          case_id: string;
          rule_set_id: string | null;
          follow_up_count: number;
          follow_up_due_at: Date;
        }>(
          `SELECT r.case_id,r.rule_set_id,r.follow_up_count,r.follow_up_due_at FROM referrals r
             JOIN access_cases c ON c.tenant_id=r.tenant_id AND c.id=r.case_id
            WHERE r.tenant_id=$1 AND c.current_state IN ('READY_FOR_BOOKING','WAITING') AND r.follow_up_due_at<=now()
              AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.tenant_id=r.tenant_id AND w.case_id=r.case_id AND w.kind='FOLLOW_UP' AND w.status='OPEN')
            LIMIT 100`,
          [tenant],
        );
        for (const f of followUps.rows) {
          const d = await definitionFor(f.rule_set_id);
          const caseRow = await lockCase(c, tenant, f.case_id);
          const limit = d?.follow_up.max_follow_ups ?? 3;
          const created = await openWorkItem(
            c,
            { tenantId: tenant, correlationId: f.case_id, actor: WORKER_ACTOR },
            caseRow,
            {
              kind: "FOLLOW_UP",
              reason:
                f.follow_up_count >= limit
                  ? "follow_up_limit_reached"
                  : "follow_up_due",
              ownerRole: ownerFor(d, "FOLLOW_UP"),
              dueAt: f.follow_up_due_at,
              evidence: { follow_up_count: f.follow_up_count, limit },
            },
          );
          if (created.created) n++;
        }
        const candidates = await c.query<{
          case_id: string;
          state: string;
          rule_set_id: string | null;
          entered_at: Date;
        }>(
          `SELECT c.id AS case_id,c.current_state AS state,r.rule_set_id,
                  (SELECT max(t.occurred_at) FROM access_case_transitions t WHERE t.tenant_id=c.tenant_id AND t.case_id=c.id AND t.to_state=c.current_state) AS entered_at
             FROM access_cases c LEFT JOIN referrals r ON r.tenant_id=c.tenant_id AND r.case_id=c.id
            WHERE c.tenant_id=$1 AND c.current_state NOT IN ('BOOKED','CLOSED','REJECTED')
              AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.tenant_id=c.tenant_id AND w.case_id=c.id AND w.kind='ESCALATION' AND w.status='OPEN')
            LIMIT 500`,
          [tenant],
        );
        for (const k of candidates.rows) {
          const d = await definitionFor(k.rule_set_id);
          const rule = d?.escalation.find((e) => e.state === k.state);
          if (!rule || !k.entered_at) continue;
          if (
            Date.now() - new Date(k.entered_at).getTime() <
            rule.after_hours * 3600_000
          )
            continue;
          const caseRow = await lockCase(c, tenant, k.case_id);
          const created = await openWorkItem(
            c,
            { tenantId: tenant, correlationId: k.case_id, actor: WORKER_ACTOR },
            caseRow,
            {
              kind: "ESCALATION",
              reason: `stalled_in_${k.state.toLowerCase()}`,
              ownerRole: rule.owner,
              evidence: { state: k.state, after_hours: rule.after_hours },
            },
          );
          if (created.created) n++;
        }
        return n;
      });
    return opened;
  }
}
export { caseSubject };
