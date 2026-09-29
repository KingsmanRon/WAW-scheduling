import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  caseState,
  closePools,
  databaseEnabled,
  detail,
  dispatcher,
  drain,
  ingest,
  mock,
  newTenant,
  ownerPool,
  testApi,
  type TestApi,
} from "../support/harness.js";

async function execution(caseId: string) {
  return (
    await ownerPool().query(
      "SELECT id,status,attempts,reconcile_attempts,external_id,last_error,escalated_at,next_reconcile_at FROM executions WHERE case_id=$1 ORDER BY created_at",
      [caseId],
    )
  ).rows;
}
async function outbox(caseId: string) {
  return (
    await ownerPool().query(
      "SELECT status,attempts,lease_until FROM outbox WHERE case_id=$1 ORDER BY id",
      [caseId],
    )
  ).rows;
}
async function evidenceTypes(caseId: string): Promise<string[]> {
  return (
    await ownerPool().query(
      "SELECT event_type FROM evidence_events WHERE case_id=$1 ORDER BY sequence",
      [caseId],
    )
  ).rows.map((r) => r.event_type);
}
async function openWork(caseId: string) {
  return (
    await ownerPool().query(
      "SELECT kind,reason FROM work_items WHERE case_id=$1 AND status='OPEN' ORDER BY created_at",
      [caseId],
    )
  ).rows;
}

