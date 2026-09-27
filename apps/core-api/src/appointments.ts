import { randomUUID } from "node:crypto";
import {
  OPERATIONS,
  isAppointmentCaseType,
  type AppointmentAction,
  type AppointmentChange,
  type AppointmentSearch,
  type BookingContext,
  type CaseAction,
  type Operation,
  type StaffRole,
} from "@access/contracts";
import {
  AppError,
  bookingReadiness,
  caseExecutions,
  caseSubject,
  closeHold,
  completeReschedule,
  conflict,
  createCase,
  enqueueDestination,
  evidence,
  executionInFlight,
  executionUnresolved,
  findAppointment,
  findHold,
  findRequest,
  insertRequest,
  lockAppointment,
  lockCase,
  lockRequest,
  recordEffort,
  recordObservation,
  resolveWorkItems,
  transitionCase,
  updateAppointment,
  updateOpenWorkItemReason,
  updateRequest,
  type ActorRef,
  type AppointmentRequestRow,
  type AppointmentRow,
  type CaseRow,
  type DbClient,
  type HoldRow,
} from "@access/db";
import {
  DEFAULT_HOLD_TTL_SECONDS,
  availabilityIsFresh,
  holdIsUsable,
  workflowFinished,
  workflowStep,
} from "@access/domain";
import {
  appointmentPermission,
  assertCaseTypeEnabled,
  authorize,
  evaluateAppointmentOperation,
} from "@access/policy";

/**
 * Staff commands of appointment operations. The API validates, authorises,
 * evaluates policy and records outbox rows; the worker performs every
 * foreign effect. Nothing here talks to the destination, and no command can
 * book, cancel or replace an appointment by itself.
 */

type Ctx = { tenantId: string; correlationId: string; actor: ActorRef };
interface PendingExecution {
  id: string;
  operation: string;
  status: string;
  escalated_at: Date | null;
  superseded_at: Date | null;
}
type StepResult = {
  caseRow: CaseRow;
  row: AppointmentRequestRow;
  executionId?: string | null;
};

const inFlight = () =>
  conflict(
    "EXECUTION_IN_FLIGHT",
    "an automated destination action is still in progress",
  );
const outcomeUnknown = () =>
  conflict(
    "OUTCOME_UNKNOWN",
    "the destination has not confirmed whether the last write was committed; check again, or confirm it is absent, first",
  );
const consequential = (operation: string) =>
  Boolean(
    (OPERATIONS as Record<string, { consequential: boolean } | undefined>)[
      operation
    ]?.consequential,
  );

export class AppointmentOperations {
  // -------------------------------------------------------------------------
  // Start booking (a referral case action)
  // -------------------------------------------------------------------------

  /** Open an APPOINTMENT_REQUEST for an eligible referral (locked by the caller). */
  async startBooking(
    c: DbClient,
    ctx: Ctx,
    referral: CaseRow,
    action: Extract<CaseAction, { action: "start_booking" }>,
  ): Promise<{
    caseRow: CaseRow;
    executionId: string;
    appointmentCaseId: string;
  }> {
    const readiness = await bookingReadiness(c, ctx.tenantId, referral);
    if (!readiness.eligible || !readiness.context) {
      const reasons = readiness.eligible
        ? ["BOOKING_PREREQUISITES_UNMET:destination_reference"]
        : readiness.reasons;
      throw conflict(
        reasons.length === 1 && reasons[0] === "BOOKING_ALREADY_ACTIVE"
          ? "BOOKING_ALREADY_ACTIVE"
          : "BOOKING_NOT_ELIGIBLE",
        `booking cannot start: ${reasons.join(", ")}`,
      );
    }
    if (
      (await caseExecutions(c, ctx.tenantId, referral.id)).some(
        executionInFlight,
      )
    )
      throw inFlight();
    const opened = await this.openSearch(c, ctx, {
      caseType: "APPOINTMENT_REQUEST",
      originReferralCaseId: referral.id,
      originalAppointmentId: null,
      context: readiness.context,
      search: action.search,
    });
    // The referral now waits on the booking; its follow-up timer pauses.
    const observed = await recordObservation(c, ctx, referral, {
      type: "BOOKING_REQUESTED",
      occurredAt: new Date(),
      sourceType: "STAFF",
      sourceReference: `appointment_request:${opened.caseRow.id}`,
      verificationLevel: "HUMAN_ATTESTED",
      actorId: ctx.actor.id,
      payload: { appointment_case_id: opened.caseRow.id },
      authority: "STAFF",
    });
    await c.query(
      "UPDATE referrals SET follow_up_due_at=NULL,updated_at=now() WHERE tenant_id=$1 AND case_id=$2",
      [ctx.tenantId, referral.id],
    );
    await resolveWorkItems(c, ctx, observed.caseRow, {
      kinds: ["FOLLOW_UP"],
      resolution: "booking_started",
      note: null,
      staffSeconds: undefined,
      automatic: true,
    });
    await evidence(c, ctx, observed.caseRow, caseSubject(observed.caseRow), {
      eventType: "booking_started",
      payload: {
        appointment_case_id: opened.caseRow.id,
        execution_id: opened.executionId,
      },
    });
    return {
      caseRow: observed.caseRow,
      executionId: opened.executionId,
      appointmentCaseId: opened.caseRow.id,
    };
  }

