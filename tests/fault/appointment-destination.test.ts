import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  appointmentCommitSchema,
  availabilityResultSchema,
  type AppointmentSlot,
  type ConnectorRequest,
  type Operation,
} from "../../packages/contracts/src/index.js";
import {
  AmbiguousConnectorError,
  CapabilityGate,
  MockConnector,
  SafeRetryableConnectorError,
} from "../../apps/worker/src/connector.js";
import { zonedToUtc } from "../../apps/worker/src/mock-destination.js";

/** Synthetic appointment destination: a transaction simulator. */
const NOW = Date.parse("2026-10-19T06:00:00Z"); // a Monday
const context = {
  destination_referral_reference: "MOCK-REF-1",
  patient_reference: null,
  service_code: null,
  destination_queue: null,
};
const search = (overrides: Record<string, unknown> = {}) => ({
  from: "2026-10-19T00:00:00Z",
  to: "2026-10-24T00:00:00Z",
  timezone: "Africa/Johannesburg",
  ...overrides,
});
function request(
  operation: Operation,
  payload: Record<string, unknown>,
  executionId = randomUUID(),
): ConnectorRequest {
  return {
    schema_version: "connector-request.v1",
    execution_id: executionId,
    tenant_id: randomUUID(),
    case_id: randomUUID(),
    subject: { type: "case", id: randomUUID() },
    operation,
    correlation_id: randomUUID(),
    payload,
  };
}
const connector = (
  appointments: ConstructorParameters<typeof MockConnector>[0] = {},
) =>
  new MockConnector({
    ...appointments,
    appointments: { clock: () => NOW, ...appointments.appointments },
  });
async function slots(c: MockConnector, overrides = {}) {
  const r = await c.execute(
    request("appointment.availability.read", {
      schema_version: "appointment-availability-query.v1",
      context,
      search: search(overrides),
    }),
  );
  expect(r.status).toBe("SUCCEEDED");
  return availabilityResultSchema.parse(
    (r as { data: Record<string, unknown> }).data,
  ).slots;
}
const booking = (slot: AppointmentSlot, hold: string | null = null) => ({
  schema_version: "appointment-booking-request.v1",
  context,
  slot,
  hold_reference: hold,
  replaces_appointment_reference: null,
});
const holdPayload = (slot: AppointmentSlot) => ({
  schema_version: "appointment-hold-request.v1",
  context,
  slot,
  ttl_seconds: 300,
});
const cancelPayload = (reference: string) => ({
  schema_version: "appointment-cancellation-request.v1",
  appointment_reference: reference,
  reason: "PATIENT_REQUEST",
  replaced_by_reference: null,
});

