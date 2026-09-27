import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  ConfigError,
  loadApiConfig,
  loadWorkerConfig,
} from "../../packages/config/src/index.js";
import {
  evaluateReferralRules,
  parseRuleDefinition,
  definitionHash,
} from "../../packages/rules/src/index.js";
import {
  tenantTx,
  verifyEvidenceChain,
  verifyRuntimeIdentity,
} from "../../packages/db/src/index.js";
import {
  act,
  actionBody,
  apiPool,
  b64,
  caseState,
  closePools,
  countFiles,
  databaseEnabled,
  detail,
  dispatcher,
  drain,
  grantMembership,
  ingest,
  ingestBody,
  mintToken,
  mock,
  newTenant,
  ownerPool,
  ruleDefinition,
  staff,
  tableCounts,
  testApi,
  workerPool,
  type TestApi,
} from "../support/harness.js";

describe.runIf(databaseEnabled)("ACCESS v1.1 acceptance suite", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await testApi();
  });
  afterAll(async () => {
    await t.close();
    await closePools();
  });
  const bookable = async (tenant: string) => {
    const r = await ingest(t, tenant);
    await drain(dispatcher([tenant]));
    return { ...r, ...(await caseState(r.case_id)) };
  };
  const importRow = (tenant: string, rows: object[]) =>
    t.app.inject({
      method: "POST",
      url: "/v1/observations/import",
      headers: staff(tenant, "PRACTICE_MANAGER", "manager"),
      payload: {
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        source_label: "pms-weekly-export",
        rows,
      },
    });

  it("01 two interactions attach to one access case safely", async () => {
    const tenant = await newTenant();
    const r = await ingest(t, tenant, { fixture: "missing-insurance" });
    expect(r.state).toBe("INFORMATION_MISSING");
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/cases/${r.case_id}/interactions`,
      headers: staff(tenant),
      payload: {
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        intent: "MISSING_INFORMATION",
        actor_type: "STAFF",
        expected_version: r.version,
        artifact: {
          filename: "insurance.txt",
          media_type: "text/plain",
          content_base64: b64("synthetic insurance"),
          document_types: ["insurance"],
        },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().state).toBe("DESTINATION_PENDING");
    const d = await detail(t, tenant, r.case_id);
    expect(d.interactions.map((i: { intent: string }) => i.intent)).toEqual([
      "NEW_REFERRAL",
      "MISSING_INFORMATION",
    ]);
    expect(new Set(d.interactions.map((i: { id: string }) => i.id)).size).toBe(
      2,
    );
    expect((await tableCounts(tenant)).access_cases).toBe(1);
  });

  it("02 retries cannot create duplicate access cases", async () => {
    const tenant = await newTenant();
    const body = ingestBody();
    const first = await t.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: staff(tenant),
      payload: body,
    });
    const retry = await t.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: staff(tenant),
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ...first.json(), deduplicated: true });
    const newCommandSameReferral = await t.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: staff(tenant),
      payload: { ...body, command_id: randomUUID() },
    });
    expect(newCommandSameReferral.statusCode).toBe(409);
    const sameIdempotencyKey = await t.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: staff(tenant),
      payload: { ...ingestBody({ idempotency_key: "portal-upload-0001" }) },
    });
    const replayedKey = await t.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: staff(tenant),
      payload: { ...ingestBody({ idempotency_key: "portal-upload-0001" }) },
    });
    expect(sameIdempotencyKey.statusCode).toBe(201);
    expect(replayedKey.statusCode).toBe(409);
    expect((await tableCounts(tenant)).access_cases).toBe(2);
  });

  it("03 one referral maps to exactly one case", async () => {
    const tenant = await newTenant();
    const r = await ingest(t, tenant);
    const counts = await ownerPool().query(
      "SELECT count(*)::int n, count(DISTINCT case_id)::int cases FROM referrals WHERE tenant_id=$1",
      [tenant],
    );
    expect(counts.rows[0]).toEqual({ n: 1, cases: 1 });
    await expect(
      ownerPool().query(
        "INSERT INTO referrals(id,tenant_id,case_id) VALUES($1,$2,$3)",
        [randomUUID(), tenant, r.case_id],
      ),
    ).rejects.toThrow(/referrals_one_per_case/);
  });

  it("04 a case remains open after destination commit", async () => {
    const tenant = await newTenant();
    const c = await bookable(tenant);
    const row = await ownerPool().query(
      "SELECT resolved_at,resolution_code FROM access_cases WHERE id=$1",
      [c.case_id],
    );
    expect(row.rows[0]).toEqual({ resolved_at: null, resolution_code: null });
  });

  it("05 destination success moves the case to READY_FOR_BOOKING, not completion", async () => {
    const tenant = await newTenant();
    const c = await bookable(tenant);
    expect(c.current_state).toBe("READY_FOR_BOOKING");
    const d = await detail(t, tenant, c.case_id);
    expect(d.executions[0].status).toBe("SUCCEEDED");
    expect(
      d.observations.map(
        (o: { observation_type: string }) => o.observation_type,
      ),
    ).toContain("DESTINATION_COMMITTED");
    expect(d.metrics.booking_conversion).toMatchObject({
      value: null,
      provenance: "UNKNOWN",
    });
  });

  it("06 a booking outcome completes the case", async () => {
    const tenant = await newTenant();
    const c = await bookable(tenant);
    const res = await act(
      t,
      tenant,
      c.case_id,
      actionBody("record_booking", c.version, {
        occurred_at: new Date().toISOString(),
        appointment_reference: "APPT-1",
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const row = await ownerPool().query(
      "SELECT current_state,resolution_code,resolution_source,resolved_at,outcome_at FROM access_cases WHERE id=$1",
      [c.case_id],
    );
    expect(row.rows[0]).toMatchObject({
      current_state: "BOOKED",
      resolution_code: "BOOKED",
      resolution_source: "STAFF",
    });
    expect(row.rows[0].resolved_at).not.toBeNull();
  });

  it("07 deliberate closure requires a resolution code", async () => {
    const tenant = await newTenant();
    const c = await bookable(tenant);
    const missing = await act(
      t,
      tenant,
      c.case_id,
      actionBody("close", c.version),
    );
    expect(missing.statusCode).toBe(400);
    const booked = await act(
      t,
      tenant,
      c.case_id,
      actionBody("close", c.version, { resolution_code: "BOOKED" }),
    );
    expect(booked.statusCode).toBe(422);
    await expect(
      ownerPool().query(
        "UPDATE access_cases SET current_state='CLOSED',version=version+1 WHERE id=$1",
        [c.case_id],
      ),
    ).rejects.toThrow(/case_resolution_complete/);
    const ok = await act(
      t,
      tenant,
      c.case_id,
      actionBody("close", c.version, { resolution_code: "REFERRED_ELSEWHERE" }),
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await caseState(c.case_id)).resolution_code).toBe(
      "REFERRED_ELSEWHERE",
    );
  });

  it("08 late booking observations cannot regress a terminal case", async () => {
    const tenant = await newTenant();
    const c = await bookable(tenant);
    const bookedAt = new Date();
    await act(
      t,
      tenant,
      c.case_id,
      actionBody("record_booking", c.version, {
        occurred_at: bookedAt.toISOString(),
      }),
    );
    const booked = await caseState(c.case_id);
    const earlier = await importRow(tenant, [
      {
        case_id: c.case_id,
        observation_type: "BOOKING_REQUESTED",
        occurred_at: new Date(bookedAt.getTime() - 60_000).toISOString(),
        source_reference: "pms:req-1",
      },
      {
        case_id: c.case_id,
        observation_type: "PATIENT_UNREACHABLE",
        occurred_at: new Date(bookedAt.getTime() - 30_000).toISOString(),
        source_reference: "pms:unreach-1",
      },
    ]);
    expect(earlier.statusCode, earlier.body).toBe(200);
    expect(
      earlier.json().results.map((r: { disposition: string }) => r.disposition),
    ).toEqual(["RECORDED", "RECORDED"]);
    const later = await importRow(tenant, [
      {
        case_id: c.case_id,
        observation_type: "PATIENT_DECLINED",
        occurred_at: new Date(bookedAt.getTime() + 1000).toISOString(),
        source_reference: "pms:decl-1",
      },
    ]);
    expect(later.json().results[0].disposition).toBe("REVIEW");
    const after = await caseState(c.case_id);
    expect(after).toEqual(booked);
    const review = await ownerPool().query(
      "SELECT count(*)::int n FROM work_items WHERE case_id=$1 AND kind='OUTCOME_REVIEW' AND status='OPEN'",
      [c.case_id],
    );
    expect(review.rows[0].n).toBe(1);
  });

  it("09 duplicate outcome observations are idempotent", async () => {
    const tenant = await newTenant();
    const c = await bookable(tenant);
    const row = {
      case_id: c.case_id,
      observation_type: "APPOINTMENT_BOOKED",
      occurred_at: new Date().toISOString(),
      source_reference: "pms:appt-77",
    };
    const first = await importRow(tenant, [row]);
    const again = await importRow(tenant, [row]);
    expect(first.json().results[0]).toMatchObject({
      disposition: "APPLIED",
      deduplicated: false,
    });
    expect(again.json().results[0]).toMatchObject({
      deduplicated: true,
      observation_id: first.json().results[0].observation_id,
    });
    const n = await ownerPool().query(
      "SELECT count(*)::int n FROM access_case_observations WHERE case_id=$1 AND observation_type='APPOINTMENT_BOOKED'",
      [c.case_id],
    );
    expect(n.rows[0].n).toBe(1);
    expect((await caseState(c.case_id)).current_state).toBe("BOOKED");
  });

  it("10 unknown outcomes remain unknown", async () => {
    const tenant = await newTenant();
    const c = await bookable(tenant);
    await act(
      t,
      tenant,
      c.case_id,
      actionBody("close", c.version, { resolution_code: "UNKNOWN" }),
    );
    const d = await detail(t, tenant, c.case_id);
    expect(d.metrics.booking_conversion).toMatchObject({
      value: null,
      provenance: "UNKNOWN",
    });
    expect(d.metrics.closure_reason).toMatchObject({
      value: "UNKNOWN",
      provenance: "UNKNOWN",
    });
    const cohort = await t.app.inject({
      method: "GET",
      url: `/v1/metrics/cohort?from=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`,
      headers: staff(tenant),
    });
    const m = cohort.json();
    expect(m.closed_unknown_outcome.value).toBe(1);
    expect(m.closed_without_booking.value).toBe(0);
    expect(m.booking_conversion_rate).toMatchObject({
      value: null,
      provenance: "UNKNOWN",
    });
  });

  it("11 booking conversion is reproducible from source observations", async () => {
    const tenant = await newTenant();
    const cases = await Promise.all(
      [1, 2, 3, 4, 5].map(() => ingest(t, tenant)),
    );
    await drain(dispatcher([tenant]), 40);
    const [a, b, c2, d2] = await Promise.all(
      cases.map((c) => caseState(c.case_id)),
    );
    await act(
      t,
      tenant,
      cases[0]!.case_id,
      actionBody("record_booking", a!.version, {
        occurred_at: new Date().toISOString(),
      }),
    );
    await act(
      t,
      tenant,
      cases[1]!.case_id,
      actionBody("record_booking", b!.version, {
        occurred_at: new Date().toISOString(),
      }),
    );
    await act(
      t,
      tenant,
      cases[2]!.case_id,
      actionBody("record_patient_declined", c2!.version),
    );
    await act(
      t,
      tenant,
      cases[3]!.case_id,
      actionBody("close", d2!.version, { resolution_code: "UNKNOWN" }),
    );
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const m = (
      await t.app.inject({
        method: "GET",
        url: `/v1/metrics/cohort?from=${from}&to=${to}`,
        headers: staff(tenant),
      })
    ).json();
    expect(m.booking_conversion_rate).toMatchObject({
      value: 0.6667,
      provenance: "DERIVED",
      inputs: { numerator: 2, denominator: 3 },
    });
    expect(m.cohort_booking_rate.value).toBe(0.4);
    expect(m.still_open.value).toBe(1);
    // Independent recomputation straight from the observation facts.
    const independent = await ownerPool().query(
      `SELECT count(*) FILTER (WHERE o.observation_type='APPOINTMENT_BOOKED' AND o.disposition='APPLIED')::int booked,
              count(*) FILTER (WHERE o.observation_type IN ('PATIENT_DECLINED','PATIENT_UNREACHABLE','PROVIDER_DECLINED')
                               OR (o.observation_type='REFERRAL_CLOSED' AND o.payload->>'resolution_code' <> 'UNKNOWN'))::int closed
         FROM access_case_observations o WHERE o.tenant_id=$1 AND o.disposition='APPLIED'`,
      [tenant],
    );
    const { booked, closed } = independent.rows[0];
    expect(Math.round((booked / (booked + closed)) * 10_000) / 10_000).toBe(
      m.booking_conversion_rate.value,
    );
  });

  it("12 received-to-booked duration is reproducible", async () => {
    const tenant = await newTenant();
    const c = await bookable(tenant);
    const opened = (
      await ownerPool().query(
        "SELECT opened_at FROM access_cases WHERE id=$1",
        [c.case_id],
      )
    ).rows[0].opened_at as Date;
    const occurred = new Date(opened.getTime() + 125_000);
    await ownerPool().query(
      "UPDATE access_cases SET opened_at=opened_at WHERE id=$1",
      [c.case_id],
    );
    const res = await act(
      t,
      tenant,
      c.case_id,
      actionBody("record_booking", c.version, {
        occurred_at: occurred.toISOString(),
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const d = await detail(t, tenant, c.case_id);
    expect(d.metrics.received_to_booked_seconds).toMatchObject({
      value: 125,
      provenance: "DERIVED",
    });
    const recomputed = await ownerPool().query(
      "SELECT round(extract(epoch FROM o.occurred_at - c.opened_at))::int s FROM access_case_observations o JOIN access_cases c ON c.id=o.case_id WHERE o.case_id=$1 AND o.observation_type='APPOINTMENT_BOOKED'",
      [c.case_id],
    );
    expect(recomputed.rows[0].s).toBe(125);
  });

  it("13 business metrics do not fabricate missing information", async () => {
    const tenant = await newTenant();
    const r = await ingest(t, tenant, { fixture: "ambiguous-identity" });
    const d = await detail(t, tenant, r.case_id);
    expect(d.metrics.received_to_verified_seconds).toMatchObject({
      value: null,
      provenance: "UNKNOWN",
    });
    expect(d.metrics.received_to_booked_seconds).toMatchObject({
      value: null,
      provenance: "UNKNOWN",
    });
    expect(d.metrics.staff_seconds).toMatchObject({
      value: null,
      provenance: "UNKNOWN",
    });
    const m = (
      await t.app.inject({
        method: "GET",
        url: `/v1/metrics/cohort?from=${new Date(Date.now() - 3600_000).toISOString()}&to=${new Date(Date.now() + 3600_000).toISOString()}`,
        headers: staff(tenant),
      })
    ).json();
    expect(m.median_received_to_booked_seconds).toMatchObject({
      value: null,
      provenance: "UNKNOWN",
    });
    expect(m.booking_conversion_rate.value).toBeNull();
    expect(m.staff_seconds_per_referral.value).toBeNull();
    const empty = (
      await t.app.inject({
        method: "GET",
        url: `/v1/metrics/cohort?from=2001-01-01T00:00:00Z&to=2001-01-02T00:00:00Z`,
        headers: staff(tenant),
      })
    ).json();
    expect(empty.referrals_received.value).toBe(0);
    expect(empty.exception_rate).toMatchObject({
      value: null,
      provenance: "UNKNOWN",
    });
  });

  it("14 human-attested observations are identified as such", async () => {
    const tenant = await newTenant();
    const c = await bookable(tenant);
    await act(
      t,
      tenant,
      c.case_id,
      actionBody("record_booking", c.version, {
        occurred_at: new Date().toISOString(),
      }),
    );
    const obs = await ownerPool().query(
      "SELECT source_type,verification_level,actor_id FROM access_case_observations WHERE case_id=$1 AND observation_type='APPOINTMENT_BOOKED'",
      [c.case_id],
    );
    expect(obs.rows[0]).toEqual({
      source_type: "STAFF",
      verification_level: "HUMAN_ATTESTED",
      actor_id: "synthetic:coordinator",
    });
    await expect(
      ownerPool().query(
        `INSERT INTO access_case_observations(tenant_id,case_id,observation_type,occurred_at,source_type,source_reference,verification_level,actor_id,correlation_id,disposition)
         VALUES($1,$2,'APPOINTMENT_BOOKED',now(),'STAFF','x','EXTERNAL_CONFIRMED','someone',$2,'RECORDED')`,
        [tenant, c.case_id],
      ),
    ).rejects.toThrow(/observation_staff_is_attested/);
    const committed = await ownerPool().query(
      "SELECT source_type,verification_level FROM access_case_observations WHERE case_id=$1 AND observation_type='DESTINATION_COMMITTED'",
      [c.case_id],
    );
    expect(committed.rows[0]).toEqual({
      source_type: "CONNECTOR",
      verification_level: "EXTERNAL_CONFIRMED",
    });
  });

  it("15 versioned rule decisions can be reproduced historically", async () => {
    const tenant = await newTenant();
    const old = await ingest(t, tenant, { fixture: "missing-insurance" });
    expect(old.state).toBe("INFORMATION_MISSING");
    const admin = staff(tenant, "ADMIN", "admin");
    const draft = await t.app.inject({
      method: "POST",
      url: "/v1/rule-sets",
      headers: admin,
      payload: {
        command_id: randomUUID(),
        definition: ruleDefinition({
          required_documents: ["referral_letter", "demographics"],
        }),
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const pub = await t.app.inject({
      method: "POST",
      url: `/v1/rule-sets/${draft.json().id}/publish`,
      headers: admin,
      payload: { command_id: randomUUID() },
    });
    expect(pub.statusCode, pub.body).toBe(200);
    const fresh = await ingest(t, tenant, { fixture: "missing-insurance" });
    expect(fresh.state).toBe("DESTINATION_PENDING");
    const stored = await ownerPool().query(
      "SELECT r.extraction,r.supplied_documents,r.supplied_fields,r.rule_decision,s.id,s.version,s.definition,s.definition_hash FROM referrals r JOIN access_rule_sets s ON s.id=r.rule_set_id WHERE r.case_id=$1",
      [old.case_id],
    );
    const row = stored.rows[0];
    expect(row.version).toBe(1);
    const definition = parseRuleDefinition(row.definition);
    expect(definitionHash(definition)).toBe(row.definition_hash);
    const replayed = evaluateReferralRules(
      {
        id: row.id,
        version: row.version,
        definition_hash: row.definition_hash,
        definition,
      },
      {
        extraction: row.extraction,
        supplied_documents: row.supplied_documents,
        supplied_fields: row.supplied_fields,
        identity_confirmed_by_staff: false,
      },
    );
    expect(replayed.decision_hash).toBe(row.rule_decision.decision_hash);
    expect(replayed).toEqual(row.rule_decision);
    await expect(
      ownerPool().query(
        "UPDATE access_rule_sets SET definition='{}' WHERE id=$1",
        [row.id],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("16 a retired rule set cannot be used for new cases", async () => {
    const tenant = await newTenant();
    const pending = await ingest(t, tenant, { fixture: "missing-insurance" });
    const set = (
      await ownerPool().query(
        "SELECT id FROM access_rule_sets WHERE tenant_id=$1 AND status='ACTIVE'",
        [tenant],
      )
    ).rows[0].id;
    const retire = await t.app.inject({
      method: "POST",
      url: `/v1/rule-sets/${set}/retire`,
      headers: staff(tenant, "ADMIN", "admin"),
      payload: { command_id: randomUUID() },
    });
    expect(retire.statusCode, retire.body).toBe(200);
    const refused = await t.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: staff(tenant),
      payload: ingestBody(),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("NO_ACTIVE_RULE_SET");
    // The in-flight case keeps its pinned (now retired) version.
    const res = await act(
      t,
      tenant,
      pending.case_id,
      actionBody("provide_information", pending.version, {
        documents: ["insurance"],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().state).toBe("DESTINATION_PENDING");
  });

  it("17 disabled case types cannot execute", async () => {
    const tenant = await newTenant();
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/cases",
      headers: staff(tenant),
      payload: { case_type: "STATUS_ENQUIRY", ...ingestBody() },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("CASE_TYPE_DISABLED");
    // Enabled appointment operations cases are never created directly.
    for (const caseType of [
      "APPOINTMENT_REQUEST",
      "RESCHEDULING_REQUEST",
      "CANCELLATION_REQUEST",
    ]) {
      const direct = await t.app.inject({
        method: "POST",
        url: "/v1/cases",
        headers: staff(tenant),
        payload: { case_type: caseType, ...ingestBody() },
      });
      expect(direct.statusCode, caseType).toBe(422);
      expect(direct.json().error).toBe("CASE_TYPE_NOT_CREATABLE");
    }
    expect((await tableCounts(tenant)).access_cases).toBe(0);
    // Tamper: a still-disabled case type with a consequential outbox item.
    const caseId = randomUUID();
    await ownerPool().query(
      "INSERT INTO access_cases(id,tenant_id,case_type,source_channel,current_state,opened_at) VALUES($1,$2,'STATUS_ENQUIRY','API','DESTINATION_PENDING',now())",
      [caseId, tenant],
    );
    const executionId = randomUUID();
    await ownerPool().query(
      "INSERT INTO outbox(tenant_id,case_id,subject_type,subject_id,operation,aggregate_version,execution_id,payload,correlation_id) VALUES($1,$2,'case',$2,'appointment.create',0,$3,'{}',$2)",
      [tenant, caseId, executionId],
    );
    const connector = mock();
    await drain(dispatcher([tenant], connector));
    expect(connector.executeCalls.size).toBe(0);
    const e = await ownerPool().query(
      "SELECT status,last_error FROM executions WHERE id=$1",
      [executionId],
    );
    expect(e.rows[0]).toEqual({
      status: "PERMANENT",
      last_error: "CASE_TYPE_DISABLED",
    });
    const action = await act(
      t,
      tenant,
      caseId,
      actionBody("close", 0, { resolution_code: "CANCELLED" }),
    );
    expect(action.statusCode).toBe(422);
  });

  it("18 disabled connector capabilities cannot execute", async () => {
    const tenant = await newTenant();
    const r = await ingest(t, tenant);
    const connector = mock();
    await drain(
      dispatcher([tenant], connector, {
        capabilities: ["appointment.status.read"],
      }),
    );
    expect(connector.executeCalls.size).toBe(0);
    const d = await detail(t, tenant, r.case_id);
    expect(d.case.current_state).toBe("EXCEPTION");
    expect(d.executions[0]).toMatchObject({
      status: "PERMANENT",
      last_error: "UNSUPPORTED_OPERATION",
    });
    expect(
      d.work_items
        .filter((w: { status: string }) => w.status === "OPEN")
        .map((w: { kind: string }) => w.kind),
    ).toEqual(["MANUAL_DESTINATION"]);
    // The manual workflow then completes the destination step explicitly.
    const manual = await act(
      t,
      tenant,
      r.case_id,
      actionBody("record_destination_reference", d.case.version, {
        destination_reference: "PMS-4471",
      }),
    );
    expect(manual.statusCode, manual.body).toBe(200);
    expect(manual.json().state).toBe("READY_FOR_BOOKING");
  });

  it("19 a case type cannot authorise an action intended for another case type", async () => {
    const tenant = await newTenant();
    const r = await ingest(t, tenant);
    // Tamper: attach an appointment operation to the referral case's outbox.
    const executionId = randomUUID();
    await ownerPool().query(
      "UPDATE outbox SET status='DONE' WHERE case_id=$1",
      [r.case_id],
    );
    await ownerPool().query(
      "INSERT INTO outbox(tenant_id,case_id,subject_type,subject_id,operation,aggregate_version,execution_id,payload,correlation_id) VALUES($1,$2,'case',$2,'appointment.create',$3,$4,'{}',$2)",
      [tenant, r.case_id, r.version + 1, executionId],
    );
    const connector = mock();
    await drain(dispatcher([tenant], connector));
    expect(connector.executeCalls.has(executionId)).toBe(false);
    const e = await ownerPool().query(
      "SELECT status,last_error FROM executions WHERE id=$1",
      [executionId],
    );
    expect(e.rows[0]).toEqual({
      status: "PERMANENT",
      last_error: "OPERATION_NOT_PERMITTED_FOR_CASE_TYPE",
    });
  });

  it("20 client-supplied tenant headers cannot override authenticated membership", async () => {
    const jwt = await testApi({ auth: "jwt" });
    try {
      const a = await newTenant();
      const b = await newTenant();
      const user = randomUUID();
      await grantMembership(a, user, "REFERRAL_COORDINATOR");
      const token = await mintToken(user);
      const me = await jwt.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer ${token}`, "x-tenant-id": b },
      });
      expect(me.statusCode).toBe(403);
      const own = await jwt.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(own.json()).toMatchObject({
        tenant_id: a,
        role: "REFERRAL_COORDINATOR",
        auth_mode: "jwt",
      });
      const spoofedRole = await jwt.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer ${token}`, "x-access-role": "ADMIN" },
      });
      expect(spoofedRole.json().role).toBe("REFERRAL_COORDINATOR");
      const bodyTenant = await jwt.app.inject({
        method: "POST",
        url: "/v1/referrals",
        headers: { authorization: `Bearer ${token}` },
        payload: ingestBody({ tenant_id: b }),
      });
      expect(bodyTenant.statusCode).toBe(403);
      expect((await tableCounts(b)).access_cases).toBe(0);
      for (const bad of [
        {},
        { authorization: "Bearer not-a-jwt" },
        {
          authorization: `Bearer ${await mintToken(user, { secret: "another-secret-that-is-at-least-32-chars" })}`,
        },
        {
          authorization: `Bearer ${await mintToken(user, { audience: "anon" })}`,
        },
        {
          authorization: `Bearer ${await mintToken(user, { issuer: "https://evil.invalid" })}`,
        },
        {
          authorization: `Bearer ${await mintToken(user, { expiresIn: "-1m" })}`,
        },
      ])
        expect(
          (await jwt.app.inject({ method: "GET", url: "/v1/me", headers: bad }))
            .statusCode,
        ).toBe(401);
      await grantMembership(a, user, "REFERRAL_COORDINATOR", "SUSPENDED");
      expect(
        (
          await jwt.app.inject({
            method: "GET",
            url: "/v1/me",
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await jwt.close();
    }
  });

  it("21 cross-tenant access fails", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const r = await ingest(t, a);
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: `/v1/cases/${r.case_id}`,
          headers: staff(b),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await act(
          t,
          b,
          r.case_id,
          actionBody("close", r.version, { resolution_code: "CANCELLED" }),
        )
      ).statusCode,
    ).toBe(404);
    const queue = await t.app.inject({
      method: "GET",
      url: "/v1/cases?filter=all",
      headers: staff(b),
    });
    expect(queue.json().items).toEqual([]);
    const leaked = await tenantTx(
      b,
      (c) =>
        c.query("SELECT count(*)::int n FROM access_cases WHERE tenant_id=$1", [
          a,
        ]),
      apiPool(),
    );
    expect(leaked.rows[0].n).toBe(0);
  });

  it("22 runtime roles remain least privilege", async () => {
    await verifyRuntimeIdentity(apiPool(), "access_request");
    await verifyRuntimeIdentity(workerPool(), "access_worker");
    await expect(
      verifyRuntimeIdentity(ownerPool(), "access_request"),
    ).rejects.toThrow(/unsafe/);
    const privileges = await ownerPool().query<{
      role: string;
      table: string;
      privs: string;
    }>(
      `SELECT r.rolname AS role, c.relname AS table,
              concat_ws(',', CASE WHEN has_table_privilege(r.rolname,c.oid,'SELECT') THEN 'S' END,
                             CASE WHEN has_table_privilege(r.rolname,c.oid,'INSERT') THEN 'I' END,
                             CASE WHEN has_table_privilege(r.rolname,c.oid,'UPDATE') THEN 'U' END,
                             CASE WHEN has_table_privilege(r.rolname,c.oid,'DELETE') THEN 'D' END,
                             CASE WHEN has_table_privilege(r.rolname,c.oid,'TRUNCATE') THEN 'T' END) AS privs
         FROM pg_class c CROSS JOIN pg_roles r
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND r.rolname IN ('access_request','access_worker')
        ORDER BY 1,2`,
    );
    const matrix = Object.fromEntries(
      privileges.rows.map((p) => [`${p.role}.${p.table}`, p.privs]),
    );
    expect(Object.entries(matrix).filter(([, p]) => /D|T/.test(p))).toEqual([]);
    expect(matrix["access_request.outbox"]).toBe("S,I");
    expect(matrix["access_request.evidence_events"]).toBe("S,I");
    expect(matrix["access_request.commands"]).toBe("S,I");
    expect(matrix["access_request.schema_migrations"]).toBe("");
    for (const table of [
      "artifacts",
      "commands",
      "access_interactions",
      "organisation_memberships",
      "access_audit_log",
      "schema_migrations",
    ])
      expect(matrix[`access_worker.${table}`]).toBe("");
    expect(matrix["access_worker.access_rule_sets"]).toBe("S");
    expect(matrix["access_worker.organisations"]).toBe("S");
    await expect(
      tenantTx(
        randomUUID(),
        (c) => c.query("UPDATE outbox SET status='DONE'"),
        apiPool(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      tenantTx(
        randomUUID(),
        (c) => c.query("SELECT * FROM artifacts"),
        workerPool(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      tenantTx(
        randomUUID(),
        (c) => c.query("UPDATE evidence_events SET payload='{}'"),
        apiPool(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("23 duplicate command IDs cannot duplicate side effects", async () => {
    const tenant = await newTenant();
    const body = ingestBody({ fixture: "missing-insurance" });
    const first = await t.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: staff(tenant),
      payload: body,
    });
    const files = await countFiles(t.artifactRoot);
    const before = await tableCounts(tenant);
    const replay = await t.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: staff(tenant),
      payload: body,
    });
    expect(replay.json()).toEqual({ ...first.json(), deduplicated: true });
    expect(await tableCounts(tenant)).toEqual(before);
    expect(await countFiles(t.artifactRoot)).toBe(files);
    const conflict = await t.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: staff(tenant),
      payload: { ...body, filename: "different.txt" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("IDEMPOTENCY_CONFLICT");
    const caseId = first.json().case_id;
    const action = actionBody("provide_information", first.json().version, {
      documents: ["insurance"],
    });
    const a1 = await act(t, tenant, caseId, action);
    const afterAction = await tableCounts(tenant);
    const a2 = await act(t, tenant, caseId, action);
    expect(a2.json()).toEqual({ ...a1.json(), deduplicated: true });
    expect(a1.json().execution_id).toBeTruthy();
    expect(a2.json().execution_id).toBe(a1.json().execution_id);
    expect(await tableCounts(tenant)).toEqual(afterAction);
    const differentAction = await act(t, tenant, caseId, {
      ...action,
      note: "a different note",
    });
    expect(differentAction.statusCode).toBe(409);
  });

  it("24 ambiguous writes cannot be blindly retried", async () => {
    const tenant = await newTenant();
    const r = await ingest(t, tenant);
    const connector = mock({ fault: "committed-timeout", idempotent: false });
    const d = dispatcher([tenant], connector, { maxReconcile: 5 });
    await d.tick();
    expect(
      (
        await ownerPool().query(
          "SELECT status FROM executions WHERE case_id=$1",
          [r.case_id],
        )
      ).rows[0].status,
    ).toBe("AMBIGUOUS");
    for (let i = 0; i < 5; i++) await d.tick();
    expect(connector.executeCalls.get(r.execution_id!)).toBe(1);
    await d.reconcile();
    expect((await caseState(r.case_id)).current_state).toBe(
      "READY_FOR_BOOKING",
    );
    expect(connector.foreignWrites()).toBe(1);
    expect(connector.executeCalls.get(r.execution_id!)).toBe(1);
  });

  it("25 one external execution ID cannot generate two effective foreign writes", async () => {
    const tenant = await newTenant();
    const r = await ingest(t, tenant);
    await expect(
      ownerPool().query(
        "INSERT INTO outbox(tenant_id,case_id,subject_type,subject_id,operation,aggregate_version,execution_id,payload,correlation_id) SELECT tenant_id,case_id,subject_type,subject_id,operation,aggregate_version,execution_id,payload,correlation_id FROM outbox WHERE execution_id=$1",
        [r.execution_id],
      ),
    ).rejects.toThrow(/outbox_tenant_id_execution_id_key/);
    const connector = mock({ idempotent: false });
    await Promise.all([
      dispatcher([tenant], connector).tick(),
      dispatcher([tenant], connector).tick(),
      dispatcher([tenant], connector).tick(),
    ]);
    await drain(dispatcher([tenant], connector));
    expect(connector.executeCalls.get(r.execution_id!)).toBe(1);
    expect(connector.foreignWrites()).toBe(1);
    const executions = await ownerPool().query(
      "SELECT count(*)::int n FROM executions WHERE case_id=$1 AND status='SUCCEEDED'",
      [r.case_id],
    );
    expect(executions.rows[0].n).toBe(1);
  });

  it("26 poison handling creates exactly one exception workflow", async () => {
    const tenant = await newTenant();
    const r = await ingest(t, tenant);
    const d = dispatcher([tenant], mock({ fault: "retryable" }), {
      maxDispatch: 3,
    });
    await drain(d, 30);
    await drain(d, 5);
    const detailView = await detail(t, tenant, r.case_id);
    expect(detailView.case.current_state).toBe("EXCEPTION");
    expect(detailView.executions[0]).toMatchObject({
      status: "POISON",
      attempts: 3,
    });
    expect(
      detailView.work_items.filter(
        (w: { kind: string }) => w.kind === "CONNECTOR",
      ),
    ).toHaveLength(1);
    expect(
      detailView.evidence.events.filter(
        (e: { event_type: string }) => e.event_type === "dispatch_poisoned",
      ),
    ).toHaveLength(1);
    expect(
      (
        await ownerPool().query("SELECT status FROM outbox WHERE case_id=$1", [
          r.case_id,
        ])
      ).rows[0].status,
    ).toBe("POISON");
  });

  it("27 cryptographic evidence remains valid through booking and closure", async () => {
    const tenant = await newTenant();
    const booked = await bookable(tenant);
    const closed = await bookable(tenant);
    await act(
      t,
      tenant,
      booked.case_id,
      actionBody("record_booking", booked.version, {
        occurred_at: new Date().toISOString(),
      }),
    );
    await act(
      t,
      tenant,
      closed.case_id,
      actionBody("record_follow_up", closed.version),
    );
    const s = await caseState(closed.case_id);
    await act(
      t,
      tenant,
      closed.case_id,
      actionBody("record_patient_unreachable", s.version),
    );
    for (const id of [booked.case_id, closed.case_id]) {
      const v = await tenantTx(
        tenant,
        (c) => verifyEvidenceChain(c, tenant, id),
        apiPool(),
      );
      expect(v.valid).toBe(true);
      expect(v.events).toBeGreaterThan(8);
    }
    const events = (
      await detail(t, tenant, booked.case_id)
    ).evidence.events.map((e: { event_type: string }) => e.event_type);
    for (const expected of [
      "case_created",
      "interaction_received",
      "artifact_recorded",
      "rule_decision_recorded",
      "destination_dispatch_requested",
      "destination_committed",
      "outcome_observed",
      "case_booked",
      "staff_action_recorded",
    ])
      expect(events).toContain(expected);
    // A privileged actor bypassing the append-only trigger is still detected.
    const c = await ownerPool().connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(
        "UPDATE evidence_events SET payload='{\"tampered\":true}' WHERE case_id=$1 AND sequence=2",
        [closed.case_id],
      );
      const tampered = await verifyEvidenceChain(c, tenant, closed.case_id);
      expect(tampered).toMatchObject({
        valid: false,
        failure: { sequence: 2, reason: "hash mismatch" },
      });
      await c.query("ROLLBACK");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    await expect(
      ownerPool().query("DELETE FROM evidence_events WHERE case_id=$1", [
        booked.case_id,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it("28 artifact cleanup works on every failure boundary", async () => {
    const tenant = await newTenant();
    const base = await countFiles(t.artifactRoot);
    const failures = [
      ingestBody({
        fixture: undefined,
        structured: {
          patient: {
            given_name: "S",
            family_name: "P",
            date_of_birth: "not-a-date",
          },
          referrer: { name: "Dr" },
          documents: [],
        },
      }),
      ingestBody({ content_base64: "!!!" }),
    ];
    for (const payload of failures)
      expect(
        (
          await t.app.inject({
            method: "POST",
            url: "/v1/referrals",
            headers: staff(tenant),
            payload,
          })
        ).statusCode,
      ).toBe(400);
    const existing = await ingest(t, tenant);
    const afterOne = await countFiles(t.artifactRoot);
    expect(afterOne).toBe(base + 1);
    const duplicateReferral = await t.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: staff(tenant),
      payload: ingestBody({ referral_id: existing.referral_id }),
    });
    expect(duplicateReferral.statusCode).toBe(409);
    expect(await countFiles(t.artifactRoot)).toBe(afterOne);
  });

  it("29 real-data mode refuses insecure development components", () => {
    const env = {
      NODE_ENV: "production",
      ACCESS_DEPLOYMENT_PROFILE: "client-pilot",
      ACCESS_DATA_MODE: "REAL",
      API_DATABASE_URL: "postgres://access_request:x@db.example.test/postgres",
      WORKER_DATABASE_URL:
        "postgres://access_worker:x@db.example.test/postgres",
      DATABASE_SSL: "require",
      ARTIFACT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      ACCESS_AUTH_MODE: "synthetic",
      ARTIFACT_STORE: "local",
      ARTIFACT_SCANNER: "mock",
      CONSOLE_ORIGIN: "*",
      CONNECTOR_KIND: "mock",
    };
    expect(() => loadApiConfig(env)).toThrow(ConfigError);
    expect(() => loadWorkerConfig(env)).toThrow(/mock connector/);
    try {
      loadApiConfig(env);
    } catch (e) {
      const all = (e as ConfigError).problems.join("\n");
      for (const expected of [
        /synthetic tenant context/,
        /local artifact store/,
        /mock scanner/,
        /https origin/,
      ])
        expect(all).toMatch(expected);
    }
  });
});