  /** A new booking or reschedule request, searching from the start. */
  private async openSearch(
    c: DbClient,
    ctx: Ctx,
    input: {
      caseType: "APPOINTMENT_REQUEST" | "RESCHEDULING_REQUEST";
      originReferralCaseId: string | null;
      originalAppointmentId: string | null;
      context: BookingContext;
      search: AppointmentSearch;
    },
  ) {
    const caseId = randomUUID();
    let caseRow = await createCase(c, {
      ...ctx,
      caseId,
      caseType: input.caseType,
      channel: "API",
      subject: { type: "case", id: caseId },
    });
    await this.policy(c, ctx, caseRow, "appointment.availability.read");
    caseRow = await transitionCase(c, ctx, caseRow, {
      to: "WAITING",
      reason: "availability_requested",
      owner: "SYSTEM",
    });
    const executionId = await enqueueDestination(c, ctx, caseRow, {
      operation: "appointment.availability.read",
      subject: caseSubject(caseRow),
      payload: {
        schema_version: "appointment-availability-query.v1",
        context: input.context,
        search: input.search,
      },
    });
    const row = await insertRequest(c, {
      tenantId: ctx.tenantId,
      caseId,
      caseType: input.caseType,
      originReferralCaseId: input.originReferralCaseId,
      originalAppointmentId: input.originalAppointmentId,
      bookingContext: input.context,
      search: input.search,
      timezone: input.search.timezone,
      workflowStatus: "AVAILABILITY_REQUESTED",
      pendingExecutionId: executionId,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "appointment_request_opened",
      payload: {
        case_type: input.caseType,
        origin_referral_case_id: input.originReferralCaseId,
        original_appointment_id: input.originalAppointmentId,
        search_from: input.search.from,
        search_to: input.search.to,
        timezone: input.search.timezone,
      },
    });
    return { caseRow, row, executionId };
  }

  // -------------------------------------------------------------------------
  // Booking sub-flow steps on an appointment operations case
  // -------------------------------------------------------------------------

  async act(
    c: DbClient,
    ctx: Ctx,
    role: StaffRole,
    caseId: string,
    action: AppointmentAction,
  ) {
    const locked = await lockCase(c, ctx.tenantId, caseId);
    // Disabled case types fail closed before anything else is considered.
    assertCaseTypeEnabled(locked.case_type);
    if (!isAppointmentCaseType(locked.case_type))
      throw new AppError(
        422,
        "APPOINTMENT_CASES_ONLY",
        "appointment actions apply to appointment, rescheduling and cancellation requests",
      );
    authorize(role, appointmentPermission(locked.case_type));
    const current = await lockRequest(c, ctx.tenantId, caseId);
    if (current.version !== action.expected_version)
      throw conflict(
        "VERSION_CONFLICT",
        `appointment request version is ${current.version}, expected ${action.expected_version}`,
      );
    if (workflowFinished(current.workflow_status))
      throw conflict(
        "REQUEST_FINISHED",
        `the request is already ${current.workflow_status.toLowerCase()}`,
      );
    const pending = await this.pending(c, ctx.tenantId, current);
    let out: StepResult;
    switch (action.action) {
      case "search":
        out = await this.search(c, ctx, locked, current, pending, action);
        break;
      case "select":
        out = await this.select(c, ctx, locked, current, pending, action);
        break;
      case "hold":
        out = await this.hold(c, ctx, locked, current, pending, action);
        break;
      case "commit":
        out = await this.commit(c, ctx, locked, current, pending, action);
        break;
      case "withdraw":
        out = await this.withdraw(c, ctx, locked, current, pending, action);
        break;
      case "recheck":
        out = await this.recheck(c, ctx, locked, current, pending, action);
        break;
      case "attest_not_committed":
        out = await this.attestNotCommitted(
          c,
          ctx,
          locked,
          current,
          pending,
          action,
        );
        break;
      case "attest_original_cancelled":
        out = await this.attestOriginalCancelled(
          c,
          ctx,
          locked,
          current,
          pending,
          action,
        );
        break;
    }
    await evidence(c, ctx, out.caseRow, caseSubject(out.caseRow), {
      eventType: "staff_action_recorded",
      payload: {
        action: `appointment.${action.action}`,
        note: action.note ?? null,
        staff_seconds: action.staff_seconds ?? null,
        command_id: action.command_id,
      },
    });
    return {
      case_id: caseId,
      action: action.action,
      state: out.caseRow.current_state,
      case_version: out.caseRow.version,
      workflow_status: out.row.workflow_status,
      version: out.row.version,
      execution_id: out.executionId ?? null,
    };
  }

