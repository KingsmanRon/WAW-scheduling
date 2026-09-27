import {
  appointmentCommitSchema,
  appointmentVerificationSchema,
  availabilityResultSchema,
  cancellationRequestSchema,
  cancellationResultSchema,
  connectorRequestSchema,
  holdResultSchema,
  type AppointmentSlot,
  type ConnectorRequest,
  type WorkItemKind,
} from "@access/contracts";
import { holdIsUsable, refusalIsRecoverable } from "@access/domain";
import {
  WORKER_ACTOR,
  appointmentByExecution,
  blockedStep,
  bookAppointmentCase,
  cancelBlockedSteps,
  caseSubject,
  closeHold,
  completeReschedule,
  evidence,
  findAppointment,
  findHold,
  findRequest,
  insertAppointment,
  insertHold,
  loadRuleSet,
  lockAppointment,
  lockCase,
  lockRequest,
  openWorkItem,
  recordObservation,
  releaseStep,
  resolveWorkItems,
  transitionCase,
  updateAppointment,
  updateOpenWorkItemReason,
  updateRequest,
  type ActorRef,
  type AppointmentRequestRow,
  type CaseRow,
  type DbClient,
} from "@access/db";
import { log } from "@access/observability";
import { ownerFor } from "@access/rules";

/**
 * Settlement of appointment operations. The dispatcher owns execution
 * bookkeeping (leases, attempts, AMBIGUOUS, reconciliation); this module
 * decides what a known outcome means for the booking sub-flow, the case, the
 * appointment, the hold and the originating referral. Everything runs in the
 * dispatcher's fenced transaction.
 */

export function isAppointmentOperation(operation: string): boolean {
  return operation.startsWith("appointment.");
}
/** Operations whose result moves the request; the request must expect them. */
const WORKFLOW_OPERATIONS = new Set([
  "appointment.availability.read",
  "appointment.hold",
  "appointment.create",
  "appointment.reschedule",
  "appointment.verify",
  "appointment.reschedule.cancel_original",
  "appointment.cancel",
]);

/**
 * Operation data must match its contract, and a result about a named
 * appointment must be about the one that was asked for, before it is used.
 */
export function validAppointmentData(
  operation: string,
  data: unknown,
  request: ConnectorRequest,
): boolean {
  const asked = request.payload.appointment_reference;
  switch (operation) {
    case "appointment.availability.read":
      return availabilityResultSchema.safeParse(data).success;
    case "appointment.hold":
      return holdResultSchema.safeParse(data).success;
    case "appointment.create":
    case "appointment.reschedule":
      return appointmentCommitSchema.safeParse(data).success;
    case "appointment.verify": {
      const parsed = appointmentVerificationSchema.safeParse(data);
      return parsed.success && parsed.data.appointment_reference === asked;
    }
    case "appointment.cancel":
    case "appointment.reschedule.cancel_original": {
      const parsed = cancellationResultSchema.safeParse(data);
      return parsed.success && parsed.data.appointment_reference === asked;
    }
    default:
      return true;
  }
}

export interface AppointmentItem {
  tenant_id: string;
  case_id: string;
  operation: string;
  execution_id: string;
  payload: Record<string, unknown>;
}
type Ctx = { tenantId: string; correlationId: string; actor: ActorRef };
type Via = "CONNECTOR" | "RECONCILIATION";

const UNKNOWN_OUTCOME: Record<string, string> = {
  "appointment.hold": "hold_outcome_unknown",
  "appointment.create": "booking_outcome_unknown",
  "appointment.reschedule": "replacement_outcome_unknown",
  "appointment.reschedule.cancel_original":
    "original_cancellation_unconfirmed:both_appointments_may_exist",
  "appointment.cancel": "cancellation_outcome_unknown",
};

export class AppointmentSettlement {
  constructor(
    /** Destination system name recorded on appointments (connector name). */
    private destination: string,
    /** Holds are usable only if the capability is declared AND enabled. */
    private holdsEnabled: () => boolean,
  ) {}

  // -------------------------------------------------------------------------
  // Before foreign I/O
  // -------------------------------------------------------------------------

