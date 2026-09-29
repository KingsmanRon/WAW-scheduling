import {
  CAPABILITIES,
  type AppointmentOutcome,
  type Capability,
  type ConnectorRequest,
  type ConnectorResult,
  type ReferralStatus,
} from "@access/contracts";

/**
 * Connector port and error taxonomy.
 *
 * The dispatcher may retry automatically ONLY when the foreign effect is
 * known not to have happened. Anything else about a consequential write is
 * AMBIGUOUS and goes to read-back reconciliation by the original
 * execution_id; it is never blindly executed again.
 */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
/** The request never reached the foreign system (pre-send, explicit 429...). */
export class SafeRetryableConnectorError extends ConnectorError {}
/** The foreign system definitively refused; nothing was committed. */
export class PermanentConnectorError extends ConnectorError {}
/** The foreign system may have committed (timeout after send, lost connection). */
export class AmbiguousConnectorError extends ConnectorError {}
export class UnsupportedOperationError extends ConnectorError {
  constructor(readonly capability: string) {
    super(`capability ${capability} is not supported`, "UNSUPPORTED_OPERATION");
  }
}
/** Response could not be parsed; the effect may have happened. */
export class InvalidConnectorResponseError extends ConnectorError {}

export interface CapabilityDescriptor {
  capability: Capability;
  /** The destination de-duplicates on execution_id, so re-send is safe. */
  idempotentByExecutionId: boolean;
}
export interface Connector {
  readonly name: string;
  capabilities(): readonly CapabilityDescriptor[];
  execute(request: ConnectorRequest): Promise<ConnectorResult>;
  /** Read back the effect of `request.execution_id`; never re-executes. */
  reconcile(request: ConnectorRequest): Promise<ConnectorResult>;
  getReferralStatus(input: {
    tenant_id: string;
    case_id: string;
    destination_reference: string;
  }): Promise<ReferralStatus>;
  getAppointmentOutcome(input: {
    tenant_id: string;
    case_id: string;
    destination_reference: string;
  }): Promise<AppointmentOutcome>;
}

/**
 * Capabilities usable in this deployment: declared by the connector AND
 * enabled by configuration. Nothing else executes, and nothing is emulated.
 */
export class CapabilityGate {
  private enabled: Map<Capability, CapabilityDescriptor>;
  constructor(connector: Connector, configured: readonly Capability[]) {
    this.enabled = new Map(
      connector
        .capabilities()
        .filter((d) => configured.includes(d.capability))
        .map((d) => [d.capability, d]),
    );
  }
  isEnabled(capability: string): boolean {
    return this.enabled.has(capability as Capability);
  }
  descriptor(capability: string): CapabilityDescriptor | undefined {
    return this.enabled.get(capability as Capability);
  }
  list(): Capability[] {
    return [...this.enabled.keys()];
  }
}

/** No automated destination: every capability is unsupported (manual path). */
export class NoConnector implements Connector {
  readonly name = "none";
  capabilities() {
    return [];
  }
  async execute(request: ConnectorRequest): Promise<ConnectorResult> {
    throw new UnsupportedOperationError(request.operation);
  }
  async reconcile(request: ConnectorRequest): Promise<ConnectorResult> {
    throw new UnsupportedOperationError(`${request.operation}:read`);
  }
  async getReferralStatus(): Promise<ReferralStatus> {
    throw new UnsupportedOperationError("referral.status.read");
  }
  async getAppointmentOutcome(): Promise<AppointmentOutcome> {
    throw new UnsupportedOperationError("appointment.status.read");
  }
}

export type FaultMode =
  | "success"
  | "retryable"
  | "retryable-then-success"
  | "pre-send-failure"
  | "permanent"
  | "deferred"
  | "unsupported"
  | "committed-timeout"
  | "committed-throw"
  | "committed-malformed"
  | "uncommitted-timeout"
  | "execution-id-mismatch"
  | "malformed"
  | "capability-withdrawn";
export const FAULT_MODES: readonly FaultMode[] = [
  "success",
  "retryable",
  "retryable-then-success",
  "pre-send-failure",
  "permanent",
  "deferred",
  "unsupported",
  "committed-timeout",
  "committed-throw",
  "committed-malformed",
  "uncommitted-timeout",
  "execution-id-mismatch",
  "malformed",
  "capability-withdrawn",
];

export interface MockOptions {
  fault?: FaultMode;
  /** Failures before success for retryable-then-success. */
  retryableFailures?: number;
  /** Inconclusive read-backs before the committed result is visible. */
  reconcileAmbiguousPolls?: number;
  /**
   * false simulates a destination without idempotency keys: every send that
   * reaches commit creates a new foreign record. Proves the dispatcher never
   * re-sends an ambiguous write.
   */
  idempotent?: boolean;
  appointmentOutcome?: AppointmentOutcome["outcome"];
}
const MOCK_CAPABILITIES: Capability[] = [
  "patient.lookup",
  "referral.create",
  "referral.status.read",
  "appointment.status.read",
];

/**
 * Deterministic synthetic destination. It records every foreign effect so
 * tests can prove "one execution_id, one effective write".
 */