  private async search(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "search" }>,
  ): Promise<StepResult> {
    workflowStep(
      rowIn.case_type,
      rowIn.workflow_status,
      "AVAILABILITY_REQUESTED",
    );
    this.assertSettled(pending);
    const search = action.search ?? rowIn.search;
    if (!search)
      throw new AppError(422, "SEARCH_REQUIRED", "a search window is required");
    await this.releaseHold(c, ctx, caseRowIn, rowIn);
    await this.policy(c, ctx, caseRowIn, "appointment.availability.read");
    const caseRow = await this.resume(c, ctx, caseRowIn, action, {
      to: "WAITING",
      reason: "availability_requested",
    });
    const executionId = await enqueueDestination(c, ctx, caseRow, {
      operation: "appointment.availability.read",
      subject: caseSubject(caseRow),
      payload: {
        schema_version: "appointment-availability-query.v1",
        context: rowIn.booking_context,
        search,
      },
    });
    const row = await updateRequest(c, rowIn, {
      workflow_status: "AVAILABILITY_REQUESTED",
      search,
      selected_slot: null,
      selected_slot_reference: null,
      selected_at: null,
      current_hold_id: null,
      pending_execution_id: executionId,
      last_failure_code: null,
      last_failure_at: null,
      recheck_requested_at: null,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "availability_requested",
      payload: {
        execution_id: executionId,
        search_from: search.from,
        search_to: search.to,
        timezone: search.timezone,
      },
    });
    return { caseRow, row, executionId };
  }

  private async select(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "select" }>,
  ): Promise<StepResult> {
    workflowStep(rowIn.case_type, rowIn.workflow_status, "SLOT_SELECTED");
    this.assertSettled(pending);
    this.assertFresh(rowIn);
    const slot = rowIn.availability?.slots.find(
      (s) => s.slot_reference === action.slot_reference,
    );
    if (!slot)
      throw conflict(
        "SLOT_NOT_OFFERED",
        "that slot is not in the current availability",
      );
    this.assertFuture(slot.start_at);
    if (
      rowIn.workflow_status === "HELD" &&
      rowIn.selected_slot_reference === slot.slot_reference
    )
      throw conflict(
        "SLOT_ALREADY_HELD",
        "that slot is already held for this request",
      );
    await this.releaseHold(c, ctx, caseRowIn, rowIn);
    const caseRow = await this.resume(c, ctx, caseRowIn, action, {
      to: "READY_FOR_BOOKING",
      reason: "slot_selected",
    });
    const row = await updateRequest(c, rowIn, {
      workflow_status: "SLOT_SELECTED",
      selected_slot: slot,
      selected_slot_reference: slot.slot_reference,
      selected_at: new Date(),
      current_hold_id: null,
      last_failure_code: null,
      last_failure_at: null,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "slot_selected",
      payload: {
        slot_reference: slot.slot_reference,
        start_at: slot.start_at,
        timezone: slot.timezone,
        hold_supported: slot.hold_supported,
      },
    });
    return { caseRow, row };
  }

  private async hold(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "hold" }>,
  ): Promise<StepResult> {
    workflowStep(rowIn.case_type, rowIn.workflow_status, "HOLD_REQUESTED");
    this.assertSettled(pending);
    const slot = rowIn.selected_slot!;
    if (!slot.hold_supported)
      throw conflict(
        "HOLD_NOT_SUPPORTED",
        "the destination cannot hold this slot; book it directly",
      );
    this.assertFresh(rowIn);
    this.assertFuture(slot.start_at);
    await this.policy(c, ctx, caseRowIn, "appointment.hold");
    const caseRow = await this.resume(c, ctx, caseRowIn, action, {
      to: "WAITING",
      reason: "hold_requested",
    });
    const executionId = await enqueueDestination(c, ctx, caseRow, {
      operation: "appointment.hold",
      subject: caseSubject(caseRow),
      payload: {
        schema_version: "appointment-hold-request.v1",
        context: rowIn.booking_context,
        slot,
        ttl_seconds: DEFAULT_HOLD_TTL_SECONDS,
      },
    });
    const row = await updateRequest(c, rowIn, {
      workflow_status: "HOLD_REQUESTED",
      pending_execution_id: executionId,
      last_failure_code: null,
      last_failure_at: null,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "hold_requested",
      payload: {
        execution_id: executionId,
        slot_reference: slot.slot_reference,
      },
    });
    return { caseRow, row, executionId };
  }

  private async commit(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    row: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "commit" }>,
  ): Promise<StepResult> {
    switch (row.case_type) {
      case "APPOINTMENT_REQUEST":
        return this.submitBooking(c, ctx, caseRow, row, pending, action);
      case "RESCHEDULING_REQUEST":
        return row.workflow_status === "ORIGINAL_CANCELLATION_PENDING"
          ? this.resubmitOriginalCancellation(
              c,
              ctx,
              caseRow,
              row,
              pending,
              action,
            )
          : this.submitReplacement(c, ctx, caseRow, row, pending, action);
      case "CANCELLATION_REQUEST":
        return this.submitCancellation(c, ctx, caseRow, row, pending, action);
    }
  }

  /** Book the selected slot: one command, one policy decision, one write. */
  private async submitBooking(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "commit" }>,
  ): Promise<StepResult> {
    workflowStep(rowIn.case_type, rowIn.workflow_status, "BOOKING_SUBMITTED");
    this.assertSettled(pending);
    // The referral must still be bookable when the booking is submitted.
    const referral = await lockCase(
      c,
      ctx.tenantId,
      rowIn.origin_referral_case_id!,
    );
    const readiness = await bookingReadiness(c, ctx.tenantId, referral, {
      ignoreActiveRequest: true,
    });
    if (!readiness.eligible)
      throw conflict(
        "BOOKING_NOT_ELIGIBLE",
        `the referral can no longer be booked: ${readiness.reasons.join(", ")}`,
      );
    const hold = await this.submittableHold(c, rowIn);
    const slot = rowIn.selected_slot!;
    this.assertFuture(slot.start_at);
    for (const operation of [
      "appointment.create",
      "appointment.verify",
    ] as const)
      await this.policy(c, ctx, caseRowIn, operation);
    const caseRow = await this.resume(c, ctx, caseRowIn, action, {
      to: "WAITING",
      reason: "booking_submitted",
    });
    const executionId = await enqueueDestination(c, ctx, caseRow, {
      operation: "appointment.create",
      subject: caseSubject(caseRow),
      payload: {
        schema_version: "appointment-booking-request.v1",
        context: rowIn.booking_context,
        slot,
        hold_reference: hold?.hold_reference ?? null,
        replaces_appointment_reference: null,
      },
    });
    // BOOKED only after the committed appointment is read back.
    const verify = await this.planVerify(c, ctx, caseRow, executionId);
    const row = await updateRequest(c, rowIn, {
      workflow_status: "BOOKING_SUBMITTED",
      pending_execution_id: executionId,
      last_failure_code: null,
      last_failure_at: null,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "booking_submitted",
      payload: {
        execution_id: executionId,
        verify_execution_id: verify,
        slot_reference: slot.slot_reference,
        hold_id: hold?.id ?? null,
      },
    });
    return { caseRow, row, executionId };
  }

  /**
   * Reschedule: commit B, then read B back, then cancel A. All three steps
   * are authorised by this one command; the later two stay BLOCKED until
   * the worker has verified the step before. A is never touched first.
   */
  private async submitReplacement(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "commit" }>,
  ): Promise<StepResult> {
    workflowStep(rowIn.case_type, rowIn.workflow_status, "BOOKING_SUBMITTED");
    this.assertSettled(pending);
    const original = await lockAppointment(
      c,
      ctx.tenantId,
      rowIn.original_appointment_id!,
    );
    if (original.status !== "BOOKED")
      throw conflict(
        "ORIGINAL_NOT_BOOKED",
        "the appointment being rescheduled is no longer booked",
      );
    await this.assertNoSafetyHold(
      c,
      ctx.tenantId,
      rowIn.origin_referral_case_id,
    );
    const hold = await this.submittableHold(c, rowIn);
    const slot = rowIn.selected_slot!;
    this.assertFuture(slot.start_at);
    for (const operation of [
      "appointment.reschedule",
      "appointment.verify",
      "appointment.reschedule.cancel_original",
    ] as const)
      await this.policy(c, ctx, caseRowIn, operation);
    const caseRow = await this.resume(c, ctx, caseRowIn, action, {
      to: "WAITING",
      reason: "replacement_submitted",
    });
    const executionId = await enqueueDestination(c, ctx, caseRow, {
      operation: "appointment.reschedule",
      subject: caseSubject(caseRow),
      payload: {
        schema_version: "appointment-booking-request.v1",
        context: rowIn.booking_context,
        slot,
        hold_reference: hold?.hold_reference ?? null,
        replaces_appointment_reference: original.external_reference,
      },
    });
    const planned = {
      verify: await this.planVerify(c, ctx, caseRow, executionId),
      cancel: await this.planOriginalCancellation(c, ctx, caseRow, original),
    };
    const row = await updateRequest(c, rowIn, {
      workflow_status: "BOOKING_SUBMITTED",
      pending_execution_id: executionId,
      last_failure_code: null,
      last_failure_at: null,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "replacement_submitted",
      payload: {
        execution_id: executionId,
        verify_execution_id: planned.verify,
        cancel_original_execution_id: planned.cancel,
        original_appointment_id: original.id,
        slot_reference: slot.slot_reference,
        hold_id: hold?.id ?? null,
      },
    });
    return { caseRow, row, executionId };
  }

  /**
   * Read back the appointment committed by an execution. Planned BLOCKED
   * behind the commit; PENDING when staff ask for the check again.
   */
  private planVerify(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    commitExecutionId: string,
    status: "PENDING" | "BLOCKED" = "BLOCKED",
  ) {
    return enqueueDestination(c, ctx, caseRow, {
      operation: "appointment.verify",
      subject: caseSubject(caseRow),
      // Bound at dispatch to the appointment this execution committed.
      payload: { commit_execution_id: commitExecutionId },
      status,
    });
  }
  /** A reschedule's last step: cancel A, released only after B is verified. */
  private planOriginalCancellation(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    original: AppointmentRow,
  ) {
    return enqueueDestination(c, ctx, caseRow, {
      operation: "appointment.reschedule.cancel_original",
      subject: caseSubject(caseRow),
      payload: {
        schema_version: "appointment-cancellation-request.v1",
        appointment_reference: original.external_reference,
        reason: "RESCHEDULED",
        replaced_by_reference: null,
      },
      status: "BLOCKED",
    });
  }

  /** B is booked and verified; A's cancellation was refused or is absent. */
  private async resubmitOriginalCancellation(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "commit" }>,
  ): Promise<StepResult> {
    this.assertSettled(pending);
    const original = await lockAppointment(
      c,
      ctx.tenantId,
      rowIn.original_appointment_id!,
    );
    if (original.status !== "BOOKED")
      throw conflict(
        "ORIGINAL_NOT_BOOKED",
        "the original appointment is no longer booked; attest its cancellation instead",
      );
    const replacement = await findAppointment(
      c,
      ctx.tenantId,
      rowIn.appointment_id!,
    );
    await this.policy(
      c,
      ctx,
      caseRowIn,
      "appointment.reschedule.cancel_original",
    );
    const caseRow = await this.resume(c, ctx, caseRowIn, action, {
      to: "WAITING",
      reason: "original_cancellation_resubmitted",
    });
    const executionId = await enqueueDestination(c, ctx, caseRow, {
      operation: "appointment.reschedule.cancel_original",
      subject: caseSubject(caseRow),
      payload: {
        schema_version: "appointment-cancellation-request.v1",
        appointment_reference: original.external_reference,
        reason: "RESCHEDULED",
        replaced_by_reference: replacement?.external_reference ?? null,
      },
    });
    const row = await updateRequest(c, rowIn, {
      pending_execution_id: executionId,
      last_failure_code: null,
      last_failure_at: null,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "original_cancellation_resubmitted",
      payload: {
        execution_id: executionId,
        original_appointment_id: original.id,
      },
    });
    return { caseRow, row, executionId };
  }

  private async submitCancellation(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "commit" }>,
  ): Promise<StepResult> {
    workflowStep(
      rowIn.case_type,
      rowIn.workflow_status,
      "CANCELLATION_SUBMITTED",
    );
    this.assertSettled(pending);
    const appointment = await lockAppointment(
      c,
      ctx.tenantId,
      rowIn.original_appointment_id!,
    );
    if (appointment.status !== "BOOKED")
      throw conflict(
        "APPOINTMENT_NOT_BOOKED",
        "the appointment is no longer booked",
      );
    await this.policy(c, ctx, caseRowIn, "appointment.cancel");
    const caseRow = await this.resume(c, ctx, caseRowIn, action, {
      to: "WAITING",
      reason: "cancellation_submitted",
    });
    const executionId = await enqueueDestination(c, ctx, caseRow, {
      operation: "appointment.cancel",
      subject: caseSubject(caseRow),
      payload: {
        schema_version: "appointment-cancellation-request.v1",
        appointment_reference: appointment.external_reference,
        reason: rowIn.cancellation_reason!,
        replaced_by_reference: null,
      },
    });
    const row = await updateRequest(c, rowIn, {
      workflow_status: "CANCELLATION_SUBMITTED",
      pending_execution_id: executionId,
      last_failure_code: null,
      last_failure_at: null,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "cancellation_submitted",
      payload: { execution_id: executionId, appointment_id: appointment.id },
    });
    return { caseRow, row, executionId };
  }

  private async withdraw(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "withdraw" }>,
  ): Promise<StepResult> {
    workflowStep(rowIn.case_type, rowIn.workflow_status, "WITHDRAWN");
    // A search still running may be abandoned; a write may not.
    if (
      pending &&
      executionUnresolved(pending) &&
      consequential(pending.operation)
    )
      throw executionInFlight(pending) ? inFlight() : outcomeUnknown();
    await this.releaseHold(c, ctx, caseRowIn, rowIn);
    const row = await updateRequest(c, rowIn, {
      workflow_status: "WITHDRAWN",
      pending_execution_id: null,
    });
    await resolveWorkItems(c, ctx, caseRowIn, {
      resolution: "request_withdrawn",
      note: action.note,
      staffSeconds: action.staff_seconds,
    });
    const caseRow = await transitionCase(c, ctx, caseRowIn, {
      to: "CLOSED",
      reason: "request_withdrawn",
      resolution: {
        code: "WITHDRAWN",
        outcomeAt: new Date(),
        source: "STAFF",
        actorId: ctx.actor.id,
        reference: action.command_id,
      },
    });
    if (row.origin_referral_case_id) {
      let referral = await lockCase(
        c,
        ctx.tenantId,
        row.origin_referral_case_id,
      );
      if (row.case_type === "APPOINTMENT_REQUEST") {
        // Back to booking by hand or a new search; follow-up resumes.
        if (referral.current_state === "WAITING")
          referral = await transitionCase(c, ctx, referral, {
            to: "READY_FOR_BOOKING",
            reason: "booking_withdrawn",
            owner: "REFERRAL_COORDINATOR",
          });
        const readiness = await bookingReadiness(c, ctx.tenantId, referral, {
          ignoreActiveRequest: true,
        });
        await c.query(
          "UPDATE referrals SET follow_up_due_at=now()+($3||' hours')::interval,updated_at=now() WHERE tenant_id=$1 AND case_id=$2 AND follow_up_due_at IS NULL",
          [ctx.tenantId, referral.id, readiness.readyForBookingHours],
        );
      }
      await evidence(c, ctx, referral, caseSubject(referral), {
        eventType:
          row.case_type === "APPOINTMENT_REQUEST"
            ? "booking_withdrawn"
            : "appointment_change_withdrawn",
        payload: { appointment_case_id: row.case_id, case_type: row.case_type },
      });
    }
    return { caseRow, row };
  }

  private async recheck(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "recheck" }>,
  ): Promise<StepResult> {
    // An unconfirmed write: the worker reads the destination again.
    if (
      pending?.status === "AMBIGUOUS" &&
      pending.escalated_at &&
      !pending.superseded_at
    ) {
      const row = await updateRequest(c, rowIn, {
        recheck_requested_at: new Date(),
      });
      const caseRow = await this.resume(c, ctx, caseRowIn, action, {
        to: "WAITING",
        reason: "recheck_requested",
      });
      await evidence(c, ctx, caseRow, caseSubject(caseRow), {
        eventType: "recheck_requested",
        payload: { execution_id: pending.id, operation: pending.operation },
      });
      return { caseRow, row };
    }
    // A commit the destination did not confirm on read-back: read it back
    // again (a read); a reschedule plans the original's cancellation behind it.
    if (
      (rowIn.workflow_status === "COMMITTED" ||
        rowIn.workflow_status === "REPLACEMENT_BOOKED") &&
      !(pending && executionUnresolved(pending))
    ) {
      const committed = (await findAppointment(
        c,
        ctx.tenantId,
        rowIn.appointment_id!,
      ))!;
      const reschedule = rowIn.case_type === "RESCHEDULING_REQUEST";
      const original = reschedule
        ? await lockAppointment(c, ctx.tenantId, rowIn.original_appointment_id!)
        : undefined;
      await this.policy(c, ctx, caseRowIn, "appointment.verify");
      if (reschedule)
        await this.policy(
          c,
          ctx,
          caseRowIn,
          "appointment.reschedule.cancel_original",
        );
      const caseRow = await this.resume(c, ctx, caseRowIn, action, {
        to: "WAITING",
        reason: "verification_recheck",
      });
      const verify = await this.planVerify(
        c,
        ctx,
        caseRow,
        committed.create_execution_id,
        "PENDING",
      );
      const cancel = original
        ? await this.planOriginalCancellation(c, ctx, caseRow, original)
        : null;
      const row = await updateRequest(c, rowIn, {
        pending_execution_id: verify,
        last_failure_code: null,
        last_failure_at: null,
      });
      await evidence(c, ctx, caseRow, caseSubject(caseRow), {
        eventType: "verification_recheck_requested",
        payload: {
          verify_execution_id: verify,
          cancel_original_execution_id: cancel,
          appointment_id: committed.id,
        },
      });
      return { caseRow, row, executionId: verify };
    }
    if (pending && executionInFlight(pending)) throw inFlight();
    throw conflict(
      "NOTHING_TO_RECHECK",
      "there is no unconfirmed destination result to check again",
    );
  }

  /**
   * Staff checked the destination: the write ACCESS could not confirm is not
   * there. The execution is superseded (never re-sent) and the step returns
   * to a state from which staff decide again.
   */
  private async attestNotCommitted(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "attest_not_committed" }>,
  ): Promise<StepResult> {
    if (
      !pending ||
      pending.status !== "AMBIGUOUS" ||
      !pending.escalated_at ||
      pending.superseded_at
    )
      throw conflict(
        "ATTESTATION_NOT_APPLICABLE",
        "only a write whose outcome ACCESS could not confirm can be attested",
      );
    await c.query(
      "UPDATE executions SET superseded_at=now(),superseded_by=$3,superseded_reason='staff_attested_not_committed' WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, pending.id, ctx.actor.id],
    );
    // Planned later steps never run; the worker closes their outbox rows.
    await c.query(
      `UPDATE executions e SET superseded_at=now(),superseded_by=$3,superseded_reason='plan_cancelled'
         FROM outbox o
        WHERE e.tenant_id=$1 AND o.tenant_id=e.tenant_id AND o.execution_id=e.id AND o.case_id=$2
          AND o.status='BLOCKED' AND e.superseded_at IS NULL`,
      [ctx.tenantId, rowIn.case_id, ctx.actor.id],
    );
    const failedAt = new Date();
    let row: AppointmentRequestRow;
    switch (pending.operation) {
      case "appointment.hold":
        row = await updateRequest(c, rowIn, {
          workflow_status: "SLOT_SELECTED",
          current_hold_id: null,
          pending_execution_id: null,
          last_failure_code: "ATTESTED_NOT_COMMITTED",
          last_failure_at: failedAt,
        });
        break;
      case "appointment.create":
      case "appointment.reschedule": {
        const held = await this.usableHold(c, rowIn);
        row = await updateRequest(c, rowIn, {
          workflow_status: held ? "HELD" : "SLOT_SELECTED",
          current_hold_id: held ? rowIn.current_hold_id : null,
          pending_execution_id: null,
          last_failure_code: "ATTESTED_NOT_COMMITTED",
          last_failure_at: failedAt,
        });
        break;
      }
      case "appointment.cancel":
        row = await updateRequest(c, rowIn, {
          workflow_status: "CANCELLATION_REQUESTED",
          pending_execution_id: null,
          last_failure_code: "ATTESTED_NOT_COMMITTED",
          last_failure_at: failedAt,
        });
        break;
      case "appointment.reschedule.cancel_original":
        row = await updateRequest(c, rowIn, {
          pending_execution_id: null,
          last_failure_code: "ORIGINAL_CANCELLATION_NOT_COMMITTED",
          last_failure_at: failedAt,
        });
        break;
      default:
        throw conflict(
          "ATTESTATION_NOT_APPLICABLE",
          "this step cannot be attested",
        );
    }
    let caseRow = caseRowIn;
    if (pending.operation === "appointment.reschedule.cancel_original") {
      // B is booked and A is still there: the exception stays until A goes.
      await updateOpenWorkItemReason(
        c,
        ctx.tenantId,
        caseRow.id,
        "CONNECTOR",
        "original_not_cancelled:both_appointments_exist",
        { workflow_status: row.workflow_status, execution_id: pending.id },
      );
    } else
      caseRow = await this.resume(c, ctx, caseRowIn, action, {
        to: "READY_FOR_BOOKING",
        reason: "staff_attested_not_committed",
      });
    await recordEffort(c, ctx, caseRow.id, {
      type: "MANUAL_DESTINATION_ACTION",
      source: "STAFF",
      seconds: action.staff_seconds,
      commandId: action.command_id,
    });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "staff_attested_not_committed",
      payload: { execution_id: pending.id, operation: pending.operation },
    });
    return { caseRow, row };
  }

  /**
   * Reschedule only: a manager checked the destination and A is cancelled
   * there (for instance, cancelled by hand). Completes the reschedule.
   */
  private async attestOriginalCancelled(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    rowIn: AppointmentRequestRow,
    pending: PendingExecution | undefined,
    action: Extract<AppointmentAction, { action: "attest_original_cancelled" }>,
  ): Promise<StepResult> {
    if (
      rowIn.case_type !== "RESCHEDULING_REQUEST" ||
      rowIn.workflow_status !== "ORIGINAL_CANCELLATION_PENDING"
    )
      throw conflict(
        "ATTESTATION_NOT_APPLICABLE",
        "only a reschedule waiting on the original's cancellation can be attested",
      );
    if (pending && executionInFlight(pending)) throw inFlight();
    if (pending && executionUnresolved(pending))
      await c.query(
        "UPDATE executions SET superseded_at=now(),superseded_by=$3,superseded_reason='staff_attested_original_cancelled' WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, pending.id, ctx.actor.id],
      );
    const original = await lockAppointment(
      c,
      ctx.tenantId,
      rowIn.original_appointment_id!,
    );
    if (original.status === "BOOKED")
      await updateAppointment(c, original, {
        status: "SUPERSEDED",
        cancelled_at: new Date(),
        cancellation_source: "STAFF",
        superseded_by_id: rowIn.appointment_id,
      });
    const row = await updateRequest(c, rowIn, {
      workflow_status: "COMPLETED",
      pending_execution_id: null,
      last_failure_code: null,
      last_failure_at: null,
    });
    await recordEffort(c, ctx, caseRowIn.id, {
      type: "MANUAL_DESTINATION_ACTION",
      source: "STAFF",
      seconds: action.staff_seconds,
      commandId: action.command_id,
    });
    const caseRow = await completeReschedule(c, ctx, caseRowIn, row, "STAFF", {
      attested_by: ctx.actor.id,
      command_id: action.command_id,
    });
    return { caseRow, row };
  }

  // -------------------------------------------------------------------------
  // Changes to a committed appointment
  // -------------------------------------------------------------------------

  async change(
    c: DbClient,
    ctx: Ctx,
    role: StaffRole,
    appointmentId: string,
    change: AppointmentChange,
  ) {
    authorize(
      role,
      change.action === "confirm"
        ? "appointment.confirm"
        : change.action === "reschedule"
          ? "appointment.reschedule"
          : "appointment.cancel",
    );
    const appointment = await lockAppointment(c, ctx.tenantId, appointmentId);
    if (appointment.version !== change.expected_version)
      throw conflict(
        "VERSION_CONFLICT",
        `appointment version is ${appointment.version}, expected ${change.expected_version}`,
      );
    if (appointment.status !== "BOOKED")
      throw conflict(
        "APPOINTMENT_NOT_BOOKED",
        `the appointment is ${appointment.status.toLowerCase()}`,
      );
    switch (change.action) {
      case "confirm":
        return this.confirm(c, ctx, appointment, change);
      case "reschedule":
      case "cancel":
        return this.openChange(c, ctx, appointment, change);
    }
  }

  /** Staff attest that the patient confirmed. "Booked" is not "confirmed". */
  private async confirm(
    c: DbClient,
    ctx: Ctx,
    appointmentIn: AppointmentRow,
    change: Extract<AppointmentChange, { action: "confirm" }>,
  ) {
    if (appointmentIn.confirmation_status === "CONFIRMED")
      throw conflict(
        "ALREADY_CONFIRMED",
        "the appointment is already confirmed",
      );
    const appointment = await updateAppointment(c, appointmentIn, {
      confirmation_status: "CONFIRMED",
      confirmed_at: new Date(),
      confirmation_source: "STAFF",
      confirmation_method: change.method,
      confirmed_by: ctx.actor.id,
    });
    const payload = {
      appointment_id: appointment.id,
      method: change.method,
      note: change.note ?? null,
      command_id: change.command_id,
    };
    const source = await lockCase(c, ctx.tenantId, appointment.source_case_id);
    await evidence(c, ctx, source, caseSubject(source), {
      eventType: "appointment_confirmed",
      payload,
    });
    if (appointment.origin_referral_case_id) {
      const referral = await lockCase(
        c,
        ctx.tenantId,
        appointment.origin_referral_case_id,
      );
      await evidence(c, ctx, referral, caseSubject(referral), {
        eventType: "appointment_confirmed",
        payload,
      });
      // Confirming is a contact with the patient about their referral.
      await recordEffort(c, ctx, referral.id, {
        type: "STATUS_CONTACT",
        source: "STAFF",
        commandId: change.command_id,
      });
    }
    return {
      appointment_id: appointment.id,
      action: change.action,
      version: appointment.version,
      confirmation_status: appointment.confirmation_status,
      case_id: null,
      request_version: null,
    };
  }

  /** Reschedule or cancellation: a new request case against this appointment. */
  private async openChange(
    c: DbClient,
    ctx: Ctx,
    appointment: AppointmentRow,
    change: Extract<AppointmentChange, { action: "reschedule" | "cancel" }>,
  ) {
    if (appointment.starts_at.getTime() <= Date.now())
      throw conflict(
        "APPOINTMENT_STARTED",
        "the appointment has already started",
      );
    const source = await findRequest(
      c,
      ctx.tenantId,
      appointment.source_case_id,
    );
    if (!source)
      throw conflict(
        "BOOKING_CONTEXT_MISSING",
        "the booking that created this appointment is not recorded",
      );
    await this.assertNoSafetyHold(
      c,
      ctx.tenantId,
      appointment.origin_referral_case_id,
    );
    let caseRow: CaseRow;
    let row: AppointmentRequestRow;
    let executionId: string | null = null;
    if (change.action === "reschedule") {
      const opened = await this.openSearch(c, ctx, {
        caseType: "RESCHEDULING_REQUEST",
        originReferralCaseId: appointment.origin_referral_case_id,
        originalAppointmentId: appointment.id,
        context: source.booking_context,
        search: change.search,
      });
      ({ caseRow, row, executionId } = opened);
    } else {
      const caseId = randomUUID();
      caseRow = await createCase(c, {
        ...ctx,
        caseId,
        caseType: "CANCELLATION_REQUEST",
        channel: "API",
        subject: { type: "case", id: caseId },
      });
      // Nothing is sent yet: the cancellation is committed separately.
      caseRow = await transitionCase(c, ctx, caseRow, {
        to: "READY_FOR_BOOKING",
        reason: "cancellation_requested",
        owner: "PRACTICE_MANAGER",
      });
      row = await insertRequest(c, {
        tenantId: ctx.tenantId,
        caseId,
        caseType: "CANCELLATION_REQUEST",
        originReferralCaseId: appointment.origin_referral_case_id,
        originalAppointmentId: appointment.id,
        bookingContext: source.booking_context,
        search: null,
        timezone: appointment.timezone,
        workflowStatus: "CANCELLATION_REQUESTED",
        pendingExecutionId: null,
        cancellationReason: change.reason,
      });
      await evidence(c, ctx, caseRow, caseSubject(caseRow), {
        eventType: "appointment_request_opened",
        payload: {
          case_type: "CANCELLATION_REQUEST",
          origin_referral_case_id: appointment.origin_referral_case_id,
          original_appointment_id: appointment.id,
          reason: change.reason,
        },
      });
    }
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "staff_action_recorded",
      payload: {
        action: `appointment.${change.action}`,
        note: change.note,
        staff_seconds: null,
        command_id: change.command_id,
      },
    });
    const startedPayload = {
      appointment_id: appointment.id,
      change_case_id: caseRow.id,
      case_type: caseRow.case_type,
    };
    const sourceCase = await lockCase(
      c,
      ctx.tenantId,
      appointment.source_case_id,
    );
    await evidence(c, ctx, sourceCase, caseSubject(sourceCase), {
      eventType: "appointment_change_started",
      payload: startedPayload,
    });
    if (appointment.origin_referral_case_id) {
      const referral = await lockCase(
        c,
        ctx.tenantId,
        appointment.origin_referral_case_id,
      );
      await evidence(c, ctx, referral, caseSubject(referral), {
        eventType: "appointment_change_started",
        payload: startedPayload,
      });
    }
    return {
      appointment_id: appointment.id,
      action: change.action,
      version: appointment.version,
      confirmation_status: appointment.confirmation_status,
      case_id: caseRow.id,
      request_version: row.version,
      execution_id: executionId,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async pending(
    c: DbClient,
    tenantId: string,
    row: AppointmentRequestRow,
  ): Promise<PendingExecution | undefined> {
    if (!row.pending_execution_id) return undefined;
    const found = await c.query<PendingExecution>(
      "SELECT id,operation,status,escalated_at,superseded_at FROM executions WHERE tenant_id=$1 AND id=$2",
      [tenantId, row.pending_execution_id],
    );
    return found.rows[0];
  }
  /** No new step while the previous one is running or its outcome unknown. */
  private assertSettled(pending: PendingExecution | undefined) {
    if (!pending) return;
    if (executionInFlight(pending)) throw inFlight();
    if (executionUnresolved(pending)) throw outcomeUnknown();
  }
  private assertFresh(row: AppointmentRequestRow) {
    if (!availabilityIsFresh(row.availability_observed_at))
      throw conflict(
        "AVAILABILITY_STALE",
        "availability is more than 10 minutes old: search again",
      );
  }
  private assertFuture(startAt: string) {
    if (Date.parse(startAt) <= Date.now())
      throw conflict("SLOT_IN_PAST", "that slot has already started");
  }
  private async assertNoSafetyHold(
    c: DbClient,
    tenantId: string,
    referralCaseId: string | null,
  ) {
    if (!referralCaseId) return;
    const held = await c.query(
      "SELECT 1 FROM work_items WHERE tenant_id=$1 AND case_id=$2 AND status='OPEN' AND kind IN ('SAFETY','FILE_SAFETY')",
      [tenantId, referralCaseId],
    );
    if (held.rowCount)
      throw conflict(
        "SAFETY_REVIEW_REQUIRED",
        "resolve the referral's safety review first",
      );
  }
  private async usableHold(c: DbClient, row: AppointmentRequestRow) {
    if (!row.current_hold_id) return undefined;
    const hold = await findHold(c, row.tenant_id, row.current_hold_id);
    return hold && hold.status === "ACTIVE" && holdIsUsable(hold.expires_at)
      ? hold
      : undefined;
  }
  /**
   * A held slot is booked against its hold, which must have time left; an
   * unheld slot must come from fresh availability.
   */
  private async submittableHold(
    c: DbClient,
    row: AppointmentRequestRow,
  ): Promise<HoldRow | undefined> {
    if (row.workflow_status === "HELD") {
      const hold = await this.usableHold(c, row);
      if (!hold || hold.slot_reference !== row.selected_slot_reference)
        throw conflict(
          "HOLD_EXPIRED",
          "the hold has expired or is about to: hold the slot again or choose another",
        );
      return hold;
    }
    this.assertFresh(row);
    return undefined;
  }
  /** Stop relying on the current hold; the destination is told (best effort). */
  private async releaseHold(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    row: AppointmentRequestRow,
  ) {
    if (!row.current_hold_id) return;
    const hold = await findHold(c, ctx.tenantId, row.current_hold_id);
    if (!hold || hold.status !== "ACTIVE") return;
    await closeHold(c, ctx.tenantId, hold.id, "RELEASED");
    if (hold.expires_at.getTime() > Date.now())
      await enqueueDestination(c, ctx, caseRow, {
        operation: "appointment.hold.release",
        subject: caseSubject(caseRow),
        payload: {
          schema_version: "appointment-hold-release.v1",
          hold_reference: hold.hold_reference,
          slot_reference: hold.slot_reference,
        },
      });
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "hold_released",
      payload: { hold_id: hold.id },
    });
  }
  /**
   * Policy for the operation, recorded before its outbox row is written.
   * A denial is refused without effect.
   */
  private async policy(
    c: DbClient,
    ctx: Ctx,
    caseRow: CaseRow,
    operation: Operation,
  ) {
    const decision = evaluateAppointmentOperation({
      caseType: caseRow.case_type,
      operation,
      ready: true,
    });
    if (decision.effect !== "ALLOW")
      throw new AppError(
        422,
        "POLICY_DENIED",
        `${operation} is not permitted: ${decision.reason}`,
      );
    await evidence(c, ctx, caseRow, caseSubject(caseRow), {
      eventType: "appointment_policy_evaluated",
      payload: {
        operation,
        effect: decision.effect,
        policy_version: decision.policyVersion,
        reason: decision.reason,
      },
    });
  }
  /**
   * Continue after a staff decision: the exception it answers is resolved
   * (the staff touch is counted once), then the case moves on.
   */
  private async resume(
    c: DbClient,
    ctx: Ctx,
    caseRowIn: CaseRow,
    action: { note?: string | undefined; staff_seconds?: number | undefined },
    input: { to: "WAITING" | "READY_FOR_BOOKING"; reason: string },
  ): Promise<CaseRow> {
    let caseRow = caseRowIn;
    if (caseRow.current_state === "EXCEPTION")
      await resolveWorkItems(c, ctx, caseRow, {
        kinds: ["CONNECTOR", "MANUAL_DESTINATION"],
        resolution: input.reason,
        note: action.note ?? null,
        staffSeconds: action.staff_seconds,
      });
    if (caseRow.current_state !== input.to)
      caseRow = await transitionCase(c, ctx, caseRow, {
        to: input.to,
        reason: input.reason,
        owner:
          input.to === "WAITING"
            ? "SYSTEM"
            : caseRow.case_type === "APPOINTMENT_REQUEST"
              ? "REFERRAL_COORDINATOR"
              : "PRACTICE_MANAGER",
      });
    return caseRow;
  }
}
