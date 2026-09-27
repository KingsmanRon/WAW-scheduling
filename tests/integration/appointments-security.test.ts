import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { setLogSink } from "../../packages/observability/src/index.js";
import {
  actionBody,
  closePools,
  databaseEnabled,
  detail,
  dispatcher,
  drain,
  ingest,
  mock,
  newTenant,
  ownerPool,
  staff,
  testApi,
  type TestApi,
} from "../support/harness.js";

const TABLES = [
  "appointment_requests",
  "appointments",
  "appointment_slot_holds",
];
const CAPABILITIES = [
  "referral.create",
  "referral.status.read",
  "appointment.availability.read",
  "appointment.hold",
  "appointment.create",
  "appointment.reschedule",
  "appointment.cancel",
  "appointment.status.read",
];

/**
 * Appointment operations security: least privilege of the runtime roles on
 * the new tables, their immutability, and no patient data in refusals or
 * logs. Synthetic data only.
 */
describe.runIf(databaseEnabled)("appointment operations security", () => {
  let t: TestApi;
  /** The organisation whose booking the last test inspects. */
  let booked: { tenant: string; caseId: string } | null = null;
  beforeAll(async () => {
    t = await testApi();
  });
  afterAll(async () => {
    await t.close();
    await closePools();
  });

  const can = async (role: string, table: string, privilege: string) =>
    (
      await ownerPool().query("SELECT has_table_privilege($1,$2,$3) AS ok", [
        role,
        table,
        privilege,
      ])
    ).rows[0].ok as boolean;
  const canColumn = async (
    role: string,
    table: string,
    column: string,
    privilege: string,
  ) =>
    (
      await ownerPool().query(
        "SELECT has_column_privilege($1,$2,$3,$4) AS ok",
        [role, table, column, privilege],
      )
    ).rows[0].ok as boolean;

  it("the API writes requests but never appointments or holds; the worker never opens requests", async () => {
    // API (access_request): staff commands open and advance requests.
    expect(await can("access_request", "appointment_requests", "INSERT")).toBe(
      true,
    );
    expect(await can("access_request", "appointments", "INSERT")).toBe(false);
    expect(
      await can("access_request", "appointment_slot_holds", "INSERT"),
    ).toBe(false);
    // Only staff-owned appointment facts: confirmation, attested cancellation.
    for (const column of ["confirmation_status", "confirmed_by", "status"])
      expect(
        await canColumn("access_request", "appointments", column, "UPDATE"),
        column,
      ).toBe(true);
    for (const column of [
      "external_reference",
      "starts_at",
      "slot_reference",
      "tenant_id",
      "create_execution_id",
    ])
      expect(
        await canColumn("access_request", "appointments", column, "UPDATE"),
        column,
      ).toBe(false);
    for (const column of ["expires_at", "hold_reference", "tenant_id"])
      expect(
        await canColumn(
          "access_request",
          "appointment_slot_holds",
          column,
          "UPDATE",
        ),
        column,
      ).toBe(false);
    // The API never moves the outbox; the worker releases planned steps.
    expect(
      await canColumn("access_request", "outbox", "status", "UPDATE"),
    ).toBe(false);
    // Worker (access_worker): records foreign facts, never opens a request.
    expect(await can("access_worker", "appointment_requests", "INSERT")).toBe(
      false,
    );
    expect(await can("access_worker", "appointments", "INSERT")).toBe(true);
    for (const role of ["access_request", "access_worker"])
      for (const table of TABLES)
        for (const privilege of ["DELETE", "TRUNCATE"])
          expect(
            await can(role, table, privilege),
            `${role} ${privilege} ${table}`,
          ).toBe(false);
    // Browser roles (where the platform has them) get nothing.
    const browser = await ownerPool().query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')",
    );
    for (const { rolname } of browser.rows)
      for (const table of TABLES)
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"])
          expect(
            await can(rolname, table, privilege),
            `${rolname} ${privilege} ${table}`,
          ).toBe(false);
  });

  it("refusals and logs carry no patient details", async () => {
    const logs: string[] = [];
    const previous = setLogSink((line) => logs.push(line));
    try {
      const tenant = await newTenant();
      const connector = mock();
      const d = dispatcher([tenant], connector, { capabilities: CAPABILITIES });
      const r = await ingest(t, tenant);
      await drain(d);
      const referral = await detail(t, tenant, r.case_id);
      const patient = referral.referral.extraction.patient;
      expect(patient.family_name).toBeTruthy();
      const search = {
        from: new Date(Date.now() + 86_400_000).toISOString(),
        to: new Date(Date.now() + 8 * 86_400_000).toISOString(),
        timezone: "Africa/Johannesburg",
      };
      const started = await t.app.inject({
        method: "POST",
        url: `/v1/cases/${r.case_id}/actions`,
        headers: staff(tenant),
        payload: actionBody("start_booking", referral.case.version, {
          search,
        }),
      });
      expect(started.statusCode).toBe(200);
      const caseId = started.json().appointment_case_id as string;
      await drain(d);
      const step = (action: string, version: number, extra = {}) =>
        t.app.inject({
          method: "POST",
          url: `/v1/cases/${caseId}/appointment-actions`,
          headers: staff(tenant),
          payload: {
            action,
            command_id: randomUUID(),
            correlation_id: randomUUID(),
            expected_version: version,
            ...extra,
          },
        });
      const version = (await detail(t, tenant, caseId)).appointment_request
        .version;
      const referralNow = await detail(t, tenant, r.case_id);
      const refusals = [
        // A second booking for the same referral.
        await t.app.inject({
          method: "POST",
          url: `/v1/cases/${r.case_id}/actions`,
          headers: staff(tenant),
          payload: actionBody("start_booking", referralNow.case.version, {
            search,
          }),
        }),
        // Recording a booking by hand while ACCESS is booking.
        await t.app.inject({
          method: "POST",
          url: `/v1/cases/${r.case_id}/actions`,
          headers: staff(tenant),
          payload: actionBody("record_booking", referralNow.case.version, {
            occurred_at: new Date().toISOString(),
          }),
        }),
        await step("select", version, { slot_reference: "S-NOT-OFFERED" }),
        await step("commit", version),
        await step("select", version + 7, { slot_reference: "S-X" }),
        await step("attest_not_committed", version, { note: "probe" }),
        // Appointment steps on the referral case itself.
        await t.app.inject({
          method: "POST",
          url: `/v1/cases/${r.case_id}/appointment-actions`,
          headers: staff(tenant),
          payload: {
            action: "recheck",
            command_id: randomUUID(),
            correlation_id: randomUUID(),
            expected_version: 0,
          },
        }),
      ];
      const codes = refusals.map((x) => x.json().error);
      expect(codes).toEqual([
        "BOOKING_ALREADY_ACTIVE",
        "BOOKING_IN_PROGRESS",
        "SLOT_NOT_OFFERED",
        "INVALID_BOOKING_STEP",
        "VERSION_CONFLICT",
        "ATTESTATION_NOT_APPLICABLE",
        "APPOINTMENT_CASES_ONLY",
      ]);
      const secrets = [
        patient.given_name,
        patient.family_name,
        patient.date_of_birth,
        patient.external_id,
      ].filter(Boolean) as string[];
      for (const refusal of refusals)
        for (const secret of secrets)
          expect(refusal.body, refusal.json().error).not.toContain(secret);
      // Book it, so every worker log line of a booking is covered.
      const slot = (await detail(t, tenant, caseId)).appointment_request
        .availability.slots[0].slot_reference;
      await step("select", version, { slot_reference: slot });
      const selected = (await detail(t, tenant, caseId)).appointment_request
        .version;
      expect((await step("commit", selected)).statusCode).toBe(200);
      await drain(d);
      expect((await detail(t, tenant, caseId)).case.current_state).toBe(
        "BOOKED",
      );
      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs)
        for (const secret of secrets) expect(line).not.toContain(secret);
      booked = { tenant, caseId };
    } finally {
      setLogSink(previous);
    }
  });

  it("requests, appointments and holds cannot be deleted or truncated, even by the owner", async () => {
    expect(booked).not.toBeNull();
    const { tenant, caseId } = booked!;
    const where = {
      appointment_requests: "case_id=$2",
      appointments: "source_case_id=$2",
      appointment_slot_holds: "case_id=$2",
    } as const;
    for (const table of TABLES) {
      const rows = await ownerPool().query(
        `SELECT 1 FROM ${table} WHERE tenant_id=$1 AND ${where[table as keyof typeof where]}`,
        [tenant, caseId],
      );
      if (table !== "appointment_slot_holds")
        expect(rows.rowCount, table).toBeGreaterThan(0);
      if (rows.rowCount)
        await expect(
          ownerPool().query(
            `DELETE FROM ${table} WHERE tenant_id=$1 AND ${where[table as keyof typeof where]}`,
            [tenant, caseId],
          ),
          table,
        ).rejects.toThrow(/cannot be deleted/);
      await expect(
        ownerPool().query(`TRUNCATE ${table} CASCADE`),
        `truncate ${table}`,
      ).rejects.toThrow(/append-only/);
    }
  });
});
