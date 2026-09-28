import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PracticeRole } from "../../packages/contracts/src/index.js";
import { tenantTx } from "../../packages/db/src/index.js";
import {
  apiPool,
  closePools,
  databaseEnabled,
  mintToken,
  ownerPool,
  testApi,
  type TestApi,
} from "../support/harness.js";
import {
  newPatient,
  newPractice,
  slot,
  type TestPractice,
} from "../support/scheduling.js";

async function grantPracticeRole(
  p: TestPractice,
  userId: string,
  role: PracticeRole,
  practitionerId: string | null = null,
) {
  await ownerPool().query(
    `INSERT INTO directory.practice_memberships(tenant_id,practice_id,user_id,role,status,display_name,practitioner_id,created_by,updated_by)
     VALUES($1,$2,$3,$4,'ACTIVE',$5,$6,'test','test')
     ON CONFLICT (tenant_id,practice_id,user_id) DO UPDATE SET role=excluded.role, practitioner_id=excluded.practitioner_id,
       version=directory.practice_memberships.version+1`,
    [p.tenantId, p.practiceId, userId, role, `${role} user`, practitionerId],
  );
}

describe.runIf(databaseEnabled)("practice scheduling API (JWT)", () => {
  let api: TestApi;
  let p: TestPractice;
  let q: TestPractice;
  const users: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let patient: string;
  beforeAll(async () => {
    api = await testApi({ auth: "jwt" });
    p = await newPractice();
    q = await newPractice();
    for (const role of [
      "PRACTICE_ADMIN",
      "RECEPTIONIST",
      "DOCTOR",
      "CLINICAL_STAFF",
      "READ_ONLY",
    ] as const) {
      users[role] = randomUUID();
      await grantPracticeRole(
        p,
        users[role]!,
        role,
        role === "DOCTOR" ? p.practitionerIds[0] : null,
      );
      tokens[role] = await mintToken(users[role]!);
    }
    users.OTHER = randomUUID();
    await grantPracticeRole(q, users.OTHER, "PRACTICE_ADMIN");
    tokens.OTHER = await mintToken(users.OTHER);
    patient = await newPatient(p);
  });
  afterAll(async () => {
    await api.close();
    await closePools();
  });
  const call = (
    method: "GET" | "POST" | "PATCH" | "PUT",
    url: string,
    as: string,
    payload?: unknown,
    key: string | null = randomUUID(),
  ) =>
    api.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${tokens[as]}`,
        ...(key && method !== "GET" ? { "idempotency-key": key } : {}),
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const path = (x: TestPractice, rest: string) =>
    `/v1/practices/${x.practiceId}${rest}`;
  const booking = (start: Date, patientId = patient) => ({
    patient_id: patientId,
    appointment_type_id: p.typeId,
    practitioner_id: p.practitionerIds[0],
    location_id: p.locationId,
    start: start.toISOString(),
    source_channel: "PHONE",
  });

  it("resolves the caller's practices and role server-side", async () => {
    const me = await call("GET", "/v1/me", "RECEPTIONIST");
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      tenant_id: null,
      auth_mode: "jwt",
      practices: [{ practice_id: p.practiceId, role: "RECEPTIONIST" }],
    });
    const context = await call("GET", path(p, "/context"), "RECEPTIONIST");
    expect(context.statusCode).toBe(200);
    expect(context.json().membership.permissions).toContain("appointment.book");
    expect(context.json().membership.permissions).not.toContain(
      "referral.document.read",
    );
  });

  it("books through the API with an Idempotency-Key and replays retries", async () => {
    const body = booking(slot(3, "09:00"));
    const missing = await call(
      "POST",
      path(p, "/appointments"),
      "RECEPTIONIST",
      body,
      null,
    );
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const key = randomUUID();
    const first = await call(
      "POST",
      path(p, "/appointments"),
      "RECEPTIONIST",
      body,
      key,
    );
    expect(first.statusCode).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBe("false");
    const appointment = first.json().appointment;
    expect(appointment).toMatchObject({
      status: "CONFIRMED",
      source_channel: "PHONE",
      booked_by: {
        actor_type: "STAFF",
        actor_id: `user:${users.RECEPTIONIST}`,
        role: "RECEPTIONIST",
      },
    });
    const retry = await call(
      "POST",
      path(p, "/appointments"),
      "RECEPTIONIST",
      body,
      key,
    );
    expect(retry.statusCode).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.json()).toEqual(first.json());
    const reused = await call(
      "POST",
      path(p, "/appointments"),
      "RECEPTIONIST",
      booking(slot(3, "10:00")),
      key,
    );
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error).toBe("IDEMPOTENCY_KEY_REUSED");
    // Another booking of the taken slot: explicit 409 SLOT_UNAVAILABLE.
    const other = await newPatient(p);
    const conflict = await call(
      "POST",
      path(p, "/appointments"),
      "RECEPTIONIST",
      booking(slot(3, "09:15"), other),
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: "SLOT_UNAVAILABLE",
      message: expect.any(String),
    });
    expect(conflict.body).not.toMatch(
      /exclusion|constraint|scheduling\.|stack/i,
    );
  });

  it("offers the same availability to every client and hides booked time", async () => {
    const from = slot(4, "08:00").toISOString();
    const to = slot(4, "10:00").toISOString();
    const url = path(
      p,
      `/availability?appointment_type_id=${p.typeId}&practitioner_id=${p.practitionerIds[0]}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    const before = (await call("GET", url, "READ_ONLY")).json().slots;
    expect(before.map((s: { start: string }) => s.start)).toContain(
      slot(4, "09:00").toISOString(),
    );
    await call(
      "POST",
      path(p, "/appointments"),
      "DOCTOR",
      booking(slot(4, "09:00")),
    );
    const after = (await call("GET", url, "READ_ONLY")).json().slots;
    expect(after.map((s: { start: string }) => s.start)).not.toContain(
      slot(4, "09:00").toISOString(),
    );
  });

  it("runs the hold, confirm, reschedule, check-in and cancel lifecycle", async () => {
    const hold = await call("POST", path(p, "/slot-holds"), "RECEPTIONIST", {
      ...booking(slot(5, "11:00")),
      session_ref: "console-flow-1",
    });
    expect(hold.statusCode).toBe(201);
    expect(hold.json().hold).toMatchObject({
      status: "ACTIVE",
      purpose: "BOOKING",
    });
    const holdId = hold.json().hold.id;
    const confirmed = await call(
      "POST",
      path(p, `/slot-holds/${holdId}/confirm`),
      "RECEPTIONIST",
      {},
    );
    expect(confirmed.statusCode).toBe(200);
    const id = confirmed.json().appointment.id;
    // The confirm request names no channel: it is recorded under the hold's.
    const created = await ownerPool().query(
      "SELECT channel FROM platform.audit_events WHERE tenant_id=$1 AND action='appointment.created' AND resource_id=$2",
      [p.tenantId, id],
    );
    expect(created.rows).toEqual([{ channel: "PHONE" }]);
    const confirmedEvent = await ownerPool().query(
      "SELECT channel FROM scheduling.appointment_events WHERE tenant_id=$1 AND appointment_id=$2 AND event_type='CONFIRMED'",
      [p.tenantId, id],
    );
    expect(confirmedEvent.rows).toEqual([{ channel: "PHONE" }]);
    const moved = await call(
      "POST",
      path(p, `/appointments/${id}/reschedule`),
      "RECEPTIONIST",
      {
        start: slot(5, "13:00").toISOString(),
        channel: "PHONE",
      },
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({
      previous_appointment_id: id,
      appointment: { status: "CONFIRMED", rescheduled_from_id: id },
    });
    const replacement = moved.json().appointment.id;
    const history = await call(
      "GET",
      path(p, `/appointments/${id}/history`),
      "READ_ONLY",
    );
    expect(
      history.json().items.map((e: { event_type: string }) => e.event_type),
    ).toEqual(["HELD", "CONFIRMED", "RESCHEDULED"]);
    const tooEarly = await call(
      "POST",
      path(p, `/appointments/${replacement}/check-in`),
      "RECEPTIONIST",
      {},
    );
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().error).toBe("CHECK_IN_WRONG_DAY");
    const cancelled = await call(
      "POST",
      path(p, `/appointments/${replacement}/cancel`),
      "RECEPTIONIST",
      {
        reason_code: "PATIENT_REQUEST",
        channel: "PHONE",
      },
    );
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().appointment.status).toBe("CANCELLED");
    const again = await call(
      "POST",
      path(p, `/appointments/${replacement}/cancel`),
      "RECEPTIONIST",
      {
        reason_code: "PATIENT_REQUEST",
      },
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("INVALID_TRANSITION");
  });

  it("lists history and the audit trail in id order across digit boundaries, and pages without gaps", async () => {
    // The next ids of both tables become ...98, ...99, 10...00: sorted as
    // text (the SELECTs return ids as text) they would come out of order.
    const nearBoundary = async (table: string) => {
      const owner = ownerPool();
      const seq = (
        await owner.query<{ s: string }>(
          "SELECT pg_get_serial_sequence($1,'id') AS s",
          [table],
        )
      ).rows[0]!.s;
      const last = Number(
        (
          await owner.query<{ v: string }>(
            `SELECT last_value::text AS v FROM ${seq}`,
          )
        ).rows[0]!.v,
      );
      await owner.query("SELECT setval($1::regclass, $2)", [
        seq,
        10 ** String(last + 3).length - 2,
      ]);
    };
    await nearBoundary("scheduling.appointment_events");
    await nearBoundary("platform.audit_events");
    const booked = await call(
      "POST",
      path(p, "/appointments"),
      "RECEPTIONIST",
      booking(slot(8, "10:00")),
    );
    expect(booked.statusCode).toBe(201);
    const id = booked.json().appointment.id;
    expect(
      (
        await call(
          "POST",
          path(p, `/appointments/${id}/cancel`),
          "RECEPTIONIST",
          { reason_code: "PATIENT_REQUEST" },
        )
      ).statusCode,
    ).toBe(200);
    const history = await call(
      "GET",
      path(p, `/appointments/${id}/history`),
      "READ_ONLY",
    );
    expect(
      history.json().items.map((e: { event_type: string }) => e.event_type),
    ).toEqual(["CONFIRMED", "CANCELLED"]);
    const trail = await call(
      "GET",
      path(p, `/audit-events?resource_type=appointment&resource_id=${id}`),
      "PRACTICE_ADMIN",
    );
    expect(trail.json().items.map((e: { action: string }) => e.action)).toEqual(
      ["appointment.cancelled", "appointment.created"],
    );
    // Page one entry at a time: newest first, each page strictly older.
    const seen: number[] = [];
    let before: string | null = null;
    for (let page = 0; page < 4; page++) {
      const res = await call(
        "GET",
        path(p, `/audit-events?limit=1${before ? `&before_id=${before}` : ""}`),
        "PRACTICE_ADMIN",
      );
      const body = res.json() as {
        items: { id: string }[];
        next_before_id: string | null;
      };
      seen.push(Number(body.items[0]!.id));
      before = body.next_before_id;
    }
    const newest = await ownerPool().query<{ id: string }>(
      "SELECT id FROM platform.audit_events WHERE tenant_id=$1 AND practice_id=$2 ORDER BY id DESC LIMIT 4",
      [p.tenantId, p.practiceId],
    );
    expect(seen).toEqual(newest.rows.map((r) => Number(r.id)));
  });

  it("enforces role permissions on every operation", async () => {
    const readOnlyBook = await call(
      "POST",
      path(p, "/appointments"),
      "READ_ONLY",
      booking(slot(6, "09:00")),
    );
    expect(readOnlyBook.statusCode).toBe(403);
    expect(
      (await call("GET", path(p, "/patients?q=syn"), "READ_ONLY")).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          "GET",
          path(
            p,
            "/calendar?from=" +
              encodeURIComponent(slot(6, "00:00").toISOString()) +
              "&to=" +
              encodeURIComponent(slot(7, "00:00").toISOString()),
          ),
          "READ_ONLY",
        )
      ).statusCode,
    ).toBe(200);
    const nurseBook = await call(
      "POST",
      path(p, "/appointments"),
      "CLINICAL_STAFF",
      booking(slot(6, "09:00")),
    );
    expect(nurseBook.statusCode).toBe(403);
    const receptionistHours = await call(
      "POST",
      path(p, "/availability-rules"),
      "RECEPTIONIST",
      {
        practitioner_id: p.practitionerIds[0],
        location_id: p.locationId,
        weekday: 6,
        start_minute: 1200,
        end_minute: 1260,
        valid_from: "2026-01-01",
      },
    );
    expect(receptionistHours.statusCode).toBe(403);
    expect(
      (await call("GET", path(p, "/audit-events"), "RECEPTIONIST")).statusCode,
    ).toBe(403);
    expect(
      (await call("GET", path(p, "/audit-events"), "PRACTICE_ADMIN"))
        .statusCode,
    ).toBe(200);
    // Doctors manage only their own time.
    const block = (practitionerId: string) =>
      call("POST", path(p, "/schedule-blocks"), "DOCTOR", {
        practitioner_id: practitionerId,
        reason_code: "ADMIN",
        start: slot(6, "16:00").toISOString(),
        end: slot(6, "16:30").toISOString(),
      });
    expect((await block(p.practitionerIds[1])).statusCode).toBe(403);
    expect((await block(p.practitionerIds[0])).statusCode).toBe(201);
  });

  it("stops a receptionist from raising their own privileges, in the API and in the database", async () => {
    const escalate = await call(
      "PUT",
      path(p, `/memberships/${users.RECEPTIONIST}`),
      "RECEPTIONIST",
      { role: "PRACTICE_ADMIN", status: "ACTIVE", display_name: "Me" },
    );
    expect(escalate.statusCode).toBe(403);
    // Even a direct write through the API database login is refused unless
    // the transaction's actor role is PRACTICE_ADMIN.
    await expect(
      tenantTx(
        p.tenantId,
        (c) =>
          c
            .query(
              "UPDATE directory.practice_memberships SET role='PRACTICE_ADMIN', version=version+1 WHERE user_id=$1",
              [users.RECEPTIONIST],
            )
            .then((r) => {
              if (!r.rowCount)
                throw new Error("row-level security: no rows updated");
            }),
        apiPool(),
        {
          practiceId: p.practiceId,
          actorRole: "RECEPTIONIST",
          userId: users.RECEPTIONIST,
        },
      ),
    ).rejects.toThrow(/row-level security/);
    const role = await ownerPool().query(
      "SELECT role FROM directory.practice_memberships WHERE practice_id=$1 AND user_id=$2",
      [p.practiceId, users.RECEPTIONIST],
    );
    expect(role.rows[0].role).toBe("RECEPTIONIST");
    // An administrator may change roles (audited) but not demote themselves.
    const selfDemote = await call(
      "PUT",
      path(p, `/memberships/${users.PRACTICE_ADMIN}`),
      "PRACTICE_ADMIN",
      { role: "RECEPTIONIST", status: "ACTIVE", display_name: "Admin" },
    );
    expect(selfDemote.statusCode).toBe(409);
    const promote = await call(
      "PUT",
      path(p, `/memberships/${users.CLINICAL_STAFF}`),
      "PRACTICE_ADMIN",
      {
        role: "DOCTOR",
        status: "ACTIVE",
        display_name: "Now a doctor",
        practitioner_id: p.practitionerIds[1],
      },
    );
    expect(promote.statusCode).toBe(200);
    const audit = await ownerPool().query(
      "SELECT action, changes FROM platform.audit_events WHERE practice_id=$1 AND resource_id=$2 ORDER BY id DESC LIMIT 1",
      [p.practiceId, users.CLINICAL_STAFF],
    );
    expect(audit.rows[0]).toMatchObject({
      action: "membership.upserted",
      changes: {
        before: { role: "CLINICAL_STAFF" },
        after: { role: "DOCTOR" },
      },
    });
  });

  it("keeps practices isolated: other practices, and their object ids, are unreachable", async () => {
    // A member of practice Q calling practice P's routes.
    const foreign = await call(
      "GET",
      path(
        p,
        "/calendar?from=" +
          encodeURIComponent(slot(1, "00:00").toISOString()) +
          "&to=" +
          encodeURIComponent(slot(2, "00:00").toISOString()),
      ),
      "OTHER",
    );
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error).toBe("PRACTICE_NOT_PERMITTED");
    // P's appointment id used through Q's path by Q's administrator.
    const ours = await call(
      "POST",
      path(p, "/appointments"),
      "RECEPTIONIST",
      booking(slot(8, "09:00")),
    );
    const id = ours.json().appointment.id;
    const viaOther = await call("GET", path(q, `/appointments/${id}`), "OTHER");
    expect(viaOther.statusCode).toBe(404);
    const cancelViaOther = await call(
      "POST",
      path(q, `/appointments/${id}/cancel`),
      "OTHER",
      {
        reason_code: "OTHER",
      },
    );
    expect(cancelViaOther.statusCode).toBe(404);
    const patientViaOther = await call(
      "GET",
      path(q, `/patients/${patient}`),
      "OTHER",
    );
    expect(patientViaOther.statusCode).toBe(404);
    // Booking P's patient with Q's configuration is impossible.
    const crossBooking = await call("POST", path(q, "/appointments"), "OTHER", {
      ...booking(slot(8, "10:00")),
      appointment_type_id: q.typeId,
      practitioner_id: q.practitionerIds[0],
      location_id: q.locationId,
    });
    expect(crossBooking.statusCode).toBe(404);
    expect(crossBooking.json().error).toBe("PATIENT_NOT_FOUND");
    const status = await ownerPool().query(
      "SELECT status FROM scheduling.appointments WHERE id=$1",
      [id],
    );
    expect(status.rows[0].status).toBe("CONFIRMED");
  });

  it("refuses anonymous, forged and expired credentials", async () => {
    const anonymous = await api.app.inject({
      method: "POST",
      url: path(p, "/appointments"),
      headers: { "idempotency-key": randomUUID() },
      payload: booking(slot(9, "09:00")),
    });
    expect(anonymous.statusCode).toBe(401);
    for (const token of [
      await mintToken(users.RECEPTIONIST!, { expiresIn: "-10m" }),
      await mintToken(users.RECEPTIONIST!, {
        secret: "a-different-secret-of-sufficient-length",
      }),
      await mintToken(users.RECEPTIONIST!, { audience: "anon" }),
      "not.a.jwt",
    ]) {
      const res = await api.app.inject({
        method: "GET",
        url: path(p, "/context"),
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    }
    // A valid token of a user with no membership of the practice.
    const stranger = await mintToken(randomUUID());
    const res = await api.app.inject({
      method: "GET",
      url: path(p, "/context"),
      headers: { authorization: `Bearer ${stranger}` },
    });
    expect(res.statusCode).toBe(403);
    // Suspension takes effect on the next request.
    await ownerPool().query(
      "UPDATE directory.practice_memberships SET status='SUSPENDED', version=version+1 WHERE practice_id=$1 AND user_id=$2",
      [p.practiceId, users.CLINICAL_STAFF],
    );
    expect(
      (await call("GET", path(p, "/context"), "CLINICAL_STAFF")).statusCode,
    ).toBe(403);
  });

  it("validates payloads strictly and never leaks internals", async () => {
    const extra = await call("POST", path(p, "/appointments"), "RECEPTIONIST", {
      ...booking(slot(10, "09:00")),
      tenant_id: q.tenantId,
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().error).toBe("VALIDATION_FAILED");
    const noOffset = await call(
      "POST",
      path(p, "/appointments"),
      "RECEPTIONIST",
      {
        ...booking(slot(10, "09:00")),
        start: "2026-10-05T09:00:00",
      },
    );
    expect(noOffset.statusCode).toBe(400);
    const badId = await call(
      "GET",
      path(p, "/appointments/not-a-uuid"),
      "RECEPTIONIST",
    );
    expect(badId.statusCode).toBe(400);
    expect(badId.body).not.toMatch(/at .*\.ts|node_modules/);
  });

  it("creates and finds patients through the API", async () => {
    const created = await call("POST", path(p, "/patients"), "RECEPTIONIST", {
      given_name: "Walk",
      family_name: "In",
      date_of_birth: "1992-02-02",
      source_channel: "WALK_IN",
      contacts: [{ kind: "MOBILE", value: "082 555 7788" }],
    });
    expect(created.statusCode).toBe(201);
    const found = await call(
      "GET",
      path(p, "/patients?mobile=%2B27825557788"),
      "RECEPTIONIST",
    );
    expect(found.json().items.map((x: { id: string }) => x.id)).toEqual([
      created.json().patient.id,
    ]);
    const byName = await call(
      "GET",
      path(p, "/patients?q=walk%20in"),
      "DOCTOR",
    );
    expect(byName.json().items).toHaveLength(1);
  });
});