describe("availability (a read)", () => {
  it("returns deterministic weekday slots in the requested time zone", async () => {
    const c = connector();
    const first = await slots(c);
    const again = await slots(c);
    expect(first).toEqual(again);
    expect(first).toHaveLength(20);
    // 09:00 in Johannesburg (UTC+2, no daylight saving) is 07:00Z.
    expect(first[0]).toMatchObject({
      start_at: "2026-10-19T07:00:00.000Z",
      end_at: "2026-10-19T07:30:00.000Z",
      timezone: "Africa/Johannesburg",
      hold_supported: true,
      hold_expires_at: null,
    });
    // Reading availability reserves nothing.
    expect(c.destination.holds.size).toBe(0);
    expect(c.destination.appointments.size).toBe(0);
  });
  it("converts local times across a daylight-saving change", async () => {
    // London leaves summer time on Sunday 25 October 2026.
    const c = connector();
    const london = await slots(c, {
      from: "2026-10-23T00:00:00Z",
      to: "2026-10-27T00:00:00Z",
      timezone: "Europe/London",
    });
    const nine = london.filter(
      (s) =>
        /T0[89]:00:00/.test(s.start_at) && s.provider_reference === "PROV-A",
    );
    expect(nine.map((s) => s.start_at).slice(0, 2)).toEqual([
      "2026-10-23T08:00:00.000Z", // Friday 09:00 BST (UTC+1)
      "2026-10-26T09:00:00.000Z", // Monday 09:00 GMT (UTC+0)
    ]);
    expect(zonedToUtc(2026, 3, 29, 1, 30, "Europe/London").toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });
  it("honours provider and duration constraints and never offers the past", async () => {
    const c = connector({
      appointments: { clock: () => Date.parse("2026-10-19T08:00:00Z") },
    });
    const s = await slots(c, {
      provider_reference: "PROV-Z",
      duration_minutes: 45,
    });
    expect(new Set(s.map((x) => x.provider_reference))).toEqual(
      new Set(["PROV-Z"]),
    );
    expect(Date.parse(s[0]!.start_at)).toBeGreaterThan(
      Date.parse("2026-10-19T08:00:00Z"),
    );
    expect(Date.parse(s[0]!.end_at) - Date.parse(s[0]!.start_at)).toBe(
      45 * 60000,
    );
  });
  it("can be empty, and faults make it retryable", async () => {
    const c = connector();
    c.destination.script("appointment.availability.read", [
      "no-availability",
      "retryable",
      "pre-send-failure",
    ]);
    expect(await slots(c)).toEqual([]);
    expect(
      (
        await c.execute(
          request("appointment.availability.read", {
            schema_version: "appointment-availability-query.v1",
            context,
            search: search(),
          }),
        )
      ).status,
    ).toBe("RETRYABLE");
    await expect(
      c.execute(
        request("appointment.availability.read", {
          schema_version: "appointment-availability-query.v1",
          context,
          search: search(),
        }),
      ),
    ).rejects.toBeInstanceOf(SafeRetryableConnectorError);
  });
});

describe("holds", () => {
  it("reserve a slot until they expire", async () => {
    const c = connector();
    const [slot] = await slots(c);
    const held = await c.execute(
      request("appointment.hold", holdPayload(slot!)),
    );
    expect(held).toMatchObject({
      status: "SUCCEEDED",
      data: {
        schema_version: "appointment-hold.v1",
        slot_reference: slot!.slot_reference,
        expires_at: new Date(NOW + 300_000).toISOString(),
      },
    });
    // A held slot is not offered or held again.
    expect(
      (await slots(c)).some((s) => s.slot_reference === slot!.slot_reference),
    ).toBe(false);
    expect(
      await c.execute(request("appointment.hold", holdPayload(slot!))),
    ).toMatchObject({ status: "PERMANENT", code: "SLOT_UNAVAILABLE" });
    c.destination.expireHold((held as { external_id: string }).external_id);
    expect(
      (await slots(c)).some((s) => s.slot_reference === slot!.slot_reference),
    ).toBe(true);
  });
  it("a destination without holds says so explicitly", async () => {
    const c = connector({ appointments: { holds: false } });
    expect(c.capabilities().map((d) => d.capability)).not.toContain(
      "appointment.hold",
    );
    const [slot] = await slots(c);
    expect(slot!.hold_supported).toBe(false);
    expect(
      new CapabilityGate(c, ["appointment.hold", "appointment.create"]).list(),
    ).toEqual(["appointment.create"]);
  });
});

describe("booking", () => {
  it("commits exactly once per execution and consumes the hold", async () => {
    const c = connector();
    const [slot] = await slots(c);
    const held = (await c.execute(
      request("appointment.hold", holdPayload(slot!)),
    )) as { external_id: string };
    const r = request("appointment.create", booking(slot!, held.external_id));
    const first = await c.execute(r);
    const again = await c.execute(r);
    expect(first).toEqual(again);
    expect(first.status).toBe("SUCCEEDED");
    expect(
      appointmentCommitSchema.parse((first as { data: unknown }).data),
    ).toMatchObject({ slot_reference: slot!.slot_reference });
    expect(c.destination.appointmentWrites()).toBe(1);
    expect(c.destination.bookedFor(slot!.slot_reference)).toHaveLength(1);
  });
  it("refuses an expired hold, a stale slot and a lost race", async () => {
    const c = connector();
    const [a, b] = await slots(c);
    const held = (await c.execute(
      request("appointment.hold", holdPayload(a!)),
    )) as { external_id: string };
    c.destination.expireHold(held.external_id);
    expect(
      await c.execute(
        request("appointment.create", booking(a!, held.external_id)),
      ),
    ).toMatchObject({ status: "PERMANENT", code: "HOLD_EXPIRED" });
    // Displayed, then taken through another channel before booking.
    c.destination.takeSlot(b!.slot_reference);
    expect(
      await c.execute(request("appointment.create", booking(b!))),
    ).toMatchObject({ status: "PERMANENT", code: "SLOT_UNAVAILABLE" });
    // Two consumers race for one unheld slot: only one commits.
    const [free] = await slots(c);
    const results = await Promise.all([
      c.execute(request("appointment.create", booking(free!))),
      c.execute(request("appointment.create", booking(free!))),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "PERMANENT",
      "SUCCEEDED",
    ]);
    expect(c.destination.bookedFor(free!.slot_reference)).toHaveLength(1);
  });
  it("committed-then-lost responses are found by read-back; uncommitted ones are confirmed absent", async () => {
    const c = connector();
    const [a, b] = await slots(c);
    c.destination.script("appointment.create", [
      "committed-timeout",
      "uncommitted-timeout",
      "committed-throw",
      "committed-malformed",
    ]);
    const lost = request("appointment.create", booking(a!));
    expect((await c.execute(lost)).status).toBe("AMBIGUOUS");
    expect(await c.reconcile(lost)).toMatchObject({
      status: "SUCCEEDED",
      data: { slot_reference: a!.slot_reference },
    });
    const unsent = request("appointment.create", booking(b!));
    await expect(c.execute(unsent)).rejects.toBeInstanceOf(
      AmbiguousConnectorError,
    );
    expect(await c.reconcile(unsent)).toMatchObject({
      status: "NOT_COMMITTED",
    });
    const [x, y] = await slots(c);
    await expect(
      c.execute(request("appointment.create", booking(x!))),
    ).rejects.toThrow(/socket hang up/);
    const malformed = await c.execute(
      request("appointment.create", booking(y!)),
    );
    expect(malformed.status).toBe("SUCCEEDED");
    expect(
      appointmentCommitSchema.safeParse((malformed as { data: unknown }).data)
        .success,
    ).toBe(false);
    expect(c.destination.appointmentWrites()).toBe(3);
  });
  it("without idempotency keys a blind re-send is misreported as a lost slot (why ambiguous writes are never re-sent)", async () => {
    const c = connector({ idempotent: false });
    const [slot] = await slots(c);
    const r = request("appointment.create", booking(slot!));
    c.destination.script("appointment.create", ["committed-timeout"]);
    expect((await c.execute(r)).status).toBe("AMBIGUOUS");
    // A blind re-send is refused as if someone else had the slot...
    expect(await c.execute(r)).toMatchObject({
      status: "PERMANENT",
      code: "SLOT_UNAVAILABLE",
    });
    // ...although this very execution booked it: only read-back is truthful.
    expect((await c.reconcile(r)).status).toBe("SUCCEEDED");
    expect(c.destination.appointmentWrites()).toBe(1);
  });
  it("permanent refusals, withdrawn capability and unanswerable read-back", async () => {
    const c = connector({ appointments: { readbackUnavailable: true } });
    const [slot] = await slots(c);
    c.destination.script("appointment.create", [
      "permanent",
      "capability-withdrawn",
    ]);
    expect(
      await c.execute(request("appointment.create", booking(slot!))),
    ).toMatchObject({ status: "PERMANENT", code: "REJECTED" });
    expect(
      await c.execute(request("appointment.create", booking(slot!))),
    ).toMatchObject({ status: "PERMANENT", code: "CAPABILITY_WITHDRAWN" });
    expect(
      await c.reconcile(request("appointment.create", booking(slot!))),
    ).toMatchObject({ status: "AMBIGUOUS" });
  });
});

describe("rescheduling and cancellation", () => {
  it("a replacement is committed against the original, verified, then the original is cancelled", async () => {
    const c = connector();
    const [a, b] = await slots(c);
    const original = (await c.execute(
      request("appointment.create", booking(a!)),
    )) as { external_id: string };
    const replacement = (await c.execute(
      request("appointment.reschedule", {
        ...booking(b!),
        replaces_appointment_reference: original.external_id,
      }),
    )) as { external_id: string; status: string };
    expect(replacement.status).toBe("SUCCEEDED");
    expect(
      await c.execute(
        request("appointment.verify", {
          schema_version: "appointment-verify-request.v1",
          appointment_reference: replacement.external_id,
        }),
      ),
    ).toMatchObject({ data: { status: "BOOKED" } });
    // Both exist until the original is cancelled.
    expect(
      [...c.destination.appointments.values()].filter(
        (x) => x.status === "BOOKED",
      ),
    ).toHaveLength(2);
    c.destination.script("appointment.reschedule.cancel_original", [
      "committed-timeout",
    ]);
    const cancel = request("appointment.reschedule.cancel_original", {
      ...cancelPayload(original.external_id),
      reason: "RESCHEDULED",
      replaced_by_reference: replacement.external_id,
    });
    expect((await c.execute(cancel)).status).toBe("AMBIGUOUS");
    expect(await c.reconcile(cancel)).toMatchObject({
      status: "SUCCEEDED",
      data: { appointment_reference: original.external_id },
    });
  });
  it("cancelling twice has one effect", async () => {
    const c = connector();
    const [slot] = await slots(c);
    const booked = (await c.execute(
      request("appointment.create", booking(slot!)),
    )) as { external_id: string };
    const cancel = request(
      "appointment.cancel",
      cancelPayload(booked.external_id),
    );
    const first = await c.execute(cancel);
    expect(await c.execute(cancel)).toEqual(first);
    expect(
      await c.execute(
        request("appointment.cancel", cancelPayload(booked.external_id)),
      ),
    ).toMatchObject({ status: "PERMANENT", code: "ALREADY_CANCELLED" });
    // The cancelled slot is free again.
    expect(
      (await slots(c)).some((s) => s.slot_reference === slot!.slot_reference),
    ).toBe(true);
  });
  it("a cancellation whose response is lost is found by read-back", async () => {
    const c = connector();
    const [slot] = await slots(c);
    const booked = (await c.execute(
      request("appointment.create", booking(slot!)),
    )) as { external_id: string };
    c.destination.script("appointment.cancel", ["committed-timeout"]);
    const cancel = request(
      "appointment.cancel",
      cancelPayload(booked.external_id),
    );
    expect((await c.execute(cancel)).status).toBe("AMBIGUOUS");
    expect((await c.reconcile(cancel)).status).toBe("SUCCEEDED");
    const never = request("appointment.cancel", cancelPayload("APT-UNKNOWN"));
    expect((await c.reconcile(never)).status).toBe("NOT_COMMITTED");
  });
});
