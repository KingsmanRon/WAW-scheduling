import {
  appointmentSlotSchema,
  availabilityQuerySchema,
  bookingRequestSchema,
  cancellationRequestSchema,
  holdReleaseSchema,
  holdRequestSchema,
  verifyRequestSchema,
  type AppointmentCommit,
  type AppointmentSlot,
  type ConnectorRequest,
  type ConnectorResult,
} from "@access/contracts";
import {
  AmbiguousConnectorError,
  PermanentConnectorError,
  SafeRetryableConnectorError,
} from "./connector-errors.js";

/**
 * Deterministic synthetic appointment destination: a transaction simulator,
 * not a happy-path stub. It keeps slots, holds and appointments; honours
 * holds and their expiry; refuses a taken or stale slot; de-duplicates by
 * execution_id; answers read-back authoritatively (found / NOT_COMMITTED);
 * and injects faults per operation from a script. Synthetic only.
 */

export type AppointmentFault =
  | "success"
  | "no-availability"
  | "slot-taken"
  | "hold-expired"
  | "retryable"
  | "pre-send-failure"
  | "permanent"
  | "capability-withdrawn"
  | "committed-timeout"
  | "committed-throw"
  | "committed-malformed"
  | "uncommitted-timeout"
  | "not-found";
export const APPOINTMENT_FAULTS: readonly AppointmentFault[] = [
  "success",
  "no-availability",
  "slot-taken",
  "hold-expired",
  "retryable",
  "pre-send-failure",
  "permanent",
  "capability-withdrawn",
  "committed-timeout",
  "committed-throw",
  "committed-malformed",
  "uncommitted-timeout",
  "not-found",
];

export interface MockDestinationOptions {
  /** The destination can hold slots (declares appointment.hold). */
  holds?: boolean;
  /** Upper bound on a hold's life, whatever ACCESS asks for. */
  maxHoldSeconds?: number;
  /** false: every send that reaches commit creates a new record. */
  idempotent?: boolean;
  /** Inconclusive read-backs before the true answer is given. */
  reconcileAmbiguousPolls?: number;
  /** Read-back never answers (a destination without a lookup). */
  readbackUnavailable?: boolean;
  clock?: () => number;
}

interface MockAppointment {
  reference: string;
  slot: AppointmentSlot;
  status: "BOOKED" | "CANCELLED";
  executionId: string;
  cancelledBy: string | null;
  cancelledAt: string | null;
  replaces: string | null;
}
interface MockHold {
  reference: string;
  slotReference: string;
  executionId: string;
  expiresAt: number;
  released: boolean;
}

const LOCAL_SLOT_TIMES = [
  [9, 0],
  [10, 30],
  [14, 0],
  [15, 30],
] as const;
const MAX_SLOTS = 24;

/** UTC offset of `tz` at an instant, in minutes. */
function offsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - utcMs) / 60000);
}
/** A wall-clock time in `tz` as a UTC instant (DST-aware). */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMinutes(guess, tz);
  let ts = guess - first * 60000;
  const second = offsetMinutes(ts, tz);
  if (second !== first) ts = guess - second * 60000;
  return new Date(ts);
}
function localDate(utcMs: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}
const compact = (iso: string) =>
  iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

export class MockAppointmentDestination {
  readonly appointments = new Map<string, MockAppointment>();
  readonly holds = new Map<string, MockHold>();
  /** Slots taken by someone outside ACCESS (another channel). */
  readonly takenElsewhere = new Set<string>();
  /** execution_id -> references created for it (proves exactly-once). */
  readonly effects = new Map<string, string[]>();
  readonly calls = new Map<string, number>();
  private scripts = new Map<string, AppointmentFault[]>();
  private reconcilePolls = new Map<string, number>();
  private sequence = 0;
  constructor(private options: MockDestinationOptions = {}) {}

