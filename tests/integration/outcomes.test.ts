import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  act,
  actionBody,
  caseState,
  closePools,
  databaseEnabled,
  detail,
  dispatcher,
  drain,
  ingest,
  newTenant,
  ownerPool,
  ruleDefinition,
  staff,
  testApi,
  type TestApi,
} from "../support/harness.js";

describe.runIf(databaseEnabled)(
  "outcome observations and the staff workflow",
  () => {
    let t: TestApi;
    beforeAll(async () => {
      t = await testApi();
    });
    afterAll(async () => {
      await t.close();
      await closePools();
    });
    const importRows = (
      tenant: string,
      rows: object[],
      role = "PRACTICE_MANAGER",
    ) =>
      t.app.inject({
        method: "POST",
        url: "/v1/observations/import",
        headers: staff(tenant, role, "manager"),
        payload: {
          command_id: randomUUID(),
          correlation_id: randomUUID(),
          source_label: "pms-export",
          rows,
        },
      });

    it("an outcome that arrives before the destination commit is held and applied afterwards", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const booked = await importRows(tenant, [
        {
          case_id: r.case_id,
          observation_type: "APPOINTMENT_BOOKED",
          occurred_at: new Date().toISOString(),
          source_reference: "pms:early-1",
        },
      ]);
      expect(booked.json().results[0].disposition).toBe("PENDING");
      expect((await caseState(r.case_id)).current_state).toBe(
        "DESTINATION_PENDING",
      );
      await drain(dispatcher([tenant]));
      const s = await caseState(r.case_id);
      expect(s).toMatchObject({
        current_state: "BOOKED",
        resolution_code: "BOOKED",
      });
      const obs = await ownerPool().query(
        "SELECT disposition,applied_at FROM access_case_observations WHERE case_id=$1 AND observation_type='APPOINTMENT_BOOKED'",
        [r.case_id],
      );
      expect(obs.rows[0].disposition).toBe("APPLIED");
      expect(obs.rows[0].applied_at).not.toBeNull();
    });

    it("conflicting early outcomes: the earliest applies, a later conflict goes to review", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const t1 = new Date(Date.now() + 1000).toISOString();
      const t2 = new Date(Date.now() + 2000).toISOString();
      await importRows(tenant, [
        {
          case_id: r.case_id,
          observation_type: "PATIENT_DECLINED",
          occurred_at: t2,
          source_reference: "pms:d",
        },
        {
          case_id: r.case_id,
          observation_type: "APPOINTMENT_BOOKED",
          occurred_at: t1,
          source_reference: "pms:b",
        },
      ]);
      await drain(dispatcher([tenant]));
      expect((await caseState(r.case_id)).current_state).toBe("BOOKED");
      const review = await ownerPool().query(
        "SELECT reason FROM work_items WHERE case_id=$1 AND kind='OUTCOME_REVIEW' AND status='OPEN'",
        [r.case_id],
      );
      expect(review.rows[0].reason).toBe(
        "patient_declined:conflicts_with_terminal_outcome",
      );
    });

    it("a late conflicting booking can be applied only through an audited manager correction", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      await drain(dispatcher([tenant]));
      const s = await caseState(r.case_id);
      await act(
        t,
        tenant,
        r.case_id,
        actionBody("record_patient_unreachable", s.version),
      );
      const late = await importRows(tenant, [
        {
          case_id: r.case_id,
          observation_type: "APPOINTMENT_BOOKED",
          occurred_at: new Date(Date.now() + 1000).toISOString(),
          source_reference: "pms:late",
        },
      ]);
      expect(late.json().results[0].disposition).toBe("REVIEW");
      const closed = await caseState(r.case_id);
      expect(closed.current_state).toBe("CLOSED");
      const observationId = late.json().results[0].observation_id;
      const coordinator = await act(
        t,
        tenant,
        r.case_id,
        actionBody("correct_outcome", closed.version, {
          observation_id: observationId,
        }),
      );
      expect(coordinator.statusCode).toBe(403);
      const manager = await act(
        t,
        tenant,
        r.case_id,
        actionBody("correct_outcome", closed.version, {
          observation_id: observationId,
        }),
        "PRACTICE_MANAGER",
      );
      expect(manager.statusCode, manager.body).toBe(200);
      const corrected = await ownerPool().query(
        "SELECT current_state,resolution_code,resolution_source,resolution_reference FROM access_cases WHERE id=$1",
        [r.case_id],
      );
      expect(corrected.rows[0]).toEqual({
        current_state: "BOOKED",
        resolution_code: "BOOKED",
        resolution_source: "IMPORT",
        resolution_reference: observationId,
      });
      const events = (await detail(t, tenant, r.case_id)).evidence;
      expect(events.verification.valid).toBe(true);
      expect(
        events.events.some(
          (e: { payload: { reason?: string } }) =>
            e.payload?.reason === "outcome_corrected",
        ),
      ).toBe(true);
    });

    it("a safety hold is reviewed and closed by staff; nothing external moves it", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant, { fixture: "urgent" });
      expect(r.state).toBe("EXCEPTION");
      const d = await detail(t, tenant, r.case_id);
      expect(d.work_items.map((w: { kind: string }) => w.kind)).toEqual([
        "SAFETY",
      ]);
      expect(d.referral.extraction).toBeNull();
      const external = await importRows(tenant, [
        {
          case_id: r.case_id,
          observation_type: "PATIENT_DECLINED",
          occurred_at: new Date().toISOString(),
          source_reference: "pms:x",
        },
      ]);
      expect(external.json().results[0].disposition).toBe("REVIEW");
      expect((await caseState(r.case_id)).current_state).toBe("EXCEPTION");
      const blocked = await act(
        t,
        tenant,
        r.case_id,
        actionBody("provide_information", r.version, {
          documents: ["insurance"],
        }),
      );
      expect(blocked.json().error).toBe("SAFETY_REVIEW_REQUIRED");
      const s = await caseState(r.case_id);
      const closed = await act(
        t,
        tenant,
        r.case_id,
        actionBody("close", s.version, {
          resolution_code: "REFERRED_ELSEWHERE",
        }),
      );
      expect(closed.statusCode, closed.body).toBe(200);
      expect((await caseState(r.case_id)).resolution_code).toBe(
        "REFERRED_ELSEWHERE",
      );
    });

    it("status contacts are counted without touching case state", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const before = await caseState(r.case_id);
      for (let i = 0; i < 2; i++) {
        const res = await t.app.inject({
          method: "POST",
          url: `/v1/cases/${r.case_id}/interactions`,
          headers: staff(tenant),
          payload: {
            command_id: randomUUID(),
            correlation_id: randomUUID(),
            intent: "STATUS_ENQUIRY",
            actor_type: "PATIENT",
            staff_seconds: 90,
          },
        });
        expect(res.statusCode, res.body).toBe(201);
      }
      expect(await caseState(r.case_id)).toEqual(before);
      const d = await detail(t, tenant, r.case_id);
      expect(d.metrics.status_enquiry_count).toMatchObject({
        value: 2,
        provenance: "OBSERVED",
      });
      expect(d.metrics.staff_seconds).toMatchObject({
        value: 180,
        provenance: "ESTIMATED",
      });
      expect(
        d.interactions.filter(
          (i: { intent: string; identity_verification_level: string }) =>
            i.intent === "STATUS_ENQUIRY",
        )[0].identity_verification_level,
      ).toBe("CLAIMED");
    });

    it("follow-up, booking request and cancellation move between bookable states", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      await drain(dispatcher([tenant]));
      const s = await caseState(r.case_id);
      const follow = await act(
        t,
        tenant,
        r.case_id,
        actionBody("record_follow_up", s.version, { staff_seconds: 120 }),
      );
      expect(follow.json().state).toBe("WAITING");
      await importRows(tenant, [
        {
          case_id: r.case_id,
          observation_type: "APPOINTMENT_CANCELLED",
          occurred_at: new Date().toISOString(),
          source_reference: "pms:cancel",
        },
      ]);
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
      await importRows(tenant, [
        {
          case_id: r.case_id,
          observation_type: "BOOKING_REQUESTED",
          occurred_at: new Date().toISOString(),
          source_reference: "pms:req",
        },
      ]);
      expect((await caseState(r.case_id)).current_state).toBe("WAITING");
      const referral = await ownerPool().query(
        "SELECT follow_up_count FROM referrals WHERE case_id=$1",
        [r.case_id],
      );
      expect(referral.rows[0].follow_up_count).toBe(1);
    });

    it("booking prerequisites from the rule set are enforced", async () => {
      const tenant = await newTenant({
        definition: ruleDefinition({
          booking_prerequisites: {
            require_destination_reference: true,
            required_fields: ["referral_date"],
          },
        }),
      });
      const r = await ingest(t, tenant);
      await drain(dispatcher([tenant]));
      const s = await caseState(r.case_id);
      const res = await act(
        t,
        tenant,
        r.case_id,
        actionBody("record_booking", s.version, {
          occurred_at: new Date().toISOString(),
        }),
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().message).toMatch(/referral_date/);
    });

    it("outcome times cannot be in the future or before receipt", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      await drain(dispatcher([tenant]));
      const s = await caseState(r.case_id);
      const future = await act(
        t,
        tenant,
        r.case_id,
        actionBody("record_booking", s.version, {
          occurred_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      );
      expect(future.json().error).toBe("OUTCOME_IN_FUTURE");
      const past = await act(
        t,
        tenant,
        r.case_id,
        actionBody("record_booking", s.version, {
          occurred_at: "2020-01-01T00:00:00Z",
        }),
      );
      expect(past.json().error).toBe("OUTCOME_BEFORE_RECEIPT");
    });

    it("an outcome recorded before receipt yields an unknown duration, never a negative or zero one", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      await drain(dispatcher([tenant]));
      const s = await caseState(r.case_id);
      const opened = (
        await ownerPool().query(
          "SELECT opened_at FROM access_cases WHERE id=$1",
          [r.case_id],
        )
      ).rows[0].opened_at as Date;
      const res = await act(
        t,
        tenant,
        r.case_id,
        actionBody("record_booking", s.version, {
          occurred_at: new Date(opened.getTime() - 30_000).toISOString(),
        }),
      );
      expect(res.statusCode, res.body).toBe(200);
      const d = await detail(t, tenant, r.case_id);
      expect(d.metrics.received_to_booked_seconds).toMatchObject({
        value: null,
        provenance: "UNKNOWN",
        inputs: { recorded_difference_seconds: -30 },
      });
      const from = new Date(opened.getTime() - 3600_000).toISOString();
      const to = new Date(Date.now() + 3600_000).toISOString();
      const m = (
        await t.app.inject({
          method: "GET",
          url: `/v1/metrics/cohort?from=${from}&to=${to}`,
          headers: staff(tenant),
        })
      ).json();
      expect(m.booked.value).toBe(1);
      expect(m.median_received_to_booked_seconds).toMatchObject({
        value: null,
        provenance: "UNKNOWN",
      });
    });

    it("READ_ONLY staff cannot act and do not see patient details", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      expect(
        (
          await act(
            t,
            tenant,
            r.case_id,
            actionBody("close", r.version, { resolution_code: "CANCELLED" }),
            "READ_ONLY",
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await t.app.inject({
            method: "POST",
            url: "/v1/referrals",
            headers: staff(tenant, "READ_ONLY"),
            payload: { ...{} },
          })
        ).statusCode,
      ).toBe(403);
      const view = await detail(t, tenant, r.case_id, "READ_ONLY");
      expect(view.referral.extraction.patient).toBe("[restricted]");
      expect(JSON.stringify(view)).not.toContain("Synthetic Patient");
      expect(view.evidence.events[0].payload).toBeUndefined();
      const full = await detail(t, tenant, r.case_id);
      expect(full.referral.extraction.patient.family_name).toBe("Patient");
    });

    it("queue filters, display references and next actions", async () => {
      const tenant = await newTenant();
      const missing = await ingest(t, tenant, { fixture: "missing-insurance" });
      const identity = await ingest(t, tenant, {
        fixture: "ambiguous-identity",
      });
      const queue = async (filter: string) =>
        (
          await t.app.inject({
            method: "GET",
            url: `/v1/cases?filter=${filter}`,
            headers: staff(tenant),
          })
        ).json().items;
      const attention = await queue("needs_attention");
      expect(
        attention.map((i: { case_id: string }) => i.case_id).sort(),
      ).toEqual([missing.case_id, identity.case_id].sort());
      const item = (await queue("information_missing"))[0];
      expect(item).toMatchObject({
        display_ref: `REF-${missing.case_id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        state: "INFORMATION_MISSING",
        next_action: "Obtain missing information: insurance",
        destination_status: "Not sent",
        outcome_status: "Not yet bookable",
      });
      expect(JSON.stringify(await queue("all"))).not.toMatch(
        /Synthetic|1980-01-01/,
      );
      expect((await queue("identity_pending"))[0].next_action).toBe(
        "Confirm patient identity",
      );
      const confirmed = await act(
        t,
        tenant,
        identity.case_id,
        actionBody("confirm_identity", identity.version),
      );
      expect(confirmed.json().state).toBe("DESTINATION_PENDING");
    });
  },
);
