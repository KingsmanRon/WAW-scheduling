import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { ConnectorRequest } from "../../packages/contracts/src/index.js";
import {
  AmbiguousConnectorError,
  CapabilityGate,
  MockConnector,
  NoConnector,
  SafeRetryableConnectorError,
  UnsupportedOperationError,
  type FaultMode,
} from "../../apps/worker/src/connector.js";

const request = (): ConnectorRequest => ({
  schema_version: "connector-request.v1",
  execution_id: randomUUID(),
  tenant_id: randomUUID(),
  case_id: randomUUID(),
  subject: { type: "referral", id: randomUUID() },
  operation: "referral.create",
  correlation_id: randomUUID(),
  payload: {},
});

describe.each(["success", "retryable", "permanent", "deferred"] as FaultMode[])(
  "%s connector",
  (fault) =>
    it("returns a versioned normalized outcome bound to the execution", async () => {
      const r = request();
      const result = await new MockConnector({ fault }).execute(r);
      expect(result.schema_version).toBe("connector-result.v1");
      expect(result.execution_id).toBe(r.execution_id);
    }),
);

describe("mock destination semantics", () => {
  it("reconciles committed-then-timeout by the same execution identity without duplicate creation", async () => {
    const c = new MockConnector({ fault: "committed-timeout" });
    const r = request();
    expect((await c.execute(r)).status).toBe("AMBIGUOUS");
    const result = await c.reconcile(r);
    expect(result.status).toBe("SUCCEEDED");
    expect(await c.execute(r)).toEqual(result);
    expect(c.foreignWrites()).toBe(1);
  });
  it("a non-idempotent destination would duplicate on re-send (why ambiguity is never re-sent)", async () => {
    const c = new MockConnector({
      fault: "committed-timeout",
      idempotent: false,
    });
    const r = request();
    await c.execute(r);
    await c.execute(r);
    expect(c.foreignWrites()).toBe(2);
    expect((await c.reconcile(r)).status).toBe("AMBIGUOUS");
  });
  it("throws typed errors for known-unsent, possibly-sent and unsupported operations", async () => {
    await expect(
      new MockConnector({ fault: "pre-send-failure" }).execute(request()),
    ).rejects.toBeInstanceOf(SafeRetryableConnectorError);
    await expect(
      new MockConnector({ fault: "uncommitted-timeout" }).execute(request()),
    ).rejects.toBeInstanceOf(AmbiguousConnectorError);
    await expect(new NoConnector().execute(request())).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
  });
  it("capability gate enables only configured AND implemented capabilities", () => {
    const gate = new CapabilityGate(new MockConnector(), [
      "referral.create",
      "message.send",
    ]);
    expect(gate.isEnabled("referral.create")).toBe(true);
    // Configured but not implemented by the mock: never enabled.
    expect(gate.isEnabled("message.send")).toBe(false);
    // Implemented but not configured: never enabled.
    expect(gate.isEnabled("appointment.create")).toBe(false);
    expect(gate.isEnabled("appointment.status.read")).toBe(false);
    expect(
      new CapabilityGate(new NoConnector(), ["referral.create"]).list(),
    ).toEqual([]);
  });
  it("readback of appointment outcomes is deterministic", async () => {
    const c = new MockConnector({ appointmentOutcome: "BOOKED" });
    const a = await c.getAppointmentOutcome({
      destination_reference: "MOCK-1",
    });
    const b = await c.getAppointmentOutcome({
      destination_reference: "MOCK-1",
    });
    expect(a).toEqual(b);
    expect(a.source_reference).toBe("mock-appointment:MOCK-1:BOOKED");
  });
});