describe.runIf(databaseEnabled)(
  "worker dispatcher against real PostgreSQL (access_worker role)",
  () => {
    let t: TestApi;
    beforeAll(async () => {
      t = await testApi();
    });
    afterAll(async () => {
      await t.close();
      await closePools();
    });

    it("happy path: outbox -> claim -> connector succeeds -> SUCCEEDED -> READY_FOR_BOOKING -> evidence -> DONE", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const connector = mock();
      expect(await dispatcher([tenant], connector).tick()).toBe(true);
      const [e] = await execution(r.case_id);
      expect(e).toMatchObject({
        id: r.execution_id,
        status: "SUCCEEDED",
        attempts: 1,
        external_id: connector.effects.get(r.execution_id!)![0],
      });
      expect(await outbox(r.case_id)).toMatchObject([
        { status: "DONE", lease_until: null },
      ]);
      const s = await caseState(r.case_id);
      expect(s).toMatchObject({
        current_state: "READY_FOR_BOOKING",
        version: r.version + 1,
        resolution_code: null,
      });
      expect(await evidenceTypes(r.case_id)).toEqual(
        expect.arrayContaining([
          "destination_dispatch_requested",
          "destination_committed",
          "outcome_observed",
        ]),
      );
      const ref = await ownerPool().query(
        "SELECT destination_reference,destination_reference_source,follow_up_due_at FROM referrals WHERE case_id=$1",
        [r.case_id],
      );
      expect(ref.rows[0]).toMatchObject({
        destination_reference: e.external_id,
        destination_reference_source: "CONNECTOR",
      });
      expect(ref.rows[0].follow_up_due_at).not.toBeNull();
    });

    it("retry: RETRYABLE is bounded and eventually succeeds", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const connector = mock({
        fault: "retryable-then-success",
        retryableFailures: 2,
      });
      const d = dispatcher([tenant], connector, { maxDispatch: 5 });
      await d.tick();
      expect(await execution(r.case_id)).toMatchObject([
        { status: "RETRYABLE", attempts: 1 },
      ]);
      expect(await outbox(r.case_id)).toMatchObject([
        { status: "PENDING", attempts: 1 },
      ]);
      await d.tick();
      await d.tick();
      expect(await execution(r.case_id)).toMatchObject([
        { status: "SUCCEEDED", attempts: 3 },
      ]);
      expect(connector.foreignWrites()).toBe(1);
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
    });

    it("only an explicit known-not-sent error is retried automatically", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      await dispatcher([tenant], mock({ fault: "pre-send-failure" }), {
        maxDispatch: 3,
      }).tick();
      expect(await execution(r.case_id)).toMatchObject([
        { status: "RETRYABLE", last_error: "CONNECT_REFUSED" },
      ]);
      const tenant2 = await newTenant();
      const r2 = await ingest(t, tenant2);
      await dispatcher([tenant2], mock({ fault: "committed-throw" })).tick();
      // An unclassified exception on a consequential write is ambiguous, not retryable.
      expect(await execution(r2.case_id)).toMatchObject([
        { status: "AMBIGUOUS", last_error: "UNCLASSIFIED_CONNECTOR_ERROR" },
      ]);
      expect(await outbox(r2.case_id)).toMatchObject([{ status: "DONE" }]);
    });

    it("poison: retry threshold exhausted -> POISON -> EXCEPTION -> one connector work item -> evidence", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const d = dispatcher([tenant], mock({ fault: "retryable" }), {
        maxDispatch: 2,
      });
      await drain(d, 10);
      await drain(d, 10);
      expect(await execution(r.case_id)).toMatchObject([
        { status: "POISON", attempts: 2 },
      ]);
      expect(await outbox(r.case_id)).toMatchObject([{ status: "POISON" }]);
      expect((await caseState(r.case_id)).current_state).toBe("EXCEPTION");
      expect(await openWork(r.case_id)).toEqual([
        { kind: "CONNECTOR", reason: "dispatch_poisoned:TEMPORARY" },
      ]);
      expect(
        (await evidenceTypes(r.case_id)).filter(
          (x) => x === "dispatch_poisoned",
        ),
      ).toHaveLength(1);
    });

    it("ambiguous: commits then times out -> AMBIGUOUS -> RECONCILING -> read back same execution id -> SUCCEEDED, no duplicate", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const connector = mock({
        fault: "committed-timeout",
        idempotent: false,
        reconcileAmbiguousPolls: 0,
      });
      const d = dispatcher([tenant], connector);
      await d.tick();
      expect(await execution(r.case_id)).toMatchObject([
        { status: "AMBIGUOUS", last_error: "CONNECTOR_REPORTED_AMBIGUOUS" },
      ]);
      const pending = await caseState(r.case_id);
      expect(pending.current_state).toBe("DESTINATION_PENDING");
      expect(await d.reconcile()).toBe(1);
      expect(await execution(r.case_id)).toMatchObject([
        { status: "SUCCEEDED", reconcile_attempts: 1 },
      ]);
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
      expect(connector.executeCalls.get(r.execution_id!)).toBe(1);
      expect(connector.foreignWrites()).toBe(1);
      expect(await evidenceTypes(r.case_id)).toEqual(
        expect.arrayContaining([
          "destination_ambiguous",
          "reconciliation_succeeded",
        ]),
      );
    });

    it("repeated ambiguity: AMBIGUOUS -> AMBIGUOUS -> AMBIGUOUS -> success without case version churn", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const connector = mock({
        fault: "committed-timeout",
        reconcileAmbiguousPolls: 3,
      });
      const d = dispatcher([tenant], connector, { maxReconcile: 5 });
      await d.tick();
      const before = await caseState(r.case_id);
      const evidenceBefore = (await evidenceTypes(r.case_id)).length;
      for (let i = 1; i <= 3; i++) {
        await d.reconcile();
        expect(await execution(r.case_id)).toMatchObject([
          { status: "RECONCILING", reconcile_attempts: i },
        ]);
        // Technical-only polls: no business version change, no evidence growth.
        expect(await caseState(r.case_id)).toEqual(before);
        expect((await evidenceTypes(r.case_id)).length).toBe(evidenceBefore);
      }
      await d.reconcile();
      expect(await execution(r.case_id)).toMatchObject([
        { status: "SUCCEEDED", reconcile_attempts: 4 },
      ]);
      expect(await caseState(r.case_id)).toMatchObject({
        current_state: "READY_FOR_BOOKING",
        version: before.version + 1,
      });
    });

    it("exhausted reconciliation: repeated ambiguity -> maximum -> EXCEPTION -> human work item; never re-sent", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const connector = mock({ fault: "uncommitted-timeout" });
      const d = dispatcher([tenant], connector, { maxReconcile: 3 });
      await d.tick();
      for (let i = 0; i < 6; i++) await d.reconcile();
      const [e] = await execution(r.case_id);
      expect(e).toMatchObject({
        status: "AMBIGUOUS",
        reconcile_attempts: 3,
        next_reconcile_at: null,
      });
      expect(e.escalated_at).not.toBeNull();
      expect((await caseState(r.case_id)).current_state).toBe("EXCEPTION");
      expect(await openWork(r.case_id)).toEqual([
        {
          kind: "CONNECTOR",
          reason: "reconciliation_escalated:RECONCILIATION_EXHAUSTED",
        },
      ]);
      expect(connector.executeCalls.get(r.execution_id!)).toBe(1);
      // Retrying needs a staff attestation that the destination has no record.
      const s = await caseState(r.case_id);
      const work = (
        await ownerPool().query(
          "SELECT id FROM work_items WHERE case_id=$1 AND status='OPEN'",
          [r.case_id],
        )
      ).rows[0].id;
      const body = {
        command_id: randomUUID(),
        correlation_id: randomUUID(),
        expected_version: s.version,
        note: "checked",
        work_item_id: work,
        resolution: "retry_destination",
      };
      const refused = await t.app.inject({
        method: "POST",
        url: `/v1/cases/${r.case_id}/actions`,
        headers: { "x-tenant-id": tenant },
        payload: { action: "resolve_exception", ...body },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe("ATTESTATION_REQUIRED");
      const attested = await t.app.inject({
        method: "POST",
        url: `/v1/cases/${r.case_id}/actions`,
        headers: { "x-tenant-id": tenant },
        payload: {
          action: "resolve_exception",
          ...body,
          command_id: randomUUID(),
          attest_not_committed: true,
          note: "PMS searched, no record",
        },
      });
      expect(attested.statusCode, attested.body).toBe(200);
      expect(attested.json().execution_id).not.toBe(r.execution_id);
      connector.setFault("success");
      await drain(d);
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
      expect((await execution(r.case_id)).map((x) => x.status)).toEqual([
        "AMBIGUOUS",
        "SUCCEEDED",
      ]);
    });

    it("lease crash: an expired lease is reclaimed; idempotent destinations are re-sent, others are reconciled", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      // Simulate a worker that claimed the item and died mid-flight.
      await ownerPool().query(
        "UPDATE outbox SET status='LEASED',attempts=1,lease_until=now()-interval '1 second' WHERE case_id=$1",
        [r.case_id],
      );
      const connector = mock({ idempotent: true });
      await dispatcher([tenant], connector).tick();
      expect(await execution(r.case_id)).toMatchObject([
        { status: "SUCCEEDED", attempts: 2 },
      ]);
      expect(connector.foreignWrites()).toBe(1);

      const tenant2 = await newTenant();
      const r2 = await ingest(t, tenant2);
      await ownerPool().query(
        "UPDATE outbox SET status='LEASED',attempts=1,lease_until=now()-interval '1 second' WHERE case_id=$1",
        [r2.case_id],
      );
      const unsafe = mock({ idempotent: false });
      const d = dispatcher([tenant2], unsafe);
      await d.tick();
      expect(unsafe.executeCalls.size).toBe(0);
      expect(await execution(r2.case_id)).toMatchObject([
        { status: "AMBIGUOUS", last_error: "LEASE_EXPIRED_POSSIBLE_SEND" },
      ]);
      // An unexpired lease is never stolen.
      const tenant3 = await newTenant();
      const r3 = await ingest(t, tenant3);
      await ownerPool().query(
        "UPDATE outbox SET status='LEASED',attempts=1,lease_until=now()+interval '1 minute' WHERE case_id=$1",
        [r3.case_id],
      );
      expect(await dispatcher([tenant3], mock()).tick()).toBe(false);
    });

    it("concurrency: two dispatchers, one outbox item, one effective execution", async () => {
      const tenant = await newTenant();
      const cases = await Promise.all(
        [1, 2, 3, 4, 5, 6].map(() => ingest(t, tenant)),
      );
      const connector = mock({ idempotent: false });
      const a = dispatcher([tenant], connector);
      const b = dispatcher([tenant], connector);
      for (let i = 0; i < 6; i++)
        await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
      for (const c of cases)
        expect(connector.executeCalls.get(c.execution_id!)).toBe(1);
      expect(connector.foreignWrites()).toBe(cases.length);
      const done = await ownerPool().query(
        "SELECT count(*)::int n FROM outbox WHERE tenant_id=$1 AND status='DONE' AND attempts=1",
        [tenant],
      );
      expect(done.rows[0].n).toBe(cases.length);
    });

    it("execution identity mismatch fails safely and never mutates the wrong execution or case", async () => {
      const tenant = await newTenant();
      const victim = await ingest(t, tenant);
      await drain(dispatcher([tenant], mock()));
      const victimBefore = await caseState(victim.case_id);
      const victimExecution = await execution(victim.case_id);
      const r = await ingest(t, tenant);
      const connector = mock({ fault: "execution-id-mismatch" });
      await dispatcher([tenant], connector).tick();
      expect(await execution(r.case_id)).toMatchObject([
        {
          status: "AMBIGUOUS",
          last_error: "EXECUTION_ID_MISMATCH",
          external_id: null,
        },
      ]);
      expect((await caseState(r.case_id)).current_state).toBe(
        "DESTINATION_PENDING",
      );
      expect(await caseState(victim.case_id)).toEqual(victimBefore);
      expect(await execution(victim.case_id)).toEqual(victimExecution);
      const bogus = await ownerPool().query(
        "SELECT count(*)::int n FROM executions WHERE id='00000000-0000-4000-8000-000000000000'",
      );
      expect(bogus.rows[0].n).toBe(0);
    });

    it("malformed responses after possible commit are ambiguous; before commit a clean result is required", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const connector = mock({ fault: "committed-malformed" });
      const d = dispatcher([tenant], connector);
      await d.tick();
      expect(await execution(r.case_id)).toMatchObject([
        { status: "AMBIGUOUS", last_error: "INVALID_CONNECTOR_RESPONSE" },
      ]);
      await d.reconcile();
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
      expect(connector.foreignWrites()).toBe(1);
    });

    it("permanent, deferred and unsupported results open the right human workflow", async () => {
      for (const [fault, kind] of [
        ["permanent", "CONNECTOR"],
        ["deferred", "MANUAL_DESTINATION"],
        ["unsupported", "MANUAL_DESTINATION"],
      ] as const) {
        const tenant = await newTenant();
        const r = await ingest(t, tenant);
        await dispatcher([tenant], mock({ fault })).tick();
        expect((await caseState(r.case_id)).current_state).toBe("EXCEPTION");
        expect((await openWork(r.case_id)).map((w) => w.kind)).toEqual([kind]);
        expect((await execution(r.case_id))[0].status).toBe("PERMANENT");
      }
    });

    it("closed-loop readback: connector outcome polling books the case and repeats idempotently", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const connector = mock({ appointmentOutcome: "BOOKED" });
      const d = dispatcher([tenant], connector);
      await d.tick();
      await ownerPool().query(
        "UPDATE referrals SET outcome_next_poll_at=now()-interval '1 second' WHERE case_id=$1",
        [r.case_id],
      );
      expect(await d.pollOutcomes()).toBe(1);
      const view = await detail(t, tenant, r.case_id);
      expect(view.case).toMatchObject({
        current_state: "BOOKED",
        resolution_code: "BOOKED",
        resolution_source: "CONNECTOR",
      });
      const booked = view.observations.find(
        (o: { observation_type: string }) =>
          o.observation_type === "APPOINTMENT_BOOKED",
      );
      expect(booked).toMatchObject({
        source_type: "CONNECTOR",
        verification_level: "EXTERNAL_CONFIRMED",
        disposition: "APPLIED",
      });
      expect(await d.pollOutcomes()).toBe(0);
    });

    it("no readback capability means no polling (never emulated)", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const d = dispatcher([tenant], mock({ appointmentOutcome: "BOOKED" }), {
        capabilities: ["referral.create", "referral.status.read"],
      });
      await d.tick();
      await ownerPool().query(
        "UPDATE referrals SET outcome_next_poll_at=now()-interval '1 second' WHERE case_id=$1",
        [r.case_id],
      );
      expect(await d.pollOutcomes()).toBe(0);
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
    });

    it("administrative timers open one follow-up and one escalation work item", async () => {
      const tenant = await newTenant();
      const ready = await ingest(t, tenant);
      const d = dispatcher([tenant], mock());
      await d.tick();
      await ownerPool().query(
        "UPDATE referrals SET follow_up_due_at=now()-interval '1 minute' WHERE case_id=$1",
        [ready.case_id],
      );
      const stalled = await ingest(t, tenant, { fixture: "missing-insurance" });
      // Age the history as a privileged operator would (bypassing the
      // append-only trigger inside one transaction), to simulate time passing.
      const c = await ownerPool().connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica");
        await c.query(
          "UPDATE access_case_transitions SET occurred_at=now()-interval '80 hours' WHERE case_id=$1",
          [stalled.case_id],
        );
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      expect(await d.sweepTimers()).toBe(2);
      expect(await d.sweepTimers()).toBe(0);
      expect((await openWork(ready.case_id)).map((w) => w.kind)).toEqual([
        "FOLLOW_UP",
      ]);
      expect((await openWork(stalled.case_id)).map((w) => w.reason)).toContain(
        "stalled_in_information_missing",
      );
    });
  },
);