  /**
   * Is this step still expected, and exactly what is sent? The stored
   * payload is never changed; data produced by earlier steps (the
   * replacement's reference) is read from the database, deterministically,
   * so a read-back rebuilds the same request.
   */
  async prepare(
    c: DbClient,
    item: AppointmentItem,
  ): Promise<{ skip: string } | { request: ConnectorRequest }> {
    const parsed = connectorRequestSchema.safeParse(item.payload);
    if (!parsed.success) return { skip: "PAYLOAD_INVALID" };
    const request = parsed.data;
    if (
      request.execution_id !== item.execution_id ||
      request.case_id !== item.case_id ||
      request.operation !== item.operation
    )
      return { skip: "PAYLOAD_IDENTITY_MISMATCH" };
    const row = await findRequest(c, item.tenant_id, item.case_id);
    if (!row) return { skip: "APPOINTMENT_REQUEST_MISSING" };
    if (
      WORKFLOW_OPERATIONS.has(item.operation) &&
      row.pending_execution_id !== item.execution_id
    )
      return { skip: "STALE_STEP" };
    if (item.operation === "appointment.verify") {
      const committed = row.appointment_id
        ? await findAppointment(c, item.tenant_id, row.appointment_id)
        : undefined;
      if (!committed) return { skip: "COMMITTED_APPOINTMENT_UNKNOWN" };
      // The plan names the execution whose appointment is to be read back.
      const planned = request.payload.commit_execution_id;
      if (planned && planned !== committed.create_execution_id)
        return { skip: "COMMITTED_APPOINTMENT_MISMATCH" };
      return {
        request: {
          ...request,
          payload: {
            schema_version: "appointment-verify-request.v1",
            appointment_reference: committed.external_reference,
          },
        },
      };
    }
    if (item.operation === "appointment.reschedule.cancel_original") {
      const replacement = row.appointment_id
        ? await findAppointment(c, item.tenant_id, row.appointment_id)
        : undefined;
      if (!replacement) return { skip: "REPLACEMENT_UNKNOWN" };
      const payload = cancellationRequestSchema.parse(request.payload);
      return {
        request: {
          ...request,
          payload: {
            ...payload,
            replaced_by_reference: replacement.external_reference,
          },
        },
      };
    }
    return { request };
  }

  // -------------------------------------------------------------------------
  // Known outcomes
  // -------------------------------------------------------------------------