export class MockConnector implements Connector {
  readonly name = "mock";
  /** execution_id -> destination references created for it. */
  readonly effects = new Map<string, string[]>();
  readonly executeCalls = new Map<string, number>();
  readonly outcomes = new Map<string, AppointmentOutcome>();
  private reconcilePolls = new Map<string, number>();
  private failures = new Map<string, number>();
  constructor(private options: MockOptions = {}) {}
  get fault(): FaultMode {
    return this.options.fault ?? "success";
  }
  setFault(fault: FaultMode) {
    this.options.fault = fault;
  }
  capabilities(): CapabilityDescriptor[] {
    return MOCK_CAPABILITIES.map((capability) => ({
      capability,
      idempotentByExecutionId: this.options.idempotent ?? true,
    }));
  }
  /** Total distinct foreign records created. */
  foreignWrites(): number {
    return [...this.effects.values()].reduce((n, refs) => n + refs.length, 0);
  }
  private result(id: string, extra: Record<string, unknown>): ConnectorResult {
    return {
      schema_version: "connector-result.v1",
      execution_id: id,
      ...extra,
    } as ConnectorResult;
  }
  private commit(id: string): string {
    const refs = this.effects.get(id) ?? [];
    if (refs.length && (this.options.idempotent ?? true)) return refs[0]!;
    const reference = `MOCK-${id.slice(0, 8).toUpperCase()}${refs.length ? `-${refs.length + 1}` : ""}`;
    this.effects.set(id, [...refs, reference]);
    return reference;
  }
  async execute(request: ConnectorRequest): Promise<ConnectorResult> {
    const id = request.execution_id;
    this.executeCalls.set(id, (this.executeCalls.get(id) ?? 0) + 1);
    if (request.operation !== "referral.create")
      return this.result(id, {
        status: "UNSUPPORTED_OPERATION",
        capability: request.operation,
      });
    const idempotent = this.options.idempotent ?? true;
    if (idempotent && this.effects.has(id))
      return this.result(id, {
        status: "SUCCEEDED",
        external_id: this.effects.get(id)![0],
      });
    switch (this.fault) {
      case "retryable":
        return this.result(id, { status: "RETRYABLE", code: "TEMPORARY" });
      case "retryable-then-success": {
        const n = this.failures.get(id) ?? 0;
        if (n < (this.options.retryableFailures ?? 2)) {
          this.failures.set(id, n + 1);
          return this.result(id, { status: "RETRYABLE", code: "TEMPORARY" });
        }
        break;
      }
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
      case "deferred":
        return this.result(id, {
          status: "DEFERRED",
          descriptor: "manual connector approval",
        });
      case "unsupported":
        throw new UnsupportedOperationError(request.operation);
      case "malformed":
        return { unexpected: true } as unknown as ConnectorResult;
      case "uncommitted-timeout":
        throw new AmbiguousConnectorError("timeout after send", "TIMEOUT");
      default:
        break;
    }
    const external = this.commit(id);
    if (this.fault === "committed-timeout")
      return this.result(id, {
        status: "AMBIGUOUS",
        unknown: "timeout after request body accepted",
      });
    if (this.fault === "committed-throw")
      throw new Error("socket hang up after request transmission");
    if (this.fault === "committed-malformed")
      return {
        schema_version: "connector-result.v1",
        execution_id: id,
        status: "SUCCEEDED",
      } as unknown as ConnectorResult;
    if (this.fault === "execution-id-mismatch")
      return this.result("00000000-0000-4000-8000-000000000000", {
        status: "SUCCEEDED",
        external_id: external,
      });
    return this.result(id, { status: "SUCCEEDED", external_id: external });
  }
  async reconcile(request: ConnectorRequest): Promise<ConnectorResult> {
    const id = request.execution_id;
    const polls = (this.reconcilePolls.get(id) ?? 0) + 1;
    this.reconcilePolls.set(id, polls);
    const refs = this.effects.get(id);
    if (!refs?.length || polls <= (this.options.reconcileAmbiguousPolls ?? 0))
      return this.result(id, {
        status: "AMBIGUOUS",
        unknown: "no uniquely matching result",
      });
    if (refs.length > 1)
      return this.result(id, {
        status: "AMBIGUOUS",
        unknown: "multiple matching records",
      });
    return this.result(id, { status: "SUCCEEDED", external_id: refs[0] });
  }
  async getReferralStatus(input: {
    destination_reference: string;
  }): Promise<ReferralStatus> {
    const known = [...this.effects.values()].some((r) =>
      r.includes(input.destination_reference),
    );
    return {
      schema_version: "referral-status.v1",
      destination_reference: input.destination_reference,
      status: known ? "ACCEPTED" : "NOT_FOUND",
      observed_at: new Date().toISOString(),
    };
  }
  async getAppointmentOutcome(input: {
    destination_reference: string;
  }): Promise<AppointmentOutcome> {
    const scripted = this.outcomes.get(input.destination_reference);
    if (scripted) return scripted;
    const outcome = this.options.appointmentOutcome ?? "NONE";
    if (outcome === "NONE" || outcome === "UNKNOWN")
      return {
        schema_version: "appointment-outcome.v1",
        destination_reference: input.destination_reference,
        outcome,
        occurred_at: null,
        source_reference: null,
      };
    // Deterministic: the first read fixes the fact, later reads repeat it.
    const fact: AppointmentOutcome = {
      schema_version: "appointment-outcome.v1",
      destination_reference: input.destination_reference,
      outcome,
      occurred_at: new Date().toISOString(),
      source_reference: `mock-appointment:${input.destination_reference}:${outcome}`,
    };
    this.outcomes.set(input.destination_reference, fact);
    return fact;
  }
}

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}
