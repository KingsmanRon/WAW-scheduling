import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { MockConnector } from "../../apps/worker/src/connector.js";
import {
  closePools,
  databaseEnabled,
  dispatcher,
  drain,
  grantMembership,
  ingestBody,
  mintToken,
  mock,
  newTenant,
  ownerPool,
  testApi,
  type TestApi,
} from "../support/harness.js";

/**
 * Appointment operations qualification (scenarios A-R of the v1 brief).
 * Every scenario runs through the real HTTP API with signed workforce JWTs,
 * membership-derived tenancy and roles, the least-privilege database roles,
 * and the worker dispatcher against the synthetic destination. Each
 * scenario has its own organisation. Synthetic data only.
 */
const APPOINTMENT_CAPABILITIES = [
  "patient.lookup",
  "referral.create",
  "referral.status.read",
  "appointment.availability.read",
  "appointment.hold",
  "appointment.create",
  "appointment.reschedule",
  "appointment.cancel",
  "appointment.status.read",
];
const TZ = "Africa/Johannesburg";

interface ScenarioReport {
  scenario: string;
  title: string;
  passed: boolean;
  request_states: string[];
  workflow_status: string | null;
  evidence_valid: boolean | null;
  destination_appointments: number;
  notes: Record<string, unknown>;
}
const report: ScenarioReport[] = [];

type Headers = Record<string, string>;
interface Org {
  tenant: string;
  coordinator: Headers;
  manager: Headers;
  readOnly: Headers;
}