  async succeeded(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
    externalId: string,
    data: unknown,
    via: Via,
  ): Promise<void> {
    await c.query(
      `UPDATE executions SET status='SUCCEEDED',external_id=$3,last_error=NULL,next_reconcile_at=NULL,reconcile_lease_until=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [ctx.tenantId, item.execution_id, externalId],
    );
    if (item.operation === "appointment.hold.release") return;
    const loaded = await this.load(c, ctx, item);
    if (!loaded) return;
    let { caseRow, row } = loaded;
    switch (item.operation) {
      case "appointment.availability.read": {
        const result = availabilityResultSchema.parse(data);
        const holds = this.holdsEnabled();
        const slots: AppointmentSlot[] = result.slots.map((s) => ({
          ...s,
          hold_supported: s.hold_supported && holds,
          hold_expires_at: null,
        }));
        const observed = new Date(
          Math.min(Date.parse(result.observed_at), Date.now()),
        );
        row = await updateRequest(c, row, {
          workflow_status: slots.length
            ? "AVAILABILITY_RETURNED"
            : "NO_AVAILABILITY",
          availability: {
            execution_id: item.execution_id,
            observed_at: observed.toISOString(),
            slots,
          },
          availability_observed_at: observed,
          selected_slot: null,
          selected_slot_reference: null,
          selected_at: null,
          pending_execution_id: null,
          last_failure_code: null,
          last_failure_at: null,
        });
        caseRow = await this.staffDecision(
          c,
          ctx,
          caseRow,
          slots.length ? "availability_returned" : "no_availability",
        );
        await evidence(c, ctx, caseRow, caseSubject(caseRow), {
          eventType: "availability_returned",
          payload: {
            execution_id: item.execution_id,
            slot_count: slots.length,
            observed_at: observed.toISOString(),
            via,
          },
        });
        return;
      }
      case "appointment.hold": {
        const held = holdResultSchema.parse(data);
        const hold = await insertHold(c, {
          tenantId: ctx.tenantId,
          caseId: row.case_id,
          slotReference: held.slot_reference,
          holdReference: held.hold_reference,
          executionId: item.execution_id,
          expiresAt: held.expires_at,
        });
        const usable =
          hold.status === "ACTIVE" &&
          held.slot_reference === row.selected_slot_reference;
        if (!usable && hold.status === "ACTIVE")
          await closeHold(c, ctx.tenantId, hold.id, "RELEASED");
        row = await updateRequest(c, row, {
          workflow_status: usable ? "HELD" : "SLOT_SELECTED",
          current_hold_id: usable ? hold.id : null,
          pending_execution_id: null,
          last_failure_code: usable
            ? null
            : hold.status === "ACTIVE"
              ? "HOLD_SLOT_MISMATCH"
              : "HOLD_EXPIRED",
          last_failure_at: usable ? null : new Date(),
        });
        caseRow = await this.staffDecision(c, ctx, caseRow, "slot_held");
        await evidence(c, ctx, caseRow, caseSubject(caseRow), {
          eventType: "slot_held",
          payload: {
            execution_id: item.execution_id,
            hold_id: hold.id,
            expires_at: held.expires_at,
            status: usable ? "ACTIVE" : "UNUSABLE",
            via,
          },
        });
        return;
      }
      case "appointment.create":
        return this.committed(c, ctx, item, caseRow, row, data, via);
      case "appointment.reschedule":
        return this.replacementBooked(c, ctx, item, caseRow, row, data, via);
      case "appointment.verify": {
        const verified = appointmentVerificationSchema.parse(data);
        const committed = await findAppointment(
          c,
          ctx.tenantId,
          row.appointment_id!,
        );
        const confirmed =
          verified.status === "BOOKED" &&
          verified.appointment_reference === committed?.external_reference;
        if (row.case_type === "APPOINTMENT_REQUEST") {
          if (confirmed)
            return this.verifiedBooking(c, ctx, item, caseRow, row, via);
          // Committed, but the destination does not show it: a person checks.
          row = await updateRequest(c, row, {
            pending_execution_id: null,
            last_failure_code: "BOOKING_UNVERIFIED",
            last_failure_at: new Date(),
          });
          await this.raise(c, ctx, caseRow, row, {
            kind: "CONNECTOR",
            reason: `booking_not_verified:${verified.status.toLowerCase()}`,
          });
          return;
        }
        if (confirmed) {
          const cancel = await blockedStep(
            c,
            ctx.tenantId,
            row.case_id,
            "appointment.reschedule.cancel_original",
          );
          row = await updateRequest(c, row, {
            workflow_status: "ORIGINAL_CANCELLATION_PENDING",
            pending_execution_id: cancel ?? null,
          });
          await evidence(c, ctx, caseRow, caseSubject(caseRow), {
            eventType: "replacement_verified",
            payload: {
              execution_id: item.execution_id,
              appointment_id: row.appointment_id,
            },
          });
          if (cancel && (await releaseStep(c, ctx.tenantId, cancel))) return;
          await this.raise(c, ctx, caseRow, row, {
            kind: "CONNECTOR",
            reason: "original_cancellation_not_planned",
          });
          return;
        }
        // The destination does not confirm B: the original stays untouched.
        await cancelBlockedSteps(
          c,
          ctx.tenantId,
          row.case_id,
          "worker:replacement_unverified",
        );
        row = await updateRequest(c, row, {
          pending_execution_id: null,
          last_failure_code: "REPLACEMENT_UNVERIFIED",
          last_failure_at: new Date(),
        });
        await this.raise(c, ctx, caseRow, row, {
          kind: "CONNECTOR",
          reason: `replacement_not_verified:${verified.status.toLowerCase()}`,
        });
        return;
      }
      case "appointment.reschedule.cancel_original":
        return this.originalSuperseded(c, ctx, item, caseRow, row, data, via);
      case "appointment.cancel":
        return this.cancelled(c, ctx, item, caseRow, row, data, via);
    }
  }

  /**
   * The destination committed the booking: record the appointment (a foreign
   * fact is never dropped) and read it back. BOOKED only after that.
   */
  private async committed(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
    caseRow: CaseRow,
    rowIn: AppointmentRequestRow,
    data: unknown,
    via: Via,
  ) {
    const commit = appointmentCommitSchema.parse(data);
    const appointment = await this.recordAppointment(
      c,
      ctx,
      item,
      rowIn,
      commit,
      via,
      null,
    );
    const verify = await blockedStep(
      c,
      ctx.tenantId,
      rowIn.case_id,
      "appointment.verify",
    );
    const row = await updateRequest(c, rowIn, {
      workflow_status: "COMMITTED",
      appointment_id: appointment.id,
      pending_execution_id: verify ?? null,
      last_failure_code: null,
      last_failure_at: null,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "appointment_committed",
      payload: {
        execution_id: item.execution_id,
        appointment_id: appointment.id,
        slot_reference: appointment.slot_reference,
        starts_at: new Date(appointment.starts_at).toISOString(),
        via,
      },
    });
    if (commit.slot_reference !== rowIn.selected_slot_reference)
      await this.slotDiffers(c, ctx, row, appointment.id);
    log("info", "appointment_committed", {
      case_id: row.case_id,
      execution_id: item.execution_id,
      code: via,
    });
    if (!verify || !(await releaseStep(c, ctx.tenantId, verify)))
      await this.raise(c, ctx, caseRow, row, {
        kind: "CONNECTOR",
        reason: "booking_verification_not_planned",
      });
  }

  /** Read back and confirmed: the booking now counts, and so does the referral's. */
  private async verifiedBooking(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    via: Via,
  ) {
    const appointment = (await findAppointment(
      c,
      ctx.tenantId,
      rowIn.appointment_id!,
    ))!;
    const row = await updateRequest(c, rowIn, {
      workflow_status: "BOOKED",
      pending_execution_id: null,
      last_failure_code: null,
      last_failure_at: null,
    });
    const caseRow = await bookAppointmentCase(
      c,
      ctx,
      caseRowIn,
      appointment.id,
      via,
    );
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "appointment_verified",
      payload: {
        execution_id: item.execution_id,
        appointment_id: appointment.id,
        via,
      },
    });
    // The referral this booking serves: the same observation engine as every
    // other outcome, so a referral in EXCEPTION or already resolved is never
    // moved by it.
    if (row.origin_referral_case_id) {
      const referral = await lockCase(
        c,
        ctx.tenantId,
        row.origin_referral_case_id,
      );
      const observed = await recordObservation(c, ctx, referral, {
        type: "APPOINTMENT_BOOKED",
        occurredAt: new Date(appointment.committed_at),
        sourceType: via,
        sourceReference: `appointment:${appointment.id}`,
        verificationLevel: "EXTERNAL_CONFIRMED",
        actorId: null,
        payload: {
          appointment_id: appointment.id,
          request_case_id: row.case_id,
        },
      });
      await evidence(c, ctx, observed.caseRow, caseSubject(observed.caseRow), {
        eventType: "appointment_booked",
        payload: {
          appointment_id: appointment.id,
          request_case_id: row.case_id,
          disposition: observed.plan.disposition,
        },
      });
    }
  }

  /** The destination committed another slot than the one chosen: say so. */
  private async slotDiffers(
    c: DbClient,
    ctx: Ctx,
    row: AppointmentRequestRow,
    appointmentId: string,
  ) {
    const caseId = row.origin_referral_case_id ?? row.case_id;
    const target = await lockCase(c, ctx.tenantId, caseId);
    await openWorkItem(c, ctx, target, {
      kind: "OUTCOME_REVIEW",
      reason: "committed_slot_differs_from_selection",
      ownerRole: "PRACTICE_MANAGER",
      evidence: { appointment_id: appointmentId, request_case_id: row.case_id },
    });
  }

  private async replacementBooked(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
    caseRow: CaseRow,
    rowIn: AppointmentRequestRow,
    data: unknown,
    via: Via,
  ) {
    const commit = appointmentCommitSchema.parse(data);
    const replacement = await this.recordAppointment(
      c,
      ctx,
      item,
      rowIn,
      commit,
      via,
      rowIn.original_appointment_id,
    );
    const verify = await blockedStep(
      c,
      ctx.tenantId,
      rowIn.case_id,
      "appointment.verify",
    );
    const row = await updateRequest(c, rowIn, {
      workflow_status: "REPLACEMENT_BOOKED",
      appointment_id: replacement.id,
      pending_execution_id: verify ?? null,
      last_failure_code: null,
      last_failure_at: null,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "replacement_committed",
      payload: {
        execution_id: item.execution_id,
        appointment_id: replacement.id,
        replaces_appointment_id: rowIn.original_appointment_id,
        via,
      },
    });
    // Next: read B back. A is untouched until that succeeds.
    if (!verify || !(await releaseStep(c, ctx.tenantId, verify)))
      await this.raise(c, ctx, caseRow, row, {
        kind: "CONNECTOR",
        reason: "replacement_verification_not_planned",
      });
  }

  private async originalSuperseded(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    data: unknown,
    via: Via,
  ) {
    const result = cancellationResultSchema.parse(data);
    const original = await lockAppointment(
      c,
      ctx.tenantId,
      rowIn.original_appointment_id!,
    );
    if (original.status === "BOOKED")
      await updateAppointment(c, original, {
        status: "SUPERSEDED",
        cancelled_at: new Date(result.cancelled_at),
        cancellation_source: via,
        superseded_by_id: rowIn.appointment_id,
      });
    const row = await updateRequest(c, rowIn, {
      workflow_status: "COMPLETED",
      pending_execution_id: null,
      last_failure_code: null,
      last_failure_at: null,
    });
    await completeReschedule(c, ctx, caseRowIn, row, via, {
      execution_id: item.execution_id,
    });
  }

  private async cancelled(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    data: unknown,
    via: Via,
  ) {
    const result = cancellationResultSchema.parse(data);
    const appointment = await lockAppointment(
      c,
      ctx.tenantId,
      rowIn.original_appointment_id!,
    );
    if (appointment.status === "BOOKED")
      await updateAppointment(c, appointment, {
        status: "CANCELLED",
        cancelled_at: new Date(result.cancelled_at),
        cancellation_source: via,
      });
    await updateRequest(c, rowIn, {
      workflow_status: "CANCELLED",
      pending_execution_id: null,
      last_failure_code: null,
      last_failure_at: null,
    });
    let caseRow = caseRowIn;
    if (caseRow.current_state === "EXCEPTION")
      await resolveWorkItems(c, ctx, caseRow, {
        kinds: ["CONNECTOR"],
        resolution: "cancellation_confirmed",
        note: null,
        staffSeconds: undefined,
        automatic: true,
      });
    const closed = await recordObservation(c, ctx, caseRow, {
      type: "APPOINTMENT_CANCELLED",
      occurredAt: new Date(result.cancelled_at),
      sourceType: via,
      sourceReference: `appointment:${appointment.id}:cancelled`,
      verificationLevel: "EXTERNAL_CONFIRMED",
      actorId: null,
      payload: {
        appointment_id: appointment.id,
        execution_id: item.execution_id,
      },
      plan: { disposition: "APPLIED", to: "CLOSED", resolution: "CANCELLED" },
    });
    caseRow = closed.caseRow;
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "appointment_cancelled",
      payload: {
        execution_id: item.execution_id,
        appointment_id: appointment.id,
        via,
      },
    });
    const source = await lockCase(c, ctx.tenantId, appointment.source_case_id);
    await evidence(c, ctx, source, caseSubject(source), {
      eventType: "appointment_cancelled",
      payload: {
        appointment_id: appointment.id,
        cancellation_case_id: rowIn.case_id,
      },
    });
    // A cancelled appointment does not rewrite the referral's outcome; the
    // observation engine raises it for review.
    if (appointment.origin_referral_case_id) {
      const referral = await lockCase(
        c,
        ctx.tenantId,
        appointment.origin_referral_case_id,
      );
      await recordObservation(c, ctx, referral, {
        type: "APPOINTMENT_CANCELLED",
        occurredAt: new Date(result.cancelled_at),
        sourceType: via,
        sourceReference: `appointment:${appointment.id}:cancelled`,
        verificationLevel: "EXTERNAL_CONFIRMED",
        actorId: null,
        payload: {
          appointment_id: appointment.id,
          cancellation_case_id: rowIn.case_id,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Refusals, ambiguity, confirmed absence, escalation
  // -------------------------------------------------------------------------

  /** A definitive refusal (PERMANENT, UNSUPPORTED, DEFERRED, POISON). */
  async failed(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
    code: string,
    workKind: WorkItemKind,
  ): Promise<void> {
    if (item.operation === "appointment.hold.release") {
      // Best effort: an unreleased hold expires on its own.
      const caseRow = await lockCase(c, ctx.tenantId, item.case_id);
      await evidence(c, ctx, caseRow, caseSubject(caseRow), {
        eventType: "hold_release_failed",
        payload: { execution_id: item.execution_id, code },
      });
      return;
    }
    const loaded = await this.load(c, ctx, item);
    if (!loaded) return;
    let { row } = loaded;
    const { caseRow } = loaded;
    const failure = { last_failure_code: code, last_failure_at: new Date() };
    switch (item.operation) {
      case "appointment.availability.read":
        row = await updateRequest(c, row, {
          pending_execution_id: null,
          ...failure,
        });
        await this.raise(c, ctx, caseRow, row, {
          kind: workKind,
          reason: `availability_unavailable:${code.toLowerCase()}`,
        });
        return;
      case "appointment.hold":
        row = refusalIsRecoverable(code)
          ? await this.backToSelection(c, row, failure)
          : await updateRequest(c, row, {
              workflow_status: "SLOT_SELECTED",
              pending_execution_id: null,
              ...failure,
            });
        await this.staffDecision(c, ctx, caseRow, `hold_refused:${code}`);
        return;
      case "appointment.create":
      case "appointment.reschedule": {
        await cancelBlockedSteps(
          c,
          ctx.tenantId,
          row.case_id,
          "worker:booking_refused",
        );
        if (
          row.current_hold_id &&
          (code === "HOLD_EXPIRED" || code === "HOLD_NOT_FOUND")
        )
          await closeHold(c, ctx.tenantId, row.current_hold_id, "EXPIRED");
        if (refusalIsRecoverable(code)) {
          row = await this.backToSelection(c, row, failure);
          const moved = await this.staffDecision(
            c,
            ctx,
            caseRow,
            `booking_refused:${code}`,
          );
          await evidence(c, ctx, moved, caseSubject(moved), {
            eventType: "booking_refused",
            payload: {
              execution_id: item.execution_id,
              code,
              recoverable: true,
            },
          });
          return;
        }
        {
          const held = await this.usableHold(c, row);
          row = await updateRequest(c, row, {
            workflow_status: held ? "HELD" : "SLOT_SELECTED",
            current_hold_id: held ? row.current_hold_id : null,
            pending_execution_id: null,
            ...failure,
          });
        }
        await this.raise(c, ctx, caseRow, row, {
          kind: workKind,
          reason: `booking_refused:${code.toLowerCase()}`,
        });
        return;
      }
      case "appointment.verify":
        // Unverified: nothing further runs; a reschedule leaves A untouched.
        await cancelBlockedSteps(
          c,
          ctx.tenantId,
          row.case_id,
          "worker:commit_unverified",
        );
        row = await updateRequest(c, row, {
          pending_execution_id: null,
          ...failure,
        });
        await this.raise(c, ctx, caseRow, row, {
          kind: workKind,
          reason: `${row.case_type === "RESCHEDULING_REQUEST" ? "replacement" : "booking"}_not_verified:${code.toLowerCase()}`,
        });
        return;
      case "appointment.reschedule.cancel_original":
        row = await updateRequest(c, row, {
          pending_execution_id: null,
          ...failure,
        });
        // B is booked either way; a person decides what happens to A.
        await this.raise(c, ctx, caseRow, row, {
          kind: "CONNECTOR",
          reason:
            code === "ALREADY_CANCELLED"
              ? "original_already_cancelled_elsewhere"
              : `original_not_cancelled:${code.toLowerCase()}:both_appointments_may_exist`,
        });
        return;
      case "appointment.cancel":
        row = await updateRequest(c, row, {
          workflow_status: "CANCELLATION_REQUESTED",
          pending_execution_id: null,
          ...failure,
        });
        await this.raise(c, ctx, caseRow, row, {
          kind: workKind,
          reason: `cancellation_refused:${code.toLowerCase()}`,
        });
        return;
    }
  }

  /** The effect is unknown: the dispatcher reconciles; nothing is re-sent. */
  async ambiguous(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
    code: string,
  ): Promise<void> {
    const caseRow = await lockCase(c, ctx.tenantId, item.case_id);
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "appointment_write_unconfirmed",
      payload: {
        execution_id: item.execution_id,
        operation: item.operation,
        code,
      },
    });
    // B is committed and A's cancellation is unknown: say so now.
    if (item.operation === "appointment.reschedule.cancel_original") {
      const row = await lockRequest(c, ctx.tenantId, item.case_id);
      await this.raise(c, ctx, caseRow, row, {
        kind: "CONNECTOR",
        reason: UNKNOWN_OUTCOME[item.operation]!,
      });
    }
  }

  /**
   * Read-back proved the effect absent. Only now may the step be retried: by
   * staff for a booking, hold or cancellation (the slot or intent may have
   * changed), automatically for a reschedule's cancellation of the original
   * (B exists, A must go; the same execution is re-sent).
   */
  async notCommitted(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
  ): Promise<void> {
    if (item.operation === "appointment.reschedule.cancel_original") {
      await c.query(
        `UPDATE executions SET status='PENDING',last_error='CONFIRMED_NOT_COMMITTED',next_reconcile_at=NULL,
                reconcile_lease_until=NULL,escalated_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [ctx.tenantId, item.execution_id],
      );
      await c.query(
        "UPDATE outbox SET status='PENDING',available_at=now(),lease_until=NULL WHERE tenant_id=$1 AND execution_id=$2",
        [ctx.tenantId, item.execution_id],
      );
      const caseRow = await lockCase(c, ctx.tenantId, item.case_id);
      await evidence(c, ctx, caseRow, caseSubject(caseRow), {
        eventType: "original_cancellation_retry",
        payload: { execution_id: item.execution_id, basis: "not_committed" },
      });
      return;
    }
    await c.query(
      `UPDATE executions SET status='PERMANENT',last_error='CONFIRMED_NOT_COMMITTED',next_reconcile_at=NULL,
              reconcile_lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
      [ctx.tenantId, item.execution_id],
    );
    const loaded = await this.load(c, ctx, item);
    if (!loaded) return;
    let { row, caseRow } = loaded;
    const failure = {
      pending_execution_id: null,
      last_failure_at: new Date(),
    };
    switch (item.operation) {
      case "appointment.hold":
        row = await updateRequest(c, row, {
          workflow_status: "SLOT_SELECTED",
          current_hold_id: null,
          last_failure_code: "HOLD_NOT_COMMITTED",
          ...failure,
        });
        break;
      case "appointment.create":
      case "appointment.reschedule":
        await cancelBlockedSteps(
          c,
          ctx.tenantId,
          row.case_id,
          "worker:booking_not_committed",
        );
        {
          const held = await this.usableHold(c, row);
          row = await updateRequest(c, row, {
            workflow_status: held ? "HELD" : "SLOT_SELECTED",
            current_hold_id: held ? row.current_hold_id : null,
            last_failure_code: "BOOKING_NOT_COMMITTED",
            ...failure,
          });
        }
        break;
      case "appointment.cancel":
        row = await updateRequest(c, row, {
          workflow_status: "CANCELLATION_REQUESTED",
          last_failure_code: "CANCELLATION_NOT_COMMITTED",
          ...failure,
        });
        break;
      default:
        return;
    }
    if (caseRow.current_state === "EXCEPTION")
      await resolveWorkItems(c, ctx, caseRow, {
        kinds: ["CONNECTOR"],
        resolution: "confirmed_not_committed",
        note: null,
        staffSeconds: undefined,
        automatic: true,
      });
    caseRow = await this.staffDecision(c, ctx, caseRow, "write_not_committed");
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "write_not_committed",
      payload: { execution_id: item.execution_id, operation: item.operation },
    });
  }

  /** Read-back gave up: a person must check the destination. */
  async escalated(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
    code: string,
  ): Promise<void> {
    const caseRow = await lockCase(c, ctx.tenantId, item.case_id);
    const row = await lockRequest(c, ctx.tenantId, item.case_id);
    await this.raise(c, { ...ctx, actor: WORKER_ACTOR }, caseRow, row, {
      kind: "CONNECTOR",
      reason: UNKNOWN_OUTCOME[item.operation] ?? `outcome_unknown:${code}`,
      details: { execution_id: item.execution_id, code },
    });
  }

  /** A stale or invalid step never reaches the destination. */
  async skipped(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
    code: string,
  ): Promise<void> {
    await c.query(
      "UPDATE executions SET status='PERMANENT',last_error=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, item.execution_id, code],
    );
    const caseRow = await lockCase(c, ctx.tenantId, item.case_id);
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "appointment_step_skipped",
      payload: {
        execution_id: item.execution_id,
        operation: item.operation,
        code,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  /**
   * Holds past their expiry become EXPIRED, except one being consumed by a
   * booking in flight (the destination decides that one). An EXPIRED hold can
   * never be consumed (0006 trigger).
   */
  async expireHolds(c: DbClient, tenantId: string): Promise<number> {
    const due = await c.query<{ id: string; case_id: string }>(
      `SELECT h.id,h.case_id FROM appointment_slot_holds h
         JOIN appointment_requests r ON r.tenant_id=h.tenant_id AND r.case_id=h.case_id
        WHERE h.tenant_id=$1 AND h.status='ACTIVE' AND h.expires_at<=now()
          AND NOT (r.workflow_status='BOOKING_SUBMITTED' AND r.current_hold_id=h.id)
        ORDER BY h.expires_at LIMIT 100`,
      [tenantId],
    );
    let expired = 0;
    for (const hold of due.rows) {
      const ctx = {
        tenantId,
        correlationId: hold.case_id,
        actor: WORKER_ACTOR,
      };
      const caseRow = await lockCase(c, tenantId, hold.case_id);
      let row = await lockRequest(c, tenantId, hold.case_id);
      const h = await findHold(c, tenantId, hold.id);
      if (!h || h.status !== "ACTIVE" || h.expires_at.getTime() > Date.now())
        continue;
      if (
        row.workflow_status === "BOOKING_SUBMITTED" &&
        row.current_hold_id === h.id
      )
        continue;
      await closeHold(c, tenantId, h.id, "EXPIRED");
      if (row.current_hold_id === h.id && row.workflow_status === "HELD")
        row = await updateRequest(c, row, {
          workflow_status: "SLOT_SELECTED",
          current_hold_id: null,
          last_failure_code: "HOLD_EXPIRED",
          last_failure_at: new Date(),
        });
      await evidence(c, ctx, caseRow, caseSubject(caseRow), {
        eventType: "hold_expired",
        payload: { hold_id: h.id, expires_at: h.expires_at.toISOString() },
      });
      expired++;
    }
    return expired;
  }

  /**
   * Planned steps whose executions staff superseded (after attesting the
   * previous step never happened) will never run: close them.
   */
  async closeSupersededSteps(c: DbClient, tenantId: string): Promise<number> {
    const closed = await c.query<{ execution_id: string }>(
      `UPDATE outbox o SET status='DONE',last_error='NOT_ATTEMPTED'
        WHERE o.tenant_id=$1 AND o.status='BLOCKED'
          AND EXISTS (SELECT 1 FROM executions e WHERE e.tenant_id=o.tenant_id AND e.id=o.execution_id AND e.superseded_at IS NOT NULL)
        RETURNING o.execution_id`,
      [tenantId],
    );
    const ids = closed.rows.map((r) => r.execution_id);
    if (ids.length)
      await c.query(
        "UPDATE executions SET status='PERMANENT',last_error='NOT_ATTEMPTED',updated_at=now() WHERE tenant_id=$1 AND id = ANY($2) AND status='PENDING'",
        [tenantId, ids],
      );
    return ids.length;
  }

  /**
   * Staff asked ACCESS to read the destination again after automated
   * checking stopped: re-arm the escalated execution's read-back.
   */
  async rearmRechecks(c: DbClient, tenantId: string): Promise<number> {
    const rearmed = await c.query<{ id: string; case_id: string }>(
      `UPDATE executions e SET status='AMBIGUOUS',escalated_at=NULL,reconcile_attempts=0,next_reconcile_at=now(),
              reconcile_lease_until=NULL,updated_at=now()
         FROM appointment_requests r
        WHERE e.tenant_id=$1 AND r.tenant_id=e.tenant_id AND r.pending_execution_id=e.id
          AND r.recheck_requested_at IS NOT NULL AND e.escalated_at IS NOT NULL AND e.superseded_at IS NULL
          AND r.recheck_requested_at > e.escalated_at
        RETURNING e.id, r.case_id`,
      [tenantId],
    );
    for (const x of rearmed.rows) {
      const row = await lockRequest(c, tenantId, x.case_id);
      await updateRequest(c, row, { recheck_requested_at: null });
    }
    return rearmed.rowCount ?? 0;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Lock the case and request; a result for an unexpected execution is ignored. */
  private async load(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
  ): Promise<{ caseRow: CaseRow; row: AppointmentRequestRow } | null> {
    const caseRow = await lockCase(c, ctx.tenantId, item.case_id);
    const row = await findRequest(c, ctx.tenantId, item.case_id, true);
    if (row && row.pending_execution_id === item.execution_id)
      return { caseRow, row };
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "appointment_result_ignored",
      payload: {
        execution_id: item.execution_id,
        operation: item.operation,
        reason: row ? "not_the_pending_execution" : "request_missing",
      },
    });
    log("warn", "appointment_result_ignored", {
      case_id: item.case_id,
      execution_id: item.execution_id,
      operation: item.operation,
    });
    return null;
  }

  private async recordAppointment(
    c: DbClient,
    ctx: Ctx,
    item: AppointmentItem,
    row: AppointmentRequestRow,
    commit: ReturnType<typeof appointmentCommitSchema.parse>,
    via: Via,
    replaces: string | null,
  ) {
    const existing = await appointmentByExecution(
      c,
      ctx.tenantId,
      item.execution_id,
    );
    const appointment =
      existing ??
      (await insertAppointment(c, {
        tenantId: ctx.tenantId,
        sourceCaseId: row.case_id,
        originReferralCaseId: row.origin_referral_case_id,
        destination: this.destination,
        externalReference: commit.appointment_reference,
        slotReference: commit.slot_reference,
        providerReference: commit.provider_reference,
        locationReference: commit.location_reference,
        serviceCode: row.booking_context.service_code,
        patientReference:
          commit.patient_reference ?? row.booking_context.patient_reference,
        startsAt: commit.start_at,
        endsAt: commit.end_at,
        timezone: commit.timezone,
        commitSource: via,
        createExecutionId: item.execution_id,
        replacesAppointmentId: replaces,
      }));
    if (row.current_hold_id)
      await closeHold(c, ctx.tenantId, row.current_hold_id, "CONSUMED");
    return appointment;
  }

  /** Back to a staff decision (READY_FOR_BOOKING) if an action was pending. */
  private async staffDecision(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    reason: string,
  ): Promise<CaseRow> {
    if (!["WAITING", "EXCEPTION", "RECEIVED"].includes(caseRow.current_state))
      return caseRow;
    return transitionCase(c, ctx, caseRow, {
      to: "READY_FOR_BOOKING",
      reason,
      owner: await this.owner(c, ctx.tenantId, caseRow, "CONNECTOR"),
    });
  }

  private async backToSelection(
    c: DbClient,
    row: AppointmentRequestRow,
    failure: { last_failure_code: string; last_failure_at: Date },
  ) {
    // The refused slot is gone from the choices; the rest stay (if fresh).
    const availability = row.availability
      ? {
          ...row.availability,
          slots: row.availability.slots.filter(
            (s) => s.slot_reference !== row.selected_slot_reference,
          ),
        }
      : null;
    return updateRequest(c, row, {
      workflow_status: "AVAILABILITY_RETURNED",
      availability,
      availability_observed_at: availability
        ? row.availability_observed_at
        : null,
      selected_slot: null,
      selected_slot_reference: null,
      selected_at: null,
      current_hold_id: null,
      pending_execution_id: null,
      ...failure,
    });
  }

  private async usableHold(c: DbClient, row: AppointmentRequestRow) {
    if (!row.current_hold_id) return false;
    const hold = await findHold(c, row.tenant_id, row.current_hold_id);
    return Boolean(
      hold && hold.status === "ACTIVE" && holdIsUsable(hold.expires_at),
    );
  }

  /** Human recovery: EXCEPTION and exactly one open work item of the kind. */
  async raise(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    row: AppointmentRequestRow,
    input: {
      kind: WorkItemKind;
      reason: string;
      details?: Record<string, unknown>;
      /** Record the work item but leave the case state as it is. */
      keepState?: boolean;
    },
  ): Promise<CaseRow> {
    let caseRow = caseRowIn;
    const owner = await this.owner(c, ctx.tenantId, caseRow, input.kind);
    if (
      !input.keepState &&
      caseRow.current_state !== "EXCEPTION" &&
      ["RECEIVED", "READY_FOR_BOOKING", "WAITING"].includes(
        caseRow.current_state,
      )
    )
      caseRow = await transitionCase(c, ctx, caseRow, {
        to: "EXCEPTION",
        reason: input.reason,
        owner,
        exceptionReason: input.reason,
        details: { workflow_status: row.workflow_status, ...input.details },
      });
    const details = {
      workflow_status: row.workflow_status,
      ...(input.details ?? {}),
    };
    const opened = await openWorkItem(c, ctx, caseRow, {
      kind: input.kind,
      reason: input.reason,
      ownerRole: owner,
      evidence: details,
    });
    // One open item per kind: it always says what is wrong now.
    if (!opened.created)
      await updateOpenWorkItemReason(
        c,
        ctx.tenantId,
        caseRow.id,
        input.kind,
        input.reason,
        details,
      );
    log("warn", "appointment_exception", {
      case_id: caseRow.id,
      code: input.reason,
      state: caseRow.current_state,
    });
    return caseRow;
  }

  private async owner(
    c: DbClient,
    tenantId: string,
    caseRow: CaseRow,
    kind: WorkItemKind,
  ) {
    // Only managers act on reschedules and cancellations.
    if (caseRow.case_type !== "APPOINTMENT_REQUEST") return "PRACTICE_MANAGER";
    const origin = await c.query<{ rule_set_id: string | null }>(
      `SELECT r.rule_set_id FROM appointment_requests a JOIN referrals r
         ON r.tenant_id=a.tenant_id AND r.case_id=a.origin_referral_case_id
        WHERE a.tenant_id=$1 AND a.case_id=$2`,
      [tenantId, caseRow.id],
    );
    const id = origin.rows[0]?.rule_set_id;
    return ownerFor(
      id ? (await loadRuleSet(c, tenantId, id)).definition : null,
      kind,
    );
  }
}
