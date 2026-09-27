import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  CapabilityGate,
  NoConnector,
} from "../../apps/worker/src/connector.js";
import { Dispatcher } from "../../apps/worker/src/dispatcher.js";
import {
  b64,
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
  workerPool,
  type TestApi,
} from "../support/harness.js";

/**
 * Synthetic end-to-end qualification (Flows A-I). Every flow runs through the
 * real HTTP API with signed workforce JWTs and membership-derived tenancy,
 * the least-privilege database roles, and the worker dispatcher.
 */
interface FlowReport {
  flow: string;
  title: string;
  passed: boolean;
  states: string[];
  evidence_valid: boolean | null;
  notes: Record<string, unknown>;
}
const report: FlowReport[] = [];

describe.runIf(databaseEnabled)("synthetic end-to-end qualification", () => {
  let t: TestApi;
  let tenant: string;
  let manualTenant: string;
  let coordinator: Record<string, string>;
  let manager: Record<string, string>;
  let manualCoordinator: Record<string, string>;

  beforeAll(async () => {
    t = await testApi({ auth: "jwt" });
    tenant = await newTenant({ destinationMode: "CONNECTOR" });
    manualTenant = await newTenant({ destinationMode: "MANUAL" });
    const users = {
      coordinator: randomUUID(),
      manager: randomUUID(),
      manual: randomUUID(),
    };
    await grantMembership(tenant, users.coordinator, "REFERRAL_COORDINATOR");
    await grantMembership(tenant, users.manager, "PRACTICE_MANAGER");
    await grantMembership(manualTenant, users.manual, "REFERRAL_COORDINATOR");
    coordinator = {
      authorization: `Bearer ${await mintToken(users.coordinator)}`,
    };
    manager = { authorization: `Bearer ${await mintToken(users.manager)}` };
    manualCoordinator = {
      authorization: `Bearer ${await mintToken(users.manual)}`,
    };
  });
  afterAll(async () => {
    await t.close();
    await closePools();
    if (process.env.QUALIFICATION_REPORT)
      await writeFile(
        process.env.QUALIFICATION_REPORT,
        JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            postgres: process.env.PG_VERSION ?? null,
            flows: report,
          },
          null,
          2,
        ),
      );
  });

  const post = async (
    headers: Record<string, string>,
    url: string,
    payload: object,
  ) => {
    const res = await t.app.inject({ method: "POST", url, headers, payload });
    if (res.statusCode >= 300)
      throw new Error(`${url} -> ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const get = async (headers: Record<string, string>, url: string) => {
    const res = await t.app.inject({ method: "GET", url, headers });
    if (res.statusCode >= 300)
      throw new Error(`${url} -> ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const upload = (
    headers: Record<string, string>,
    overrides: Record<string, unknown> = {},
  ) =>
    post(headers, "/v1/referrals", {
      ...ingestBody(overrides),
      tenant_id: undefined,
    });
  const action = async (
    headers: Record<string, string>,
    caseId: string,
    name: string,
    extra: Record<string, unknown> = {},
  ) => {
    const view = await get(headers, `/v1/cases/${caseId}`);
    return post(headers, `/v1/cases/${caseId}/actions`, {
      action: name,
      command_id: randomUUID(),
      correlation_id: randomUUID(),
      expected_version: view.case.version,
      note: `qualification ${name}`,
      staff_seconds: 60,
      ...extra,
    });
  };
  const trace = async (headers: Record<string, string>, caseId: string) => {
    const view = await get(headers, `/v1/cases/${caseId}`);
    return {
      view,
      states: view.transitions.map(
        (x: { to_state: string }) => x.to_state,
      ) as string[],
    };
  };
  const record = async (
    flow: string,
    title: string,
    headers: Record<string, string>,
    caseId: string,
    notes: Record<string, unknown> = {},
  ) => {
    const { view, states } = await trace(headers, caseId);
    report.push({
      flow,
      title,
      passed: true,
      states,
      evidence_valid: view.evidence.verification.valid,
      notes,
    });
    return { view, states };
  };

  it("Flow A - happy path to BOOKED via connector readback, with metrics", async () => {
    const r = await upload(coordinator);
    const connector = mock({ appointmentOutcome: "BOOKED" });
    const d = dispatcher([tenant], connector);
    await drain(d);
    await ownerPool().query(
      "UPDATE referrals SET outcome_next_poll_at=now() WHERE case_id=$1",
      [r.case_id],
    );
    expect(await d.pollOutcomes()).toBe(1);
    const { view, states } = await record(
      "A",
      "Happy path",
      coordinator,
      r.case_id,
    );
    expect(states).toEqual([
      "RECEIVED",
      "DESTINATION_PENDING",
      "READY_FOR_BOOKING",
      "BOOKED",
    ]);
    expect(view.case.resolution_code).toBe("BOOKED");
    expect(view.metrics.received_to_booked_seconds.provenance).toBe("DERIVED");
    expect(view.metrics.received_to_verified_seconds.provenance).toBe(
      "DERIVED",
    );
    expect(view.evidence.verification.valid).toBe(true);
  });

  it("Flow B - missing information completed by a second interaction", async () => {
    const r = await upload(coordinator, { fixture: "missing-insurance" });
    expect(r.state).toBe("INFORMATION_MISSING");
    const before = await get(coordinator, `/v1/cases/${r.case_id}`);
    expect(
      before.work_items
        .filter((w: { status: string }) => w.status === "OPEN")
        .map((w: { kind: string }) => w.kind),
    ).toEqual(["COMPLETENESS"]);
    await post(coordinator, `/v1/cases/${r.case_id}/interactions`, {
      command_id: randomUUID(),
      correlation_id: randomUUID(),
      intent: "MISSING_INFORMATION",
      actor_type: "PATIENT",
      artifact: {
        filename: "medical-aid.txt",
        media_type: "text/plain",
        content_base64: b64("synthetic medical aid"),
        document_types: ["insurance"],
      },
    });
    await drain(dispatcher([tenant]));
    await action(coordinator, r.case_id, "record_booking", {
      occurred_at: new Date().toISOString(),
    });
    const { states, view } = await record(
      "B",
      "Missing information",
      coordinator,
      r.case_id,
    );
    expect(states).toEqual([
      "RECEIVED",
      "INFORMATION_MISSING",
      "DESTINATION_PENDING",
      "READY_FOR_BOOKING",
      "BOOKED",
    ]);
    expect(view.interactions).toHaveLength(2);
  });

  it("Flow C - identity review confirmed by staff", async () => {
    const r = await upload(coordinator, { fixture: "ambiguous-identity" });
    expect(r.state).toBe("IDENTITY_PENDING");
    await action(coordinator, r.case_id, "confirm_identity");
    await drain(dispatcher([tenant]));
    const { states, view } = await record(
      "C",
      "Identity review",
      coordinator,
      r.case_id,
    );
    expect(states).toEqual([
      "RECEIVED",
      "IDENTITY_PENDING",
      "DESTINATION_PENDING",
      "READY_FOR_BOOKING",
    ]);
    const verified = view.observations.find(
      (o: { observation_type: string }) =>
        o.observation_type === "REFERRAL_VERIFIED",
    );
    expect(verified).toMatchObject({
      source_type: "STAFF",
      verification_level: "HUMAN_ATTESTED",
    });
  });

  it("Flow D - manual destination entry (configured, and when the connector is unavailable)", async () => {
    const r = await upload(manualCoordinator);
    expect(r.state).toBe("READY");
    await action(manualCoordinator, r.case_id, "record_destination_reference", {
      destination_reference: "PMS-REF-1001",
    });
    const manual = await record(
      "D",
      "Manual destination (configured)",
      manualCoordinator,
      r.case_id,
    );
    expect(manual.states).toEqual(["RECEIVED", "READY", "READY_FOR_BOOKING"]);
    const committed = manual.view.observations.find(
      (o: { observation_type: string }) =>
        o.observation_type === "DESTINATION_COMMITTED",
    );
    expect(committed).toMatchObject({
      source_type: "STAFF",
      verification_level: "HUMAN_ATTESTED",
    });
    expect(manual.view.referral).toMatchObject({
      destination_reference: "PMS-REF-1001",
      destination_reference_source: "MANUAL",
    });
    expect(
      manual.view.metrics.received_to_ready_for_booking_seconds.inputs
        .end_verification,
    ).toEqual(["HUMAN_ATTESTED"]);

    const unavailable = await upload(coordinator);
    const none = new NoConnector();
    await new Dispatcher(workerPool(), none, new CapabilityGate(none, []), {
      maxDispatch: 3,
      retrySeconds: 0,
      maxReconcile: 3,
      reconcileBaseSeconds: 0,
      tenantIds: [tenant],
    }).tick();
    await action(
      coordinator,
      unavailable.case_id,
      "record_destination_reference",
      { destination_reference: "PMS-REF-1002" },
    );
    const fallback = await record(
      "D",
      "Manual destination (connector unavailable)",
      coordinator,
      unavailable.case_id,
    );
    expect(fallback.states).toEqual([
      "RECEIVED",
      "DESTINATION_PENDING",
      "EXCEPTION",
      "READY_FOR_BOOKING",
    ]);
  });

  it("Flow E - follow-up then patient unreachable", async () => {
    const r = await upload(coordinator);
    await drain(dispatcher([tenant]));
    await action(coordinator, r.case_id, "record_follow_up");
    await action(coordinator, r.case_id, "record_patient_unreachable");
    const { states, view } = await record(
      "E",
      "Patient unreachable",
      coordinator,
      r.case_id,
    );
    expect(states).toEqual([
      "RECEIVED",
      "DESTINATION_PENDING",
      "READY_FOR_BOOKING",
      "WAITING",
      "CLOSED",
    ]);
    expect(view.case.resolution_code).toBe("PATIENT_UNREACHABLE");
    expect(view.metrics.follow_up_count.value).toBe(1);
    expect(view.metrics.booking_conversion).toMatchObject({ value: false });
  });

  it("Flow F - patient declined", async () => {
    const r = await upload(coordinator);
    await drain(dispatcher([tenant]));
    await action(coordinator, r.case_id, "record_patient_declined");
    const { states, view } = await record(
      "F",
      "Patient declined",
      coordinator,
      r.case_id,
    );
    expect(states).toEqual([
      "RECEIVED",
      "DESTINATION_PENDING",
      "READY_FOR_BOOKING",
      "CLOSED",
    ]);
    expect(view.case.resolution_code).toBe("PATIENT_DECLINED");
  });

  it("Flow G - technical ambiguity resolved by read-back", async () => {
    const r = await upload(coordinator);
    const connector = mock({
      fault: "committed-timeout",
      idempotent: false,
      reconcileAmbiguousPolls: 1,
    });
    const d = dispatcher([tenant], connector, { maxReconcile: 4 });
    await d.tick();
    await d.reconcile();
    await d.reconcile();
    const { states, view } = await record(
      "G",
      "Technical ambiguity",
      coordinator,
      r.case_id,
      {
        foreign_writes: connector.foreignWrites(),
      },
    );
    expect(states).toEqual([
      "RECEIVED",
      "DESTINATION_PENDING",
      "READY_FOR_BOOKING",
    ]);
    expect(view.executions[0]).toMatchObject({
      status: "SUCCEEDED",
      reconcile_attempts: 2,
    });
    expect(connector.foreignWrites()).toBe(1);
  });

  it("Flow H - persistent ambiguity escalates to a staff work item", async () => {
    const r = await upload(coordinator);
    const connector = mock({ fault: "uncommitted-timeout" });
    const d = dispatcher([tenant], connector, { maxReconcile: 3 });
    await d.tick();
    for (let i = 0; i < 5; i++) await d.reconcile();
    const { states, view } = await record(
      "H",
      "Persistent ambiguity",
      coordinator,
      r.case_id,
    );
    expect(states).toEqual(["RECEIVED", "DESTINATION_PENDING", "EXCEPTION"]);
    expect(
      view.work_items
        .filter((w: { status: string }) => w.status === "OPEN")
        .map((w: { kind: string }) => w.kind),
    ).toEqual(["CONNECTOR"]);
    expect(view.executions[0].escalated_at).not.toBeNull();
    expect(connector.executeCalls.get(r.execution_id)).toBe(1);
  });

  it("Flow I - tenant A never observes tenant B data", async () => {
    const other = await upload(manualCoordinator);
    const probes = [
      await t.app.inject({
        method: "GET",
        url: `/v1/cases/${other.case_id}`,
        headers: coordinator,
      }),
      await t.app.inject({
        method: "GET",
        url: `/v1/referrals/${other.referral_id}`,
        headers: coordinator,
      }),
      await t.app.inject({
        method: "GET",
        url: `/v1/cases/${other.case_id}`,
        headers: { ...coordinator, "x-access-tenant": manualTenant },
      }),
    ];
    expect(probes.map((p) => p.statusCode)).toEqual([404, 404, 403]);
    const queue = await get(coordinator, "/v1/cases?filter=all&limit=200");
    expect(
      queue.items.some((i: { case_id: string }) => i.case_id === other.case_id),
    ).toBe(false);
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const a = await get(
      coordinator,
      `/v1/metrics/cohort?from=${from}&to=${to}`,
    );
    const b = await get(
      manualCoordinator,
      `/v1/metrics/cohort?from=${from}&to=${to}`,
    );
    expect(a.referrals_received.value + b.referrals_received.value).toBe(
      (
        await ownerPool().query(
          "SELECT count(*)::int n FROM access_cases WHERE tenant_id = ANY($1)",
          [[tenant, manualTenant]],
        )
      ).rows[0].n,
    );
    report.push({
      flow: "I",
      title: "Cross tenant",
      passed: true,
      states: [],
      evidence_valid: null,
      notes: {
        probes: probes.map((p) => p.statusCode),
        tenant_a_received: a.referrals_received.value,
        tenant_b_received: b.referrals_received.value,
      },
    });
  });

  it("dashboard metrics for the qualification cohort are produced with provenance", async () => {
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const m = await get(manager, `/v1/metrics/cohort?from=${from}&to=${to}`);
    expect(m.referrals_received).toMatchObject({ provenance: "OBSERVED" });
    expect(m.booked.value).toBeGreaterThanOrEqual(2);
    expect(m.booking_conversion_rate.provenance).toBe("DERIVED");
    expect(
      m.top_closure_reasons.map((c: { code: string }) => c.code).sort(),
    ).toEqual(["PATIENT_DECLINED", "PATIENT_UNREACHABLE"]);
    expect(m.human_touches_per_referral.provenance).toBe("DERIVED");
    expect(m.staff_seconds_per_referral.provenance).toBe("UNKNOWN");
    report.push({
      flow: "metrics",
      title: "Cohort dashboard",
      passed: true,
      states: [],
      evidence_valid: null,
      notes: m,
    });
  });
});