  get holdsSupported(): boolean {
    return this.options.holds ?? true;
  }
  now(): number {
    return (this.options.clock ?? Date.now)();
  }
  /** Queue faults for the next calls of one operation (then success). */
  script(operation: string, faults: AppointmentFault[]): void {
    this.scripts.set(operation, [
      ...(this.scripts.get(operation) ?? []),
      ...faults,
    ]);
  }
  private nextFault(operation: string, fallback: AppointmentFault) {
    const queue = this.scripts.get(operation);
    return queue?.length ? queue.shift()! : fallback;
  }
  /** Someone else books the slot (another channel): it is no longer free. */
  takeSlot(slotReference: string): void {
    this.takenElsewhere.add(slotReference);
  }
  expireHold(holdReference: string): void {
    const hold = this.holds.get(holdReference);
    if (hold) hold.expiresAt = this.now() - 1;
  }
  /** Distinct appointments ever created. */
  appointmentWrites(): number {
    return [...this.effects.values()]
      .flat()
      .filter((r) => this.appointments.has(r)).length;
  }
  bookedFor(slotReference: string): MockAppointment[] {
    return [...this.appointments.values()].filter(
      (a) => a.slot.slot_reference === slotReference && a.status === "BOOKED",
    );
  }

  private slotFree(slotReference: string, forHold?: string | null) {
    if (this.takenElsewhere.has(slotReference)) return false;
    if (this.bookedFor(slotReference).length) return false;
    for (const hold of this.holds.values())
      if (
        hold.slotReference === slotReference &&
        !hold.released &&
        hold.expiresAt > this.now() &&
        hold.reference !== forHold
      )
        return false;
    return true;
  }
  private result(id: string, extra: Record<string, unknown>): ConnectorResult {
    return {
      schema_version: "connector-result.v1",
      execution_id: id,
      ...extra,
    } as ConnectorResult;
  }
  private record(executionId: string, reference: string) {
    this.effects.set(executionId, [
      ...(this.effects.get(executionId) ?? []),
      reference,
    ]);
  }
  private idempotent() {
    return this.options.idempotent ?? true;
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResult> {
    const id = request.execution_id;
    const op = request.operation;
    this.calls.set(op, (this.calls.get(op) ?? 0) + 1);
    switch (op) {
      case "appointment.availability.read":
        return this.availability(request);
      case "appointment.hold":
        return this.hold(request);
      case "appointment.hold.release": {
        const payload = holdReleaseSchema.parse(request.payload);
        const hold = this.holds.get(payload.hold_reference);
        if (hold) hold.released = true;
        return this.result(id, {
          status: "SUCCEEDED",
          external_id: payload.hold_reference,
        });
      }
      case "appointment.create":
      case "appointment.reschedule":
        return this.book(request);
      case "appointment.verify":
        return this.verify(request);
      case "appointment.cancel":
      case "appointment.reschedule.cancel_original":
        return this.cancel(request);
      default:
        return this.result(id, {
          status: "UNSUPPORTED_OPERATION",
          capability: op,
        });
    }
  }

  /** Faults that apply before anything is done at the destination. */
  private preCommit(id: string, fault: AppointmentFault) {
    switch (fault) {
      case "retryable":
        return this.result(id, { status: "RETRYABLE", code: "TEMPORARY" });
      case "pre-send-failure":
        throw new SafeRetryableConnectorError(
          "connection refused before send",
          "CONNECT_REFUSED",
        );
      case "permanent":
        return this.result(id, { status: "PERMANENT", code: "REJECTED" });
      case "capability-withdrawn":
        return this.result(id, {
          status: "PERMANENT",
          code: "CAPABILITY_WITHDRAWN",
        });
      case "uncommitted-timeout":
        throw new AmbiguousConnectorError("timeout after send", "TIMEOUT");
      default:
        return null;
    }
  }
  /** Faults that apply after the destination committed. */
  private postCommit(
    id: string,
    fault: AppointmentFault,
    success: ConnectorResult,
  ): ConnectorResult {
    switch (fault) {
      case "committed-timeout":
        return this.result(id, {
          status: "AMBIGUOUS",
          unknown: "timeout after request body accepted",
        });
      case "committed-throw":
        throw new Error("socket hang up after request transmission");
      case "committed-malformed":
        return this.result(id, {
          status: "SUCCEEDED",
          external_id: (success as { external_id?: string }).external_id,
          data: { schema_version: "unexpected" },
        });
      default:
        return success;
    }
  }

  private availability(request: ConnectorRequest): ConnectorResult {
    const id = request.execution_id;
    const fault = this.nextFault(request.operation, "success");
    const early = this.preCommit(id, fault);
    if (early) return early;
    if (fault === "uncommitted-timeout" || fault === "committed-timeout")
      throw new AmbiguousConnectorError("read timed out", "TIMEOUT");
    const query = availabilityQuerySchema.parse(request.payload);
    const slots =
      fault === "no-availability" ? [] : this.generateSlots(query.search);
    const observedAt = new Date(this.now()).toISOString();
    if (fault === "committed-malformed")
      return this.result(id, {
        status: "SUCCEEDED",
        external_id: `MOCK-AVAIL-${id.slice(0, 8).toUpperCase()}`,
        data: { slots: "not-a-list" },
      });
    return this.result(id, {
      status: "SUCCEEDED",
      external_id: `MOCK-AVAIL-${id.slice(0, 8).toUpperCase()}`,
      data: {
        schema_version: "appointment-availability.v1",
        observed_at: observedAt,
        slots,
      },
    });
  }

  /** Deterministic weekday slots at fixed local times in the query's zone. */
  generateSlots(search: {
    from: string;
    to: string;
    timezone: string;
    provider_reference?: string | undefined;
    location_reference?: string | undefined;
    duration_minutes?: number | undefined;
  }): AppointmentSlot[] {
    const from = new Date(search.from).getTime();
    const to = new Date(search.to).getTime();
    const minutes = search.duration_minutes ?? 30;
    const start = localDate(from, search.timezone);
    const slots: AppointmentSlot[] = [];
    for (
      let dayOffset = 0;
      dayOffset < 70 && slots.length < MAX_SLOTS;
      dayOffset++
    ) {
      const day = new Date(
        Date.UTC(start.year, start.month - 1, start.day + dayOffset),
      );
      const weekday = day.getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      for (const [index, [hour, minute]] of LOCAL_SLOT_TIMES.entries()) {
        const at = zonedToUtc(
          day.getUTCFullYear(),
          day.getUTCMonth() + 1,
          day.getUTCDate(),
          hour,
          minute,
          search.timezone,
        );
        const end = new Date(at.getTime() + minutes * 60000);
        if (at.getTime() < from || end.getTime() > to) continue;
        if (at.getTime() <= this.now()) continue;
        const provider =
          search.provider_reference ?? (index % 2 === 0 ? "PROV-A" : "PROV-B");
        const reference = `S-${provider}-${compact(at.toISOString())}`;
        if (!this.slotFree(reference)) continue;
        slots.push(
          appointmentSlotSchema.parse({
            slot_reference: reference,
            provider_reference: provider,
            location_reference: search.location_reference ?? "LOC-MAIN",
            start_at: at.toISOString(),
            end_at: end.toISOString(),
            timezone: search.timezone,
            hold_supported: this.holdsSupported,
            hold_expires_at: null,
          }),
        );
        if (slots.length >= MAX_SLOTS) break;
      }
      if (
        new Date(
          Date.UTC(start.year, start.month - 1, start.day + dayOffset),
        ).getTime() > to
      )
        break;
    }
    return slots;
  }

  private hold(request: ConnectorRequest): ConnectorResult {
    const id = request.execution_id;
    if (!this.holdsSupported)
      return this.result(id, {
        status: "UNSUPPORTED_OPERATION",
        capability: "appointment.hold",
      });
    const existing = this.effects.get(id);
    if (existing?.length && this.idempotent()) {
      const hold = this.holds.get(existing[0]!)!;
      return this.holdResult(id, hold);
    }
    const fault = this.nextFault(request.operation, "success");
    const early = this.preCommit(id, fault);
    if (early) return early;
    const payload = holdRequestSchema.parse(request.payload);
    if (fault === "slot-taken") this.takeSlot(payload.slot.slot_reference);
    if (!this.slotFree(payload.slot.slot_reference))
      return this.result(id, { status: "PERMANENT", code: "SLOT_UNAVAILABLE" });
    const ttl = Math.min(
      payload.ttl_seconds,
      this.options.maxHoldSeconds ?? 600,
    );
    const hold: MockHold = {
      reference: `H-${id.slice(0, 8).toUpperCase()}-${++this.sequence}`,
      slotReference: payload.slot.slot_reference,
      executionId: id,
      expiresAt: this.now() + ttl * 1000,
      released: false,
    };
    this.holds.set(hold.reference, hold);
    this.record(id, hold.reference);
    return this.postCommit(id, fault, this.holdResult(id, hold));
  }
  private holdResult(id: string, hold: MockHold): ConnectorResult {
    return this.result(id, {
      status: "SUCCEEDED",
      external_id: hold.reference,
      data: {
        schema_version: "appointment-hold.v1",
        hold_reference: hold.reference,
        slot_reference: hold.slotReference,
        expires_at: new Date(hold.expiresAt).toISOString(),
      },
    });
  }

  private book(request: ConnectorRequest): ConnectorResult {
    const id = request.execution_id;
    const existing = this.effects.get(id);
    if (existing?.length && this.idempotent())
      return this.commitResult(id, this.appointments.get(existing[0]!)!);
    const fault = this.nextFault(request.operation, "success");
    const early = this.preCommit(id, fault);
    if (early) return early;
    const payload = bookingRequestSchema.parse(request.payload);
    const slotReference = payload.slot.slot_reference;
    if (fault === "slot-taken") this.takeSlot(slotReference);
    if (payload.hold_reference) {
      const hold = this.holds.get(payload.hold_reference);
      if (!hold || hold.released || hold.slotReference !== slotReference)
        return this.result(id, { status: "PERMANENT", code: "HOLD_NOT_FOUND" });
      if (fault === "hold-expired" || hold.expiresAt <= this.now()) {
        hold.expiresAt = Math.min(hold.expiresAt, this.now() - 1);
        return this.result(id, { status: "PERMANENT", code: "HOLD_EXPIRED" });
      }
    }
    // Atomic revalidation at commit: an unheld slot may have gone.
    if (!this.slotFree(slotReference, payload.hold_reference))
      return this.result(id, { status: "PERMANENT", code: "SLOT_UNAVAILABLE" });
    if (payload.replaces_appointment_reference) {
      const original = this.appointments.get(
        payload.replaces_appointment_reference,
      );
      if (!original || original.status !== "BOOKED")
        return this.result(id, {
          status: "PERMANENT",
          code: "ORIGINAL_NOT_FOUND",
        });
    }
    const appointment: MockAppointment = {
      reference: `APT-${id.slice(0, 8).toUpperCase()}${existing?.length ? `-${existing.length + 1}` : ""}`,
      slot: payload.slot,
      status: "BOOKED",
      executionId: id,
      cancelledBy: null,
      cancelledAt: null,
      replaces: payload.replaces_appointment_reference,
    };
    if (payload.hold_reference) {
      const hold = this.holds.get(payload.hold_reference)!;
      hold.released = true;
    }
    this.appointments.set(appointment.reference, appointment);
    this.record(id, appointment.reference);
    return this.postCommit(id, fault, this.commitResult(id, appointment));
  }
  private commitData(appointment: MockAppointment): AppointmentCommit {
    return {
      schema_version: "appointment-commit.v1",
      appointment_reference: appointment.reference,
      slot_reference: appointment.slot.slot_reference,
      start_at: appointment.slot.start_at,
      end_at: appointment.slot.end_at,
      timezone: appointment.slot.timezone,
      provider_reference: appointment.slot.provider_reference,
      location_reference: appointment.slot.location_reference,
      patient_reference: null,
    };
  }
  private commitResult(id: string, appointment: MockAppointment) {
    return this.result(id, {
      status: "SUCCEEDED",
      external_id: appointment.reference,
      data: this.commitData(appointment),
    });
  }

  private verify(request: ConnectorRequest): ConnectorResult {
    const id = request.execution_id;
    const fault = this.nextFault(request.operation, "success");
    const early = this.preCommit(id, fault);
    if (early) return early;
    if (fault === "uncommitted-timeout" || fault === "committed-timeout")
      throw new AmbiguousConnectorError("read timed out", "TIMEOUT");
    const payload = verifyRequestSchema.parse(request.payload);
    const appointment = this.appointments.get(payload.appointment_reference);
    return this.result(id, {
      status: "SUCCEEDED",
      external_id: payload.appointment_reference,
      data: {
        schema_version: "appointment-status.v1",
        appointment_reference: payload.appointment_reference,
        status:
          fault === "not-found" || !appointment
            ? "NOT_FOUND"
            : appointment.status,
        observed_at: new Date(this.now()).toISOString(),
      },
    });
  }

  private cancel(request: ConnectorRequest): ConnectorResult {
    const id = request.execution_id;
    const payload = cancellationRequestSchema.parse(request.payload);
    const appointment = this.appointments.get(payload.appointment_reference);
    // Re-delivery of the same execution: same answer, no second effect.
    if (appointment?.cancelledBy === id && this.idempotent())
      return this.cancelResult(id, appointment);
    const fault = this.nextFault(request.operation, "success");
    const early = this.preCommit(id, fault);
    if (early) return early;
    if (!appointment)
      return this.result(id, {
        status: "PERMANENT",
        code: "APPOINTMENT_NOT_FOUND",
      });
    if (appointment.status === "CANCELLED")
      return this.result(id, {
        status: "PERMANENT",
        code: "ALREADY_CANCELLED",
      });
    appointment.status = "CANCELLED";
    appointment.cancelledBy = id;
    appointment.cancelledAt = new Date(this.now()).toISOString();
    this.record(id, `CANCEL:${appointment.reference}`);
    return this.postCommit(id, fault, this.cancelResult(id, appointment));
  }
  private cancelResult(id: string, appointment: MockAppointment) {
    return this.result(id, {
      status: "SUCCEEDED",
      external_id: appointment.reference,
      data: {
        schema_version: "appointment-cancellation.v1",
        appointment_reference: appointment.reference,
        cancelled_at: appointment.cancelledAt!,
      },
    });
  }

  /**
   * Read back the effect of `execution_id`. The simulator is the destination,
   * so it can say authoritatively that nothing was committed.
   */
  async reconcile(request: ConnectorRequest): Promise<ConnectorResult> {
    const id = request.execution_id;
    const polls = (this.reconcilePolls.get(id) ?? 0) + 1;
    this.reconcilePolls.set(id, polls);
    if (
      this.options.readbackUnavailable ||
      polls <= (this.options.reconcileAmbiguousPolls ?? 0)
    )
      return this.result(id, {
        status: "AMBIGUOUS",
        unknown: "destination could not answer",
      });
    const refs = this.effects.get(id) ?? [];
    if (refs.length > 1)
      return this.result(id, {
        status: "AMBIGUOUS",
        unknown: "multiple matching records",
      });
    switch (request.operation) {
      case "appointment.hold": {
        const hold = refs[0] ? this.holds.get(refs[0]) : undefined;
        return hold
          ? this.holdResult(id, hold)
          : this.notCommitted(id, "no hold for this execution");
      }
      case "appointment.create":
      case "appointment.reschedule": {
        const appointment = refs[0]
          ? this.appointments.get(refs[0])
          : undefined;
        return appointment
          ? this.commitResult(id, appointment)
          : this.notCommitted(id, "no appointment for this execution");
      }
      case "appointment.cancel":
      case "appointment.reschedule.cancel_original": {
        const payload = cancellationRequestSchema.parse(request.payload);
        const appointment = this.appointments.get(
          payload.appointment_reference,
        );
        return appointment?.cancelledBy === id
          ? this.cancelResult(id, appointment)
          : this.notCommitted(
              id,
              "appointment not cancelled by this execution",
            );
      }
      default:
        throw new PermanentConnectorError(
          "read-back not defined for operation",
          "READBACK_UNSUPPORTED",
        );
    }
  }
  private notCommitted(id: string, basis: string) {
    return this.result(id, { status: "NOT_COMMITTED", basis });
  }
}