describe.runIf(databaseEnabled)("appointment operations qualification", () => {
  let t: TestApi;

  beforeAll(async () => {
    t = await testApi({ auth: "jwt" });
  });
  afterAll(async () => {
    await t.close();
    await closePools();
    if (process.env.APPOINTMENT_QUALIFICATION_REPORT)
      await writeFile(
        process.env.APPOINTMENT_QUALIFICATION_REPORT,
        JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            connector: "mock (synthetic destination)",
            scenarios: report,
          },
          null,
          2,
        ),
      );
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const org = async (): Promise<Org> => {
    const tenant = await newTenant({ destinationMode: "CONNECTOR" });
    const header = async (role: string) => {
      const user = randomUUID();
      await grantMembership(tenant, user, role);
      return { authorization: `Bearer ${await mintToken(user)}` };
    };
    return {
      tenant,
      coordinator: await header("REFERRAL_COORDINATOR"),
      manager: await header("PRACTICE_MANAGER"),
      readOnly: await header("READ_ONLY"),
    };
  };
  const send = (
    headers: Headers,
    method: "GET" | "POST",
    url: string,
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
  const ok = async (
    headers: Headers,
    method: "GET" | "POST",
    url: string,
    payload?: object,
  ) => {
    const res = await send(headers, method, url, payload);
    if (res.statusCode >= 300)
      throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const view = (headers: Headers, caseId: string) =>
    ok(headers, "GET", `/v1/cases/${caseId}`);
  const worker = (o: Org, connector: MockConnector, capabilities?: string[]) =>
    dispatcher([o.tenant], connector, {
      capabilities: capabilities ?? APPOINTMENT_CAPABILITIES,
    });
  /** A search window a week wide, starting tomorrow (local weekdays). */
  const searchWindow = () => {
    const from = new Date(Date.now() + 24 * 3600_000);
    from.setUTCMinutes(0, 0, 0);
    const to = new Date(from.getTime() + 8 * 24 * 3600_000);
    return { from: from.toISOString(), to: to.toISOString(), timezone: TZ };
  };
  /** A synthetic referral the connector has accepted: READY_FOR_BOOKING. */
  const readyReferral = async (o: Org, connector: MockConnector) => {
    const r = await ok(o.coordinator, "POST", "/v1/referrals", ingestBody());
    await drain(worker(o, connector));
    const v = await view(o.coordinator, r.case_id);
    expect(v.case.current_state).toBe("READY_FOR_BOOKING");
    expect(v.booking).toEqual({ eligible: true, reasons: [] });
    return r.case_id as string;
  };
  const startBooking = async (
    o: Org,
    referralId: string,
    headers: Headers = o.coordinator,
  ) => {
    const v = await view(headers, referralId);
    const res = await ok(headers, "POST", `/v1/cases/${referralId}/actions`, {
      action: "start_booking",
      command_id: randomUUID(),
      correlation_id: randomUUID(),
      expected_version: v.case.version,
      note: "synthetic start booking",
      search: searchWindow(),
    });
    return res.appointment_case_id as string;
  };
  const stepBody = (
    action: string,
    version: number,
    extra: Record<string, unknown> = {},
  ) => ({
    action,
    command_id: randomUUID(),
    correlation_id: randomUUID(),
    expected_version: version,
    ...extra,
  });
  /** A booking sub-flow step against the request's current version. */
  const step = async (
    headers: Headers,
    caseId: string,
    action: string,
    extra: Record<string, unknown> = {},
  ) => {
    const v = await view(headers, caseId);
    return send(
      headers,
      "POST",
      `/v1/cases/${caseId}/appointment-actions`,
      stepBody(action, v.appointment_request.version, extra),
    );
  };
  const stepOk = async (
    headers: Headers,
    caseId: string,
    action: string,
    extra: Record<string, unknown> = {},
  ) => {
    const res = await step(headers, caseId, action, extra);
    if (res.statusCode >= 300)
      throw new Error(`${action} -> ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const request = async (headers: Headers, caseId: string) =>
    (await view(headers, caseId)).appointment_request;
  const openKinds = (v: { work_items: { status: string; kind: string }[] }) =>
    v.work_items.filter((w) => w.status === "OPEN").map((w) => w.kind);
  /** Search, then select the first offered slot. */
  const searchAndSelect = async (
    o: Org,
    connector: MockConnector,
    caseId: string,
    headers: Headers = o.coordinator,
    index = 0,
  ) => {
    await drain(worker(o, connector));
    const req = await request(headers, caseId);
    expect(req.workflow_status).toBe("AVAILABILITY_RETURNED");
    const slot = req.availability.slots[index];
    await stepOk(headers, caseId, "select", {
      slot_reference: slot.slot_reference,
    });
    return slot as { slot_reference: string; start_at: string };
  };
  const bookedReferral = async (o: Org, connector: MockConnector) => {
    const referralId = await readyReferral(o, connector);
    const caseId = await startBooking(o, referralId);
    await searchAndSelect(o, connector, caseId);
    await stepOk(o.coordinator, caseId, "hold");
    await drain(worker(o, connector));
    await stepOk(o.coordinator, caseId, "commit");
    await drain(worker(o, connector));
    const v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    return {
      referralId,
      caseId,
      appointment: v.appointments[0] as { id: string; version: number },
    };
  };
  const record = async (
    scenario: string,
    title: string,
    o: Org,
    caseId: string,
    connector: MockConnector,
    notes: Record<string, unknown> = {},
  ) => {
    const v = await view(o.manager, caseId);
    report.push({
      scenario,
      title,
      passed: true,
      request_states: v.transitions.map(
        (x: { to_state: string }) => x.to_state,
      ),
      workflow_status: v.appointment_request?.workflow_status ?? null,
      evidence_valid: v.evidence.verification.valid,
      destination_appointments: connector.destination.appointmentWrites(),
      notes,
    });
    expect(v.evidence.verification.valid).toBe(true);
    return v;
  };

  // ---------------------------------------------------------------------------
  // Scenarios
  // ---------------------------------------------------------------------------

  it("A - standard booking: availability, select, hold, book, verify, booked, confirmed", async () => {
    const o = await org();
    const connector = mock();
    const referralId = await readyReferral(o, connector);
    const caseId = await startBooking(o, referralId);
    let referral = await view(o.coordinator, referralId);
    expect(referral.case.current_state).toBe("WAITING");
    expect(referral.access_status.label).toBe("Searching for appointment");

    const slot = await searchAndSelect(o, connector, caseId);
    let req = await request(o.coordinator, caseId);
    expect(req.availability.fresh).toBe(true);
    expect(req.availability.slots.length).toBeGreaterThan(1);
    expect(req.workflow_status).toBe("SLOT_SELECTED");

    await stepOk(o.coordinator, caseId, "hold");
    await drain(worker(o, connector));
    req = await request(o.coordinator, caseId);
    expect(req.workflow_status).toBe("HELD");
    expect(req.hold.status).toBe("ACTIVE");
    expect(new Date(req.hold.expires_at).getTime()).toBeGreaterThan(Date.now());

    const committed = await stepOk(o.coordinator, caseId, "commit");
    expect(committed.workflow_status).toBe("BOOKING_SUBMITTED");
    // Nothing is booked until the worker commits and reads it back.
    expect(connector.destination.appointmentWrites()).toBe(0);
    await drain(worker(o, connector));

    const v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    expect(v.appointment_request.workflow_status).toBe("BOOKED");
    // The booking consumed the hold, and the view still shows it was used.
    expect(v.appointment_request.hold.status).toBe("CONSUMED");
    expect(v.appointments).toHaveLength(1);
    const appointment = v.appointments[0];
    expect(appointment).toMatchObject({
      status: "BOOKED",
      slot_reference: slot.slot_reference,
      confirmation_status: "UNCONFIRMED",
      commit_source: "CONNECTOR",
    });
    expect(appointment.starts_at).toBe(slot.start_at);
    expect(v.executions.map((e: { operation: string }) => e.operation)).toEqual(
      [
        "appointment.availability.read",
        "appointment.hold",
        "appointment.create",
        "appointment.verify",
      ],
    );
    expect(
      v.executions.every((e: { status: string }) => e.status === "SUCCEEDED"),
    ).toBe(true);
    const events = v.evidence.events.map(
      (e: { event_type: string }) => e.event_type,
    );
    expect(events.indexOf("appointment_committed")).toBeLessThan(
      events.indexOf("appointment_verified"),
    );
    expect(connector.destination.appointmentWrites()).toBe(1);

    referral = await view(o.coordinator, referralId);
    expect(referral.case.current_state).toBe("BOOKED");
    expect(referral.case.resolution_code).toBe("BOOKED");
    expect(referral.access_status.label).toBe("Booked");
    expect(
      referral.observations.find(
        (x: { observation_type: string }) =>
          x.observation_type === "APPOINTMENT_BOOKED",
      ),
    ).toMatchObject({
      source_type: "CONNECTOR",
      verification_level: "EXTERNAL_CONFIRMED",
      disposition: "APPLIED",
    });

    // Booked is not confirmed: staff attest the patient's confirmation.
    const confirmed = await ok(
      o.coordinator,
      "POST",
      `/v1/appointments/${appointment.id}/actions`,
      {
        action: "confirm",
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        expected_version: appointment.version,
        method: "PHONE",
      },
    );
    expect(confirmed.confirmation_status).toBe("CONFIRMED");
    referral = await view(o.coordinator, referralId);
    expect(referral.access_status.label).toBe("Confirmed");
    expect(referral.appointments[0]).toMatchObject({
      confirmation_status: "CONFIRMED",
      confirmation_method: "PHONE",
    });
    const detail = await ok(
      o.readOnly,
      "GET",
      `/v1/appointments/${appointment.id}`,
    );
    expect(detail.appointment.status).toBe("BOOKED");
    await record("A", "Standard booking", o, caseId, connector, {
      referral_states: referral.transitions.map(
        (x: { to_state: string }) => x.to_state,
      ),
    });
    expect(openKinds(referral)).toEqual([]);
  });

  it("B - no availability: stays open in an actionable staff state, nothing booked", async () => {
    const o = await org();
    const connector = mock();
    connector.destination.script("appointment.availability.read", [
      "no-availability",
    ]);
    const referralId = await readyReferral(o, connector);
    const caseId = await startBooking(o, referralId);
    await drain(worker(o, connector));
    let v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("READY_FOR_BOOKING");
    expect(v.appointment_request.workflow_status).toBe("NO_AVAILABILITY");
    expect(v.appointment_request.availability.slots).toEqual([]);
    expect(v.next_action).toMatch(/No appointments found/);
    // Nothing can be selected or committed from an empty search.
    const commit = await step(o.coordinator, caseId, "commit");
    expect(commit.statusCode).toBe(409);
    expect(commit.json().error).toBe("INVALID_BOOKING_STEP");
    // Staff widen the search: slots come back; nothing was booked meanwhile.
    await stepOk(o.coordinator, caseId, "search", { search: searchWindow() });
    await drain(worker(o, connector));
    v = await view(o.coordinator, caseId);
    expect(v.appointment_request.workflow_status).toBe("AVAILABILITY_RETURNED");
    expect(v.appointments).toEqual([]);
    expect(connector.destination.appointmentWrites()).toBe(0);
    // Withdrawing returns the referral to booking; its follow-up resumes.
    await stepOk(o.coordinator, caseId, "withdraw", {
      note: "patient will call back",
    });
    v = await view(o.coordinator, caseId);
    expect(v.case).toMatchObject({
      current_state: "CLOSED",
      resolution_code: "WITHDRAWN",
    });
    const referral = await view(o.coordinator, referralId);
    expect(referral.case.current_state).toBe("READY_FOR_BOOKING");
    expect(referral.referral.follow_up_due_at).not.toBeNull();
    expect(referral.booking.eligible).toBe(true);
    await record("B", "No availability", o, caseId, connector);
  });

  it("C - stale slot: refused safely, nothing created, staff reselect", async () => {
    const o = await org();
    const connector = mock();
    const referralId = await readyReferral(o, connector);
    const caseId = await startBooking(o, referralId);
    const slot = await searchAndSelect(o, connector, caseId);
    // The slot goes elsewhere between display and commit (no hold).
    connector.destination.takeSlot(slot.slot_reference);
    await stepOk(o.coordinator, caseId, "commit");
    await drain(worker(o, connector));
    let v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("READY_FOR_BOOKING");
    expect(v.appointment_request).toMatchObject({
      workflow_status: "AVAILABILITY_RETURNED",
      last_failure_code: "SLOT_UNAVAILABLE",
    });
    expect(
      v.appointment_request.availability.slots.map(
        (x: { slot_reference: string }) => x.slot_reference,
      ),
    ).not.toContain(slot.slot_reference);
    expect(v.appointments).toEqual([]);
    expect(openKinds(v)).toEqual([]);
    expect(connector.destination.appointmentWrites()).toBe(0);
    // Availability older than ten minutes cannot be booked from.
    await ownerPool().query(
      `UPDATE appointment_requests SET availability_observed_at=now()-interval '11 minutes',version=version+1
        WHERE case_id=$1`,
      [caseId],
    );
    const stale = await step(o.coordinator, caseId, "select", {
      slot_reference:
        v.appointment_request.availability.slots[0].slot_reference,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("AVAILABILITY_STALE");
    // Search again, reselect, book.
    await stepOk(o.coordinator, caseId, "search");
    const second = await searchAndSelect(o, connector, caseId);
    expect(second.slot_reference).not.toBe(slot.slot_reference);
    await stepOk(o.coordinator, caseId, "commit");
    await drain(worker(o, connector));
    v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    expect(v.appointments[0].slot_reference).toBe(second.slot_reference);
    expect(connector.destination.appointmentWrites()).toBe(1);
    await record("C", "Stale slot", o, caseId, connector);
  });

  it("D - duplicate booking command: one external appointment only", async () => {
    const o = await org();
    const connector = mock();
    const referralId = await readyReferral(o, connector);
    const caseId = await startBooking(o, referralId);
    await searchAndSelect(o, connector, caseId);
    const req = await request(o.coordinator, caseId);
    const body = stepBody("commit", req.version);
    const url = `/v1/cases/${caseId}/appointment-actions`;
    const first = await ok(o.coordinator, "POST", url, body);
    const again = await ok(o.coordinator, "POST", url, body);
    expect(again).toEqual({ ...first, deduplicated: true });
    // Same command id, different request: refused, never executed.
    const reused = await send(o.coordinator, "POST", url, {
      ...body,
      note: "different",
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error).toBe("IDEMPOTENCY_CONFLICT");
    // A second commit from a stale view is refused on version.
    const stale = await send(o.coordinator, "POST", url, {
      ...body,
      command_id: randomUUID(),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("VERSION_CONFLICT");
    // Concurrent deliveries of the same command still write once.
    const concurrent = stepBody("withdraw", first.version, {
      note: "duplicate delivery",
    });
    const both = await Promise.all([
      send(o.coordinator, "POST", url, concurrent),
      send(o.coordinator, "POST", url, concurrent),
    ]);
    for (const res of both) expect(res.statusCode).toBe(409);
    await drain(worker(o, connector));
    const v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    // Booked straight from the selection: no hold was taken.
    expect(v.appointment_request.hold).toBeNull();
    expect(
      v.executions.filter(
        (e: { operation: string }) => e.operation === "appointment.create",
      ),
    ).toHaveLength(1);
    expect(connector.destination.appointmentWrites()).toBe(1);
    expect(connector.destination.calls.get("appointment.create")).toBe(1);
    await record("D", "Duplicate booking command", o, caseId, connector);
  });

  it("E - safe retry: a failure known before commit is retried to success", async () => {
    const o = await org();
    const connector = mock();
    connector.destination.script("appointment.create", [
      "pre-send-failure",
      "retryable",
    ]);
    const referralId = await readyReferral(o, connector);
    const caseId = await startBooking(o, referralId);
    await searchAndSelect(o, connector, caseId);
    await stepOk(o.coordinator, caseId, "commit");
    await drain(worker(o, connector));
    const v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    const create = v.executions.find(
      (e: { operation: string }) => e.operation === "appointment.create",
    );
    expect(create).toMatchObject({ status: "SUCCEEDED", attempts: 3 });
    expect(connector.destination.appointmentWrites()).toBe(1);
    await record("E", "Safe retry", o, caseId, connector, {
      attempts: create.attempts,
    });
  });

  it("F - ambiguous booking that committed: reconciled, never re-sent, BOOKED", async () => {
    const o = await org();
    // Without idempotency keys a re-send would create a second booking.
    const connector = mock({ idempotent: false });
    connector.destination.script("appointment.create", ["committed-timeout"]);
    const referralId = await readyReferral(o, connector);
    const caseId = await startBooking(o, referralId);
    await searchAndSelect(o, connector, caseId);
    await stepOk(o.coordinator, caseId, "commit");
    const d = worker(o, connector);
    while (await d.tick());
    let v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("WAITING");
    expect(v.appointment_request.workflow_status).toBe("BOOKING_SUBMITTED");
    expect(v.appointment_request.pending_execution.status).toBe("AMBIGUOUS");
    expect(v.appointments).toEqual([]);
    // Nothing else may be attempted while the outcome is unknown.
    const withdraw = await step(o.coordinator, caseId, "withdraw", {
      note: "try to abandon",
    });
    expect(withdraw.statusCode).toBe(409);
    await drain(d);
    v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    expect(v.appointments).toHaveLength(1);
    expect(v.appointments[0].commit_source).toBe("RECONCILIATION");
    expect(connector.destination.calls.get("appointment.create")).toBe(1);
    expect(connector.destination.appointmentWrites()).toBe(1);
    const referral = await view(o.coordinator, referralId);
    expect(referral.case.current_state).toBe("BOOKED");
    await record("F", "Ambiguous booking, committed", o, caseId, connector);
  });

  it("G - ambiguous booking that did not commit: retry only after read-back", async () => {
    const o = await org();
    const connector = mock();
    connector.destination.script("appointment.create", ["uncommitted-timeout"]);
    const referralId = await readyReferral(o, connector);
    const caseId = await startBooking(o, referralId);
    await searchAndSelect(o, connector, caseId);
    await stepOk(o.coordinator, caseId, "hold");
    await drain(worker(o, connector));
    await stepOk(o.coordinator, caseId, "commit");
    const d = worker(o, connector);
    while (await d.tick());
    // Not before reconciliation.
    const early = await step(o.coordinator, caseId, "commit");
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("INVALID_BOOKING_STEP");
    await d.reconcile();
    let v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("READY_FOR_BOOKING");
    expect(v.appointment_request).toMatchObject({
      workflow_status: "HELD",
      last_failure_code: "BOOKING_NOT_COMMITTED",
      pending_execution: null,
    });
    const create = v.executions.find(
      (e: { operation: string }) => e.operation === "appointment.create",
    );
    expect(create).toMatchObject({
      status: "PERMANENT",
      last_error: "CONFIRMED_NOT_COMMITTED",
    });
    expect(connector.destination.appointmentWrites()).toBe(0);
    // Only now may staff submit again (a new execution).
    await stepOk(o.coordinator, caseId, "commit");
    await drain(d);
    v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    expect(connector.destination.appointmentWrites()).toBe(1);
    await record("G", "Ambiguous booking, not committed", o, caseId, connector);
  });

  it("H - hold expiry: a lapsed hold is never booked; staff choose again", async () => {
    const o = await org();
    // The destination grants one-second holds.
    const connector = mock({ appointments: { maxHoldSeconds: 1 } });
    const referralId = await readyReferral(o, connector);
    const caseId = await startBooking(o, referralId);
    const first = await searchAndSelect(o, connector, caseId);
    await stepOk(o.coordinator, caseId, "hold");
    await drain(worker(o, connector));
    let req = await request(o.coordinator, caseId);
    expect(req.workflow_status).toBe("HELD");
    // Too little time left to submit against it.
    const late = await step(o.coordinator, caseId, "commit");
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("HOLD_EXPIRED");
    await new Promise((r) => setTimeout(r, 1100));
    expect(await worker(o, connector).sweepAppointments()).toBe(1);
    req = await request(o.coordinator, caseId);
    expect(req).toMatchObject({
      workflow_status: "SLOT_SELECTED",
      last_failure_code: "HOLD_EXPIRED",
      hold: null,
    });
    const holds = await ownerPool().query(
      "SELECT status FROM appointment_slot_holds WHERE case_id=$1",
      [caseId],
    );
    expect(holds.rows).toEqual([{ status: "EXPIRED" }]);
    // An expired hold can never be consumed.
    await expect(
      ownerPool().query(
        "UPDATE appointment_slot_holds SET status='CONSUMED',closed_at=now() WHERE case_id=$1",
        [caseId],
      ),
    ).rejects.toThrow(/EXPIRED hold cannot become CONSUMED/);
    // A hold the destination lets lapse early is refused at commit.
    await stepOk(o.coordinator, caseId, "search");
    const second = await searchAndSelect(
      o,
      connector,
      caseId,
      o.coordinator,
      1,
    );
    expect(second.slot_reference).not.toBe(first.slot_reference);
    await stepOk(o.coordinator, caseId, "commit");
    await drain(worker(o, connector));
    const v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    expect(v.appointments[0].slot_reference).toBe(second.slot_reference);
    expect(connector.destination.appointmentWrites()).toBe(1);
    await record("H", "Hold expiry", o, caseId, connector);
  });

  it("H2 - a hold lapsed at the destination is refused at commit, not consumed", async () => {
    const o = await org();
    const connector = mock();
    const referralId = await readyReferral(o, connector);
    const caseId = await startBooking(o, referralId);
    await searchAndSelect(o, connector, caseId);
    await stepOk(o.coordinator, caseId, "hold");
    await drain(worker(o, connector));
    const hold = await ownerPool().query(
      "SELECT hold_reference FROM appointment_slot_holds WHERE case_id=$1",
      [caseId],
    );
    connector.destination.expireHold(hold.rows[0].hold_reference);
    await stepOk(o.coordinator, caseId, "commit");
    await drain(worker(o, connector));
    const v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("READY_FOR_BOOKING");
    expect(v.appointment_request).toMatchObject({
      workflow_status: "AVAILABILITY_RETURNED",
      last_failure_code: "HOLD_EXPIRED",
    });
    expect(v.appointments).toEqual([]);
    const holds = await ownerPool().query(
      "SELECT status FROM appointment_slot_holds WHERE case_id=$1",
      [caseId],
    );
    expect(holds.rows).toEqual([{ status: "EXPIRED" }]);
    expect(connector.destination.appointmentWrites()).toBe(0);
    await record("H2", "Hold lapsed at destination", o, caseId, connector);
  });

  it("I - concurrent slot loss: one booking wins, the other is shown the conflict", async () => {
    const o = await org();
    const connector = mock();
    const first = await startBooking(o, await readyReferral(o, connector));
    const second = await startBooking(o, await readyReferral(o, connector));
    const a = await searchAndSelect(o, connector, first);
    const b = await searchAndSelect(o, connector, second);
    expect(b.slot_reference).toBe(a.slot_reference);
    await stepOk(o.coordinator, first, "commit");
    await stepOk(o.coordinator, second, "commit");
    await drain(worker(o, connector));
    const views = [
      await view(o.coordinator, first),
      await view(o.coordinator, second),
    ];
    expect(views.map((v) => v.case.current_state).sort()).toEqual([
      "BOOKED",
      "READY_FOR_BOOKING",
    ]);
    const loser = views.find((v) => v.case.current_state !== "BOOKED")!;
    expect(loser.appointment_request).toMatchObject({
      workflow_status: "AVAILABILITY_RETURNED",
      last_failure_code: "SLOT_UNAVAILABLE",
    });
    expect(loser.next_action).toBe("Choose an appointment slot");
    expect(connector.destination.bookedFor(a.slot_reference)).toHaveLength(1);
    expect(connector.destination.appointmentWrites()).toBe(1);
    // Holds race the same way: the second hold is refused.
    const third = await startBooking(o, await readyReferral(o, connector));
    const fourth = await startBooking(o, await readyReferral(o, connector));
    const c3 = await searchAndSelect(o, connector, third);
    await searchAndSelect(o, connector, fourth);
    await stepOk(o.coordinator, third, "hold");
    await stepOk(o.coordinator, fourth, "hold");
    await drain(worker(o, connector));
    const held = [
      await request(o.coordinator, third),
      await request(o.coordinator, fourth),
    ];
    expect(held.map((r) => r.workflow_status).sort()).toEqual([
      "AVAILABILITY_RETURNED",
      "HELD",
    ]);
    expect(c3.slot_reference).toBeDefined();
    await record("I", "Concurrent slot loss", o, loser.case.id, connector);
  });

  it("J - reschedule: B committed and verified before A is cancelled; A superseded by B", async () => {
    const o = await org();
    const connector = mock();
    const { referralId, appointment } = await bookedReferral(o, connector);
    const change = await ok(
      o.manager,
      "POST",
      `/v1/appointments/${appointment.id}/actions`,
      {
        action: "reschedule",
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        expected_version: appointment.version,
        note: "patient asked for another day",
        search: searchWindow(),
      },
    );
    const caseId = change.case_id as string;
    let referral = await view(o.manager, referralId);
    expect(referral.access_status.label).toBe("Reschedule in progress");
    const slot = await searchAndSelect(o, connector, caseId, o.manager);
    await stepOk(o.manager, caseId, "hold");
    await drain(worker(o, connector));
    await stepOk(o.manager, caseId, "commit");
    const planned = await ownerPool().query(
      "SELECT operation,status FROM outbox WHERE case_id=$1 ORDER BY id",
      [caseId],
    );
    expect(planned.rows.slice(-3)).toEqual([
      { operation: "appointment.reschedule", status: "PENDING" },
      { operation: "appointment.verify", status: "BLOCKED" },
      {
        operation: "appointment.reschedule.cancel_original",
        status: "BLOCKED",
      },
    ]);
    await drain(worker(o, connector));
    const v = await view(o.manager, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    expect(v.appointment_request.workflow_status).toBe("COMPLETED");
    const ops = v.executions.map((e: { operation: string }) => e.operation);
    expect(ops.slice(-3)).toEqual([
      "appointment.reschedule",
      "appointment.verify",
      "appointment.reschedule.cancel_original",
    ]);
    const a = v.appointments.find(
      (x: { id: string }) => x.id === appointment.id,
    );
    const b = v.appointments.find(
      (x: { id: string }) => x.id !== appointment.id,
    );
    expect(a).toMatchObject({ status: "SUPERSEDED", superseded_by_id: b.id });
    expect(b).toMatchObject({
      status: "BOOKED",
      replaces_appointment_id: a.id,
      slot_reference: slot.slot_reference,
    });
    referral = await view(o.manager, referralId);
    expect(
      referral.appointments.filter(
        (x: { status: string }) => x.status === "BOOKED",
      ),
    ).toHaveLength(1);
    expect(referral.case.current_state).toBe("BOOKED");
    expect(referral.access_status.label).toBe("Booked");
    expect(
      [...connector.destination.appointments.values()].map((x) => x.status),
    ).toEqual(["CANCELLED", "BOOKED"]);
    await record("J", "Reschedule success", o, caseId, connector);
  });

  it("K - reschedule whose new booking fails leaves A untouched", async () => {
    const o = await org();
    const connector = mock();
    const { appointment } = await bookedReferral(o, connector);
    connector.destination.script("appointment.reschedule", ["permanent"]);
    const change = await ok(
      o.manager,
      "POST",
      `/v1/appointments/${appointment.id}/actions`,
      {
        action: "reschedule",
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        expected_version: appointment.version,
        note: "move it",
        search: searchWindow(),
      },
    );
    const caseId = change.case_id as string;
    await searchAndSelect(o, connector, caseId, o.manager);
    await stepOk(o.manager, caseId, "commit");
    await drain(worker(o, connector));
    const v = await view(o.manager, caseId);
    expect(v.case.current_state).toBe("EXCEPTION");
    expect(openKinds(v)).toEqual(["CONNECTOR"]);
    expect(v.appointments).toEqual([
      expect.objectContaining({ id: appointment.id, status: "BOOKED" }),
    ]);
    const steps = await ownerPool().query(
      `SELECT o.operation,o.status,o.last_error,e.status AS execution FROM outbox o JOIN executions e ON e.id=o.execution_id
        WHERE o.case_id=$1 AND o.operation IN ('appointment.verify','appointment.reschedule.cancel_original') ORDER BY o.id`,
      [caseId],
    );
    expect(steps.rows).toEqual([
      {
        operation: "appointment.verify",
        status: "DONE",
        last_error: "NOT_ATTEMPTED",
        execution: "PERMANENT",
      },
      {
        operation: "appointment.reschedule.cancel_original",
        status: "DONE",
        last_error: "NOT_ATTEMPTED",
        execution: "PERMANENT",
      },
    ]);
    expect(
      connector.destination.calls.get("appointment.reschedule.cancel_original"),
    ).toBeUndefined();
    expect(
      [...connector.destination.appointments.values()].map((x) => x.status),
    ).toEqual(["BOOKED"]);
    await record("K", "Reschedule, new booking fails", o, caseId, connector);
  });

  it("L - reschedule whose new booking is ambiguous: A untouched until B is reconciled", async () => {
    const o = await org();
    const connector = mock();
    const { appointment } = await bookedReferral(o, connector);
    connector.destination.script("appointment.reschedule", [
      "committed-timeout",
    ]);
    const change = await ok(
      o.manager,
      "POST",
      `/v1/appointments/${appointment.id}/actions`,
      {
        action: "reschedule",
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        expected_version: appointment.version,
        note: "move it",
        search: searchWindow(),
      },
    );
    const caseId = change.case_id as string;
    await searchAndSelect(o, connector, caseId, o.manager);
    await stepOk(o.manager, caseId, "commit");
    const d = worker(o, connector);
    while (await d.tick());
    let v = await view(o.manager, caseId);
    expect(v.appointment_request.pending_execution.status).toBe("AMBIGUOUS");
    expect(v.appointments).toEqual([
      expect.objectContaining({ id: appointment.id, status: "BOOKED" }),
    ]);
    expect(
      connector.destination.calls.get("appointment.reschedule.cancel_original"),
    ).toBeUndefined();
    await drain(d);
    v = await view(o.manager, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    expect(v.appointment_request.workflow_status).toBe("COMPLETED");
    expect(
      v.appointments.find((x: { id: string }) => x.id === appointment.id)
        .status,
    ).toBe("SUPERSEDED");
    expect(connector.destination.calls.get("appointment.reschedule")).toBe(1);
    await record(
      "L",
      "Reschedule, new booking ambiguous",
      o,
      caseId,
      connector,
    );
  });

  it("M - cancelling A is ambiguous after B committed: exception says both may exist", async () => {
    const o = await org();
    const connector = mock();
    const { referralId, appointment } = await bookedReferral(o, connector);
    connector.destination.script("appointment.reschedule.cancel_original", [
      "committed-timeout",
    ]);
    const change = await ok(
      o.manager,
      "POST",
      `/v1/appointments/${appointment.id}/actions`,
      {
        action: "reschedule",
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        expected_version: appointment.version,
        note: "move it",
        search: searchWindow(),
      },
    );
    const caseId = change.case_id as string;
    await searchAndSelect(o, connector, caseId, o.manager);
    await stepOk(o.manager, caseId, "commit");
    const d = worker(o, connector);
    while (await d.tick());
    let v = await view(o.manager, caseId);
    expect(v.case.current_state).toBe("EXCEPTION");
    expect(v.case.exception_reason).toMatch(/both_appointments_may_exist/);
    expect(
      v.appointments.filter((x: { status: string }) => x.status === "BOOKED"),
    ).toHaveLength(2);
    const referral = await view(o.manager, referralId);
    expect(referral.access_status.status).toBe("NEEDS_ATTENTION");
    // Read-back settles it: A was cancelled by this execution.
    await drain(d);
    v = await view(o.manager, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    expect(openKinds(v)).toEqual([]);
    expect(
      v.appointments.find((x: { id: string }) => x.id === appointment.id),
    ).toMatchObject({
      status: "SUPERSEDED",
      cancellation_source: "RECONCILIATION",
    });
    expect(
      connector.destination.calls.get("appointment.reschedule.cancel_original"),
    ).toBe(1);
    await record("M", "Original cancellation ambiguous", o, caseId, connector);
  });

  it("M2 - unanswerable read-back escalates; a manager attests A's cancellation", async () => {
    const o = await org();
    const connector = mock({ appointments: { readbackUnavailable: true } });
    const { appointment } = await bookedReferral(o, connector);
    connector.destination.script("appointment.reschedule.cancel_original", [
      "uncommitted-timeout",
    ]);
    const change = await ok(
      o.manager,
      "POST",
      `/v1/appointments/${appointment.id}/actions`,
      {
        action: "reschedule",
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        expected_version: appointment.version,
        note: "move it",
        search: searchWindow(),
      },
    );
    const caseId = change.case_id as string;
    await searchAndSelect(o, connector, caseId, o.manager);
    await stepOk(o.manager, caseId, "commit");
    await drain(worker(o, connector));
    let v = await view(o.manager, caseId);
    expect(v.case.current_state).toBe("EXCEPTION");
    expect(v.appointment_request).toMatchObject({
      workflow_status: "ORIGINAL_CANCELLATION_PENDING",
      pending_execution: { status: "AMBIGUOUS", escalated: true },
    });
    // Coordinators cannot touch a reschedule.
    const denied = await step(
      o.coordinator,
      caseId,
      "attest_original_cancelled",
      {
        note: "checked",
      },
    );
    expect(denied.statusCode).toBe(403);
    await stepOk(o.manager, caseId, "attest_original_cancelled", {
      note: "cancelled by phone with the practice",
    });
    v = await view(o.manager, caseId);
    expect(v.case.current_state).toBe("BOOKED");
    expect(v.appointment_request.workflow_status).toBe("COMPLETED");
    expect(
      v.appointments.find((x: { id: string }) => x.id === appointment.id),
    ).toMatchObject({ status: "SUPERSEDED", cancellation_source: "STAFF" });
    await record("M2", "Escalation and attestation", o, caseId, connector);
  });

  it("N - cancellation: cancelled once; repeating the command replays it", async () => {
    const o = await org();
    const connector = mock();
    const { referralId, appointment } = await bookedReferral(o, connector);
    const body = {
      action: "cancel",
      command_id: randomUUID(),
      correlation_id: randomUUID(),
      expected_version: appointment.version,
      note: "patient cancelled",
      reason: "PATIENT_REQUEST",
    };
    const url = `/v1/appointments/${appointment.id}/actions`;
    const opened = await ok(o.manager, "POST", url, body);
    expect(await ok(o.manager, "POST", url, body)).toEqual({
      ...opened,
      deduplicated: true,
    });
    const caseId = opened.case_id as string;
    let v = await view(o.manager, caseId);
    expect(v.case.current_state).toBe("READY_FOR_BOOKING");
    expect(v.appointment_request.workflow_status).toBe(
      "CANCELLATION_REQUESTED",
    );
    // Nothing is sent until the cancellation is committed.
    expect(
      connector.destination.calls.get("appointment.cancel"),
    ).toBeUndefined();
    // A second change on the same appointment is refused meanwhile.
    const second = await send(o.manager, "POST", url, {
      ...body,
      command_id: randomUUID(),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("APPOINTMENT_CHANGE_ACTIVE");
    const commitBody = stepBody("commit", v.appointment_request.version);
    const commitUrl = `/v1/cases/${caseId}/appointment-actions`;
    const committed = await ok(o.manager, "POST", commitUrl, commitBody);
    expect(await ok(o.manager, "POST", commitUrl, commitBody)).toEqual({
      ...committed,
      deduplicated: true,
    });
    await drain(worker(o, connector));
    v = await view(o.manager, caseId);
    expect(v.case).toMatchObject({
      current_state: "CLOSED",
      resolution_code: "CANCELLED",
    });
    expect(v.appointments[0]).toMatchObject({
      status: "CANCELLED",
      cancellation_source: "CONNECTOR",
    });
    expect(connector.destination.calls.get("appointment.cancel")).toBe(1);
    // The referral's booked outcome is not rewritten: a manager reviews it.
    let referral = await view(o.manager, referralId);
    expect(referral.case.current_state).toBe("BOOKED");
    expect(openKinds(referral)).toEqual(["OUTCOME_REVIEW"]);
    expect(referral.access_status.status).toBe("NEEDS_ATTENTION");
    const review = referral.work_items.find(
      (w: { kind: string; status: string }) =>
        w.kind === "OUTCOME_REVIEW" && w.status === "OPEN",
    );
    await ok(o.manager, "POST", `/v1/cases/${referralId}/actions`, {
      action: "resolve_exception",
      command_id: randomUUID(),
      correlation_id: randomUUID(),
      expected_version: referral.case.version,
      note: "cancellation reviewed",
      work_item_id: review.id,
      resolution: "acknowledge",
    });
    referral = await view(o.manager, referralId);
    expect(referral.access_status.label).toBe("Cancelled");
    // Cancelling it again is refused: it is no longer booked.
    const again = await send(o.manager, "POST", url, {
      ...body,
      command_id: randomUUID(),
      expected_version: v.appointments[0].version,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("APPOINTMENT_NOT_BOOKED");
    await record("N", "Cancellation", o, caseId, connector);
  });

  it("O - capability withdrawn between selection and execution fails closed", async () => {
    const o = await org();
    const connector = mock();
    const referralId = await readyReferral(o, connector);
    const caseId = await startBooking(o, referralId);
    await searchAndSelect(o, connector, caseId);
    await stepOk(o.coordinator, caseId, "commit");
    // The deployment no longer enables booking: nothing is sent or emulated.
    await drain(
      worker(
        o,
        connector,
        APPOINTMENT_CAPABILITIES.filter((c) => c !== "appointment.create"),
      ),
    );
    let v = await view(o.coordinator, caseId);
    expect(v.case.current_state).toBe("EXCEPTION");
    expect(openKinds(v)).toEqual(["MANUAL_DESTINATION"]);
    expect(
      v.executions.find(
        (e: { operation: string }) => e.operation === "appointment.create",
      ),
    ).toMatchObject({
      status: "PERMANENT",
      last_error: "UNSUPPORTED_OPERATION",
    });
    expect(
      connector.destination.calls.get("appointment.create"),
    ).toBeUndefined();
    // The destination withdrawing it mid-flight is refused the same way.
    const second = await startBooking(o, await readyReferral(o, connector));
    connector.destination.script("appointment.create", [
      "capability-withdrawn",
    ]);
    await searchAndSelect(o, connector, second);
    await stepOk(o.coordinator, second, "commit");
    await drain(worker(o, connector));
    v = await view(o.coordinator, second);
    expect(v.case.current_state).toBe("EXCEPTION");
    expect(v.case.exception_reason).toMatch(/capability_withdrawn/);
    expect(v.appointments).toEqual([]);
    expect(connector.destination.appointmentWrites()).toBe(0);
    await record("O", "Capability withdrawn", o, caseId, connector);
  });

  it("P - tenant attack: another organisation's cases and appointments are unreachable", async () => {
    const o = await org();
    const other = await org();
    const connector = mock();
    const { referralId, caseId, appointment } = await bookedReferral(
      o,
      connector,
    );
    for (const [method, url, payload] of [
      ["GET", `/v1/cases/${caseId}`, undefined],
      ["GET", `/v1/appointments/${appointment.id}`, undefined],
      [
        "POST",
        `/v1/cases/${caseId}/appointment-actions`,
        stepBody("withdraw", 0, { note: "attack" }),
      ],
      [
        "POST",
        `/v1/appointments/${appointment.id}/actions`,
        {
          action: "confirm",
          command_id: randomUUID(),
          correlation_id: randomUUID(),
          expected_version: appointment.version,
          method: "PHONE",
        },
      ],
      [
        "POST",
        `/v1/cases/${referralId}/actions`,
        {
          action: "start_booking",
          command_id: randomUUID(),
          correlation_id: randomUUID(),
          expected_version: 0,
          note: "attack",
          search: searchWindow(),
        },
      ],
    ] as const) {
      const res = await send(
        other.manager,
        method,
        url,
        payload as object | undefined,
      );
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // A browser-supplied tenant selects nothing the caller is not a member of.
    const forged = await send(
      { ...other.manager, "x-access-tenant": o.tenant },
      "GET",
      `/v1/cases/${caseId}`,
    );
    expect(forged.statusCode).toBe(403);
    // No reference can be bound across organisations, even by the owner.
    const foreignCase = randomUUID();
    await ownerPool().query(
      "INSERT INTO access_cases(id,tenant_id,case_type,source_channel,current_state,opened_at) VALUES($1,$2,'CANCELLATION_REQUEST','API','RECEIVED',now())",
      [foreignCase, other.tenant],
    );
    await expect(
      ownerPool().query(
        `INSERT INTO appointment_requests(tenant_id,case_id,case_type,original_appointment_id,booking_context,timezone,
                                          workflow_status,cancellation_reason)
         VALUES($1,$2,'CANCELLATION_REQUEST',$3,'{}'::jsonb,'UTC','CANCELLATION_REQUESTED','ADMINISTRATIVE')`,
        [other.tenant, foreignCase, appointment.id],
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      ownerPool().query(
        "UPDATE appointments SET tenant_id=$1,version=version+1 WHERE id=$2",
        [other.tenant, appointment.id],
      ),
    ).rejects.toThrow(/identity is immutable/);
    const v = await view(o.manager, caseId);
    expect(v.appointments[0].confirmation_status).toBe("UNCONFIRMED");
    await record("P", "Tenant attack", o, caseId, connector);
  });

  it("Q - role attack: read-only and coordinator limits are enforced server-side", async () => {
    const o = await org();
    const connector = mock();
    const { referralId, caseId, appointment } = await bookedReferral(
      o,
      connector,
    );
    const readOnlyWrites = [
      [`/v1/cases/${caseId}/appointment-actions`, stepBody("recheck", 0)],
      [
        `/v1/appointments/${appointment.id}/actions`,
        {
          action: "confirm",
          command_id: randomUUID(),
          correlation_id: randomUUID(),
          expected_version: appointment.version,
          method: "PHONE",
        },
      ],
      [
        `/v1/cases/${referralId}/actions`,
        {
          action: "start_booking",
          command_id: randomUUID(),
          correlation_id: randomUUID(),
          expected_version: 0,
          note: "x",
          search: searchWindow(),
        },
      ],
    ] as const;
    for (const [url, payload] of readOnlyWrites) {
      // A role claim from the browser is ignored: membership decides.
      const res = await send(
        { ...o.readOnly, "x-access-role": "ADMIN" },
        "POST",
        url,
        payload,
      );
      expect(res.statusCode, url).toBe(403);
    }
    for (const action of ["reschedule", "cancel"]) {
      const res = await send(
        o.coordinator,
        "POST",
        `/v1/appointments/${appointment.id}/actions`,
        {
          action,
          command_id: randomUUID(),
          correlation_id: randomUUID(),
          expected_version: appointment.version,
          note: "not allowed",
          ...(action === "reschedule"
            ? { search: searchWindow() }
            : { reason: "ADMINISTRATIVE" }),
        },
      );
      expect(res.statusCode, action).toBe(403);
    }
    // Read-only staff can still read the booking.
    const read = await ok(o.readOnly, "GET", `/v1/cases/${caseId}`);
    expect(read.appointment_request.workflow_status).toBe("BOOKED");
    expect(
      connector.destination.calls.get("appointment.cancel"),
    ).toBeUndefined();
    await record("Q", "Role attack", o, caseId, connector);
  });

  it("R - restart recovery: holds, pending, ambiguous and cancellation work survive", async () => {
    const o = await org();
    const connector = mock();
    // 1. An active hold.
    const held = await startBooking(o, await readyReferral(o, connector));
    await searchAndSelect(o, connector, held);
    await stepOk(o.coordinator, held, "hold");
    // 2. A booking submitted but never dispatched.
    const pending = await startBooking(o, await readyReferral(o, connector));
    // 3. A booking whose outcome became ambiguous.
    const ambiguous = await startBooking(o, await readyReferral(o, connector));
    // 4. A cancellation submitted.
    const booked = await bookedReferral(o, connector);
    const d1 = worker(o, connector);
    await drain(d1);
    await searchAndSelect(o, connector, pending, o.coordinator, 1);
    await searchAndSelect(o, connector, ambiguous, o.coordinator, 2);
    await stepOk(o.coordinator, pending, "commit");
    await stepOk(o.coordinator, ambiguous, "commit");
    const cancel = await ok(
      o.manager,
      "POST",
      `/v1/appointments/${booked.appointment.id}/actions`,
      {
        action: "cancel",
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        expected_version: booked.appointment.version,
        note: "patient cancelled",
        reason: "PATIENT_REQUEST",
      },
    );
    await stepOk(o.manager, cancel.case_id, "commit");
    // The old worker sends the pending booking and dies before recording it.
    const claimed = await ownerPool().query(
      "SELECT id,execution_id,payload FROM outbox WHERE case_id=$1 AND operation='appointment.create'",
      [pending],
    );
    await connector.execute(claimed.rows[0].payload);
    // It also dispatched the ambiguous booking, whose response was lost.
    const ambiguousRow = await ownerPool().query(
      "SELECT id FROM outbox WHERE case_id=$1 AND operation='appointment.create'",
      [ambiguous],
    );
    await ownerPool().query(
      "UPDATE outbox SET available_at=now()+interval '1 hour' WHERE tenant_id=$1 AND status='PENDING' AND id<>$2",
      [o.tenant, ambiguousRow.rows[0].id],
    );
    connector.destination.script("appointment.create", ["committed-timeout"]);
    while (await d1.tick());
    expect(
      (
        await ownerPool().query(
          "SELECT e.status FROM outbox o JOIN executions e ON e.id=o.execution_id WHERE o.id=$1",
          [ambiguousRow.rows[0].id],
        )
      ).rows[0].status,
    ).toBe("AMBIGUOUS");
    // The pending booking's claim outlives its worker: the lease lapses.
    await ownerPool().query(
      "UPDATE outbox SET status='LEASED',lease_until=now()-interval '1 minute',attempts=1,available_at=now() WHERE id=$1",
      [claimed.rows[0].id],
    );
    await ownerPool().query(
      "UPDATE outbox SET available_at=now() WHERE tenant_id=$1 AND status='PENDING'",
      [o.tenant],
    );
    // A new worker process (new dispatcher, same destination) finishes all.
    const d2 = worker(o, connector);
    await drain(d2);
    await d2.sweepAppointments();
    expect((await view(o.coordinator, pending)).case.current_state).toBe(
      "BOOKED",
    );
    expect((await view(o.coordinator, ambiguous)).case.current_state).toBe(
      "BOOKED",
    );
    expect((await view(o.manager, cancel.case_id)).case.current_state).toBe(
      "CLOSED",
    );
    const h = await request(o.coordinator, held);
    expect(h.workflow_status).toBe("HELD");
    await stepOk(o.coordinator, held, "commit");
    await drain(d2);
    expect((await view(o.coordinator, held)).case.current_state).toBe("BOOKED");
    // One foreign appointment per booking, whatever was re-sent.
    for (const caseId of [held, pending, ambiguous]) {
      const create = await ownerPool().query(
        "SELECT id FROM executions WHERE case_id=$1 AND operation='appointment.create' AND status='SUCCEEDED'",
        [caseId],
      );
      expect(create.rowCount, caseId).toBe(1);
      expect(
        connector.destination.effects.get(create.rows[0].id),
        caseId,
      ).toHaveLength(1);
    }
    const lost = await ownerPool().query(
      `SELECT count(*)::int AS n FROM appointment_requests
        WHERE tenant_id=$1 AND workflow_status NOT IN ('BOOKED','CANCELLED','COMPLETED','WITHDRAWN')`,
      [o.tenant],
    );
    expect(lost.rows[0].n).toBe(0);
    await record("R", "Restart recovery", o, pending, connector);
  });

  it("S - booking metrics keep provenance: counts observed, rates derived, no denominator unknown", async () => {
    const o = await org();
    const connector = mock();
    const period = () => {
      const now = Date.now();
      return `from=${new Date(now - 3600_000).toISOString()}&to=${new Date(now + 3600_000).toISOString()}`;
    };
    // Nothing booked yet: rates are unknown, never zero.
    let cohort = await ok(o.manager, "GET", `/v1/metrics/cohort?${period()}`);
    expect(cohort.booking.booking_requests).toMatchObject({
      value: 0,
      provenance: "OBSERVED",
    });
    expect(cohort.booking.booking_attempts_per_booked).toMatchObject({
      value: null,
      provenance: "UNKNOWN",
    });
    expect(cohort.booking.ready_to_booked_conversion.provenance).toBe(
      "UNKNOWN",
    );
    // One booking rescheduled, one booked then cancelled, one abandoned.
    const first = await bookedReferral(o, connector);
    const reschedule = await ok(
      o.manager,
      "POST",
      `/v1/appointments/${first.appointment.id}/actions`,
      {
        action: "reschedule",
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        expected_version: first.appointment.version,
        note: "another day",
        search: searchWindow(),
      },
    );
    await searchAndSelect(o, connector, reschedule.case_id, o.manager);
    await stepOk(o.manager, reschedule.case_id, "commit");
    await drain(worker(o, connector));
    const second = await bookedReferral(o, connector);
    const cancel = await ok(
      o.manager,
      "POST",
      `/v1/appointments/${second.appointment.id}/actions`,
      {
        action: "cancel",
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        expected_version: second.appointment.version,
        note: "patient cancelled",
        reason: "PATIENT_REQUEST",
      },
    );
    await stepOk(o.manager, cancel.case_id, "commit");
    await drain(worker(o, connector));
    const abandoned = await startBooking(o, await readyReferral(o, connector));
    await searchAndSelect(o, connector, abandoned);
    await stepOk(o.coordinator, abandoned, "withdraw", {
      note: "patient will call back",
    });
    cohort = await ok(o.manager, "GET", `/v1/metrics/cohort?${period()}`);
    const b = cohort.booking;
    expect(b.booking_requests).toMatchObject({
      value: 3,
      provenance: "OBSERVED",
    });
    expect(b.booked_by_access.value).toBe(2);
    expect(b.abandoned_booking_requests.value).toBe(1);
    expect(b.reschedules_completed.value).toBe(1);
    expect(b.cancellations_completed.value).toBe(1);
    expect(b.ambiguous_appointment_writes).toMatchObject({
      value: 0,
      provenance: "OBSERVED",
    });
    expect(b.ready_to_booked_conversion).toMatchObject({
      value: 1,
      provenance: "DERIVED",
      inputs: { numerator: 2, denominator: 2 },
    });
    expect(b.median_ready_to_booked_seconds.provenance).toBe("DERIVED");
    expect(b.median_ready_to_booked_seconds.inputs).toEqual({ samples: 2 });
    expect(b.booking_attempts_per_booked).toMatchObject({
      value: 1,
      provenance: "DERIVED",
    });
    expect(b.availability_searches_per_booked).toMatchObject({
      value: 1.5,
      inputs: { numerator: 3, denominator: 2 },
    });
    expect(b.selection_to_booking_success).toMatchObject({
      value: 0.6667,
      inputs: { numerator: 2, denominator: 3 },
    });
    expect(b.interventions_per_booking_request.provenance).toBe("DERIVED");
    // The referral funnel still counts referrals only.
    expect(cohort.referrals_received.value).toBe(3);
    report.push({
      scenario: "S",
      title: "Booking metrics",
      passed: true,
      request_states: [],
      workflow_status: null,
      evidence_valid: null,
      destination_appointments: connector.destination.appointmentWrites(),
      notes: {
        booking: Object.fromEntries(
          Object.entries(b).map(([k, v]) => [
            k,
            {
              value: (v as { value: unknown }).value,
              provenance: (v as { provenance: string }).provenance,
            },
          ]),
        ),
      },
    });
  });
});
