import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  APPOINTMENT_STATUSES,
  bookAppointment,
  calendar,
  canTransition,
  cancelAppointment,
  confirmHold,
  createAvailabilityException,
  createHold,
  createScheduleBlock,
  expireStaleHolds,
  getAppointmentView,
  getHoldView,
  performAction,
  queryAvailability,
  releaseHold,
  rescheduleAppointment,
  updateAppointmentType,
} from "../../packages/scheduling/src/index.js";
import { requestHash } from "../../packages/db/src/index.js";
import {
  apiPool,
  closePools,
  databaseEnabled,
  ownerPool,
} from "../support/harness.js";
import {
  failure,
  newPatient,
  newPractice,
  patientCtx,
  run,
  slot,
  staffCtx,
  storedRefusal,
  withIdempotency,
  type TestPractice,
} from "../support/scheduling.js";

const book = (
  p: TestPractice,
  patientId: string,
  start: Date,
  practitioner = 0,
  over = {},
) => {
  const ctx = staffCtx(p);
  return run(ctx, (c) =>
    bookAppointment(c, ctx, {
      patientId,
      appointmentTypeId: p.typeId,
      practitionerId: p.practitionerIds[practitioner]!,
      locationId: p.locationId,
      start,
      ...over,
    }),
  );
};
const status = async (id: string) =>
  (
    await ownerPool().query(
      "SELECT status,version FROM scheduling.appointments WHERE id=$1",
      [id],
    )
  ).rows[0] as { status: string; version: number };
const outbox = async (aggregateId: string) =>
  (
    await ownerPool().query(
      "SELECT event_type,payload FROM platform.outbox_events WHERE aggregate_id=$1 ORDER BY id",
      [aggregateId],
    )
  ).rows as { event_type: string; payload: Record<string, unknown> }[];
const audits = async (resourceId: string) =>
  (
    await ownerPool().query(
      "SELECT action,actor_type,actor_id,channel,changes FROM platform.audit_events WHERE resource_id=$1 ORDER BY id",
      [resourceId],
    )
  ).rows as {
    action: string;
    actor_type: string;
    actor_id: string;
    channel: string;
  }[];
/** Move a hold (and its HELD appointment) into the past, as time would. */
const ageHold = async (holdId: string) => {
  const c = await ownerPool().connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(
      "UPDATE scheduling.slot_holds SET expires_at=now()-interval '1 second', created_at=now()-interval '10 minutes' WHERE id=$1",
      [holdId],
    );
    await c.query(
      `UPDATE scheduling.appointments SET hold_expires_at=now()-interval '1 second'
        WHERE id=(SELECT appointment_id FROM scheduling.slot_holds WHERE id=$1)`,
      [holdId],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
};

describe.runIf(databaseEnabled)("Scheduling Core (PostgreSQL)", () => {
  let p: TestPractice;
  let patient: string;
  let other: string;
  beforeAll(async () => {
    p = await newPractice();
    patient = await newPatient(p);
    other = await newPatient(p);
  });
  afterAll(closePools);

  it("books a confirmed appointment with its history, outbox event and audit record in one transaction", async () => {
    const start = slot(2, "09:00");
    const id = await book(p, patient, start);
    const ctx = staffCtx(p);
    const view = await run(ctx, (c) => getAppointmentView(c, ctx, id));
    expect(view).toMatchObject({
      status: "CONFIRMED",
      starts_at: start.toISOString(),
      duration_minutes: 30,
      source_channel: "PHONE",
      booked_by: { actor_type: "STAFF", role: "RECEPTIONIST" },
      appointment_type: { code: "CONSULT" },
    });
    expect((await outbox(id)).map((e) => e.event_type)).toEqual([
      "APPOINTMENT_CONFIRMED",
    ]);
    const trail = await audits(id);
    expect(trail[0]).toMatchObject({
      action: "appointment.created",
      actor_type: "STAFF",
      channel: "PHONE",
    });
    const events = await ownerPool().query(
      "SELECT event_type,from_status,to_status FROM scheduling.appointment_events WHERE appointment_id=$1",
      [id],
    );
    expect(events.rows).toEqual([
      { event_type: "CONFIRMED", from_status: null, to_status: "CONFIRMED" },
    ]);
    // The booked time disappears from availability for every channel.
    const slots = await run(ctx, (c) =>
      queryAvailability(c, ctx, {
        appointmentTypeId: p.typeId,
        from: new Date(+start - 3600_000),
        to: new Date(+start + 3600_000),
        practitionerId: p.practitionerIds[0],
      }),
    );
    expect(slots.map((s) => s.start)).not.toContain(start.toISOString());
    expect(
      slots.some(
        (s) => s.start === new Date(+start + 30 * 60_000).toISOString(),
      ),
    ).toBe(true);
    await expect(book(p, other, start)).rejects.toMatchObject({
      code: "SLOT_UNAVAILABLE",
      statusCode: 409,
    });
  });

  it("holds a slot for every channel, then confirms it atomically", async () => {
    const start = slot(2, "10:00");
    const session = randomUUID();
    const pctx = patientCtx(p, patient, session);
    const hold = await run(pctx, (c) =>
      createHold(c, pctx, {
        patientId: patient,
        appointmentTypeId: p.typeId,
        practitionerId: p.practitionerIds[0],
        locationId: p.locationId,
        start,
      }),
    );
    expect(await status(hold.appointmentId)).toMatchObject({ status: "HELD" });
    // The held slot is unavailable to staff and to other patients.
    expect(await failure(book(p, other, start))).toBe("SLOT_UNAVAILABLE");
    // Another conversation cannot confirm someone else's hold.
    const intruder = patientCtx(p, other, randomUUID());
    expect(
      await failure(
        run(intruder, (c) => confirmHold(c, intruder, hold.holdId)),
      ),
    ).toBe("HOLD_NOT_OWNED");
    const view = await run(pctx, (c) => getHoldView(c, pctx, hold.holdId));
    expect(view).toMatchObject({
      status: "ACTIVE",
      purpose: "BOOKING",
      owner: { channel: "WHATSAPP", actor_type: "PATIENT" },
      practitioner_id: p.practitionerIds[0],
      starts_at: start.toISOString(),
    });
    const id = await run(pctx, (c) => confirmHold(c, pctx, hold.holdId));
    expect(id).toBe(hold.appointmentId);
    expect(await status(id)).toMatchObject({ status: "CONFIRMED" });
    const closed = await ownerPool().query(
      "SELECT status,close_reason FROM scheduling.slot_holds WHERE id=$1",
      [hold.holdId],
    );
    expect(closed.rows[0]).toEqual({
      status: "CONSUMED",
      close_reason: "CONSUMED",
    });
    expect((await outbox(id)).map((e) => e.event_type)).toEqual([
      "APPOINTMENT_CONFIRMED",
    ]);
    // A consumed hold cannot be consumed again.
    expect(
      await failure(run(pctx, (c) => confirmHold(c, pctx, hold.holdId))),
    ).toBe("HOLD_NOT_ACTIVE");
  });

  it("never confirms an expired hold, and a lapsed hold blocks nobody even before the sweep", async () => {
    const start = slot(3, "11:00");
    const session = randomUUID();
    const pctx = patientCtx(p, patient, session);
    const hold = await run(pctx, (c) =>
      createHold(c, pctx, {
        patientId: patient,
        appointmentTypeId: p.typeId,
        practitionerId: p.practitionerIds[0],
        locationId: p.locationId,
        start,
      }),
    );
    await ageHold(hold.holdId);
    expect(
      await failure(run(pctx, (c) => confirmHold(c, pctx, hold.holdId))),
    ).toBe("HOLD_EXPIRED");
    // The database refuses it too, whatever the application does.
    await expect(
      run(pctx, (c) =>
        c.query(
          "UPDATE scheduling.slot_holds SET status='CONSUMED', closed_at=now(), close_reason='CONSUMED' WHERE id=$1",
          [hold.holdId],
        ),
      ),
    ).rejects.toMatchObject({ code: "HOLD_EXPIRED" });
    // Availability already ignores it...
    const ctx = staffCtx(p);
    const slots = await run(ctx, (c) =>
      queryAvailability(c, ctx, {
        appointmentTypeId: p.typeId,
        from: start,
        to: new Date(+start + 60_000),
        practitionerId: p.practitionerIds[0],
      }),
    );
    expect(slots.map((s) => s.start)).toEqual([start.toISOString()]);
    // ...and a new booking expires it in the same transaction.
    const id = await book(p, other, start);
    expect(await status(id)).toMatchObject({ status: "CONFIRMED" });
    expect(await status(hold.appointmentId)).toMatchObject({
      status: "EXPIRED",
    });
    expect((await outbox(hold.holdId)).map((e) => e.event_type)).toEqual([
      "HOLD_EXPIRED",
    ]);
  });

  it("expires holds in the background sweep and releases them on request", async () => {
    const ctx = staffCtx(p);
    const a = await run(ctx, (c) =>
      createHold(c, ctx, {
        patientId: patient,
        appointmentTypeId: p.typeId,
        practitionerId: p.practitionerIds[1],
        locationId: p.locationId,
        start: slot(3, "13:00"),
      }),
    );
    const b = await run(ctx, (c) =>
      createHold(c, ctx, {
        patientId: other,
        appointmentTypeId: p.typeId,
        practitionerId: p.practitionerIds[1],
        locationId: p.locationId,
        start: slot(3, "14:00"),
      }),
    );
    await ageHold(a.holdId);
    const swept = await run(ctx, (c) =>
      expireStaleHolds(c, ctx, { limit: 50 }),
    );
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await status(a.appointmentId)).toMatchObject({ status: "EXPIRED" });
    await run(ctx, (c) => releaseHold(c, ctx, b.holdId));
    expect(await status(b.appointmentId)).toMatchObject({
      status: "CANCELLED",
    });
    // The released time is bookable again.
    const id = await book(p, other, slot(3, "14:00"), 1);
    expect(await status(id)).toMatchObject({ status: "CONFIRMED" });
  });

  it("reschedules by replacing the appointment and keeping the original's history", async () => {
    const id = await book(p, patient, slot(4, "09:00"));
    const ctx = staffCtx(p);
    // Moving 15 minutes later overlaps the original: its own time is no obstacle.
    const replacement = await run(ctx, (c) =>
      rescheduleAppointment(c, ctx, id, { start: slot(4, "09:15") }),
    );
    expect(await status(id)).toMatchObject({ status: "RESCHEDULED" });
    const original = await run(ctx, (c) => getAppointmentView(c, ctx, id));
    const moved = await run(ctx, (c) =>
      getAppointmentView(c, ctx, replacement),
    );
    expect(original.rescheduled_to_id).toBe(replacement);
    expect(moved.rescheduled_from_id).toBe(id);
    expect(moved.status).toBe("CONFIRMED");
    expect(moved.starts_at).toBe(slot(4, "09:15").toISOString());
    const events = await outbox(replacement);
    expect(events.map((e) => e.event_type)).toEqual([
      "APPOINTMENT_RESCHEDULED",
    ]);
    expect(events[0]!.payload.previous_appointment_id).toBe(id);
    expect((await audits(id)).map((a) => a.action)).toContain(
      "appointment.rescheduled",
    );
    // The original cannot be rescheduled, cancelled or checked in again.
    expect(
      await failure(
        run(ctx, (c) =>
          cancelAppointment(c, ctx, id, { reasonCode: "PATIENT_REQUEST" }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
  });

  it("reschedules through a patient channel with a hold, cancelling nothing until confirmed", async () => {
    const id = await book(p, patient, slot(5, "09:00"));
    const session = randomUUID();
    const pctx = patientCtx(p, patient, session);
    const hold = await run(pctx, (c) =>
      createHold(c, pctx, {
        patientId: patient,
        appointmentTypeId: p.typeId,
        practitionerId: p.practitionerIds[1],
        locationId: p.locationId,
        start: slot(5, "15:00"),
        purpose: "RESCHEDULE",
        rescheduleOfId: id,
      }),
    );
    expect(await status(id)).toMatchObject({ status: "CONFIRMED" });
    // A second concurrent reschedule of the same appointment is refused.
    expect(
      await failure(
        run(pctx, (c) =>
          createHold(c, pctx, {
            patientId: patient,
            appointmentTypeId: p.typeId,
            practitionerId: p.practitionerIds[1],
            locationId: p.locationId,
            start: slot(5, "16:00"),
            purpose: "RESCHEDULE",
            rescheduleOfId: id,
          }),
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    const replacement = await run(pctx, (c) =>
      confirmHold(c, pctx, hold.holdId),
    );
    expect(await status(id)).toMatchObject({ status: "RESCHEDULED" });
    const moved = await run(pctx, (c) =>
      getAppointmentView(c, pctx, replacement),
    );
    expect(moved).toMatchObject({
      status: "CONFIRMED",
      rescheduled_from_id: id,
      practitioner: { id: p.practitionerIds[1] },
    });
  });

  it("cancels, frees the slot for others and releases pending replacement holds", async () => {
    const start = slot(6, "09:00");
    const id = await book(p, patient, start);
    const pctx = patientCtx(p, patient, randomUUID());
    const replacementHold = await run(pctx, (c) =>
      createHold(c, pctx, {
        patientId: patient,
        appointmentTypeId: p.typeId,
        practitionerId: p.practitionerIds[0],
        locationId: p.locationId,
        start: slot(6, "12:00"),
        purpose: "RESCHEDULE",
        rescheduleOfId: id,
      }),
    );
    const ctx = staffCtx(p);
    await run(ctx, (c) =>
      cancelAppointment(c, ctx, id, {
        reasonCode: "PATIENT_REQUEST",
        note: "Patient called to cancel",
      }),
    );
    expect(await status(id)).toMatchObject({ status: "CANCELLED" });
    expect(await status(replacementHold.appointmentId)).toMatchObject({
      status: "CANCELLED",
    });
    const cancelled = (await outbox(id)).find(
      (e) => e.event_type === "APPOINTMENT_CANCELLED",
    );
    expect(cancelled?.payload).toMatchObject({
      reason_code: "PATIENT_REQUEST",
      slot_freed: true,
    });
    expect(await status(await book(p, other, start))).toMatchObject({
      status: "CONFIRMED",
    });
  });

  it("follows the state machine for check-in, start, completion and no-show", async () => {
    const ctx = staffCtx(p, "RECEPTIONIST");
    // A walk-in seen now: staff may book a start from the last few minutes
    // (override, because "now" may fall outside test working hours).
    const now = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    const walkIn = await run(ctx, (c) =>
      bookAppointment(c, ctx, {
        patientId: patient,
        appointmentTypeId: p.typeId,
        practitionerId: p.practitionerIds[1],
        locationId: p.locationId,
        start: now,
        overrideAvailability: true,
      }),
    );
    expect(
      await failure(run(ctx, (c) => performAction(c, ctx, walkIn, "complete"))),
    ).toBe("INVALID_TRANSITION");
    await run(ctx, (c) => performAction(c, ctx, walkIn, "check_in"));
    await run(ctx, (c) => performAction(c, ctx, walkIn, "start"));
    await run(ctx, (c) => performAction(c, ctx, walkIn, "complete"));
    expect(await status(walkIn)).toMatchObject({ status: "COMPLETED" });
    expect((await outbox(walkIn)).map((e) => e.event_type)).toEqual([
      "APPOINTMENT_CONFIRMED",
      "PATIENT_CHECKED_IN",
      "APPOINTMENT_STARTED",
      "APPOINTMENT_COMPLETED",
    ]);
    expect((await audits(walkIn)).map((a) => a.action)).toEqual([
      "appointment.created",
      "appointment.availability_overridden",
      "appointment.checked_in",
      "appointment.started",
      "appointment.completed",
    ]);
    // Check-in only on the appointment's day; no-show only after its start.
    const future = await book(p, other, slot(7, "10:00"), 1);
    expect(
      await failure(run(ctx, (c) => performAction(c, ctx, future, "check_in"))),
    ).toBe("CHECK_IN_WRONG_DAY");
    expect(
      await failure(run(ctx, (c) => performAction(c, ctx, future, "no_show"))),
    ).toBe("TRANSITION_TOO_EARLY");
    // Stale versions are refused.
    expect(
      await failure(
        run(ctx, (c) =>
          cancelAppointment(c, ctx, future, {
            reasonCode: "PRACTICE_REQUEST",
            expectedVersion: 7,
          }),
        ),
      ),
    ).toBe("VERSION_CONFLICT");
  });

  it("enforces the state machine in the database for every writer", async () => {
    const id = await book(p, patient, slot(8, "09:00"));
    const ctx = staffCtx(p);
    await run(ctx, (c) =>
      cancelAppointment(c, ctx, id, { reasonCode: "PRACTICE_REQUEST" }),
    );
    await expect(
      run(ctx, (c) =>
        c.query(
          "UPDATE scheduling.appointments SET status='CONFIRMED', version=version+1 WHERE id=$1",
          [id],
        ),
      ),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(
      run(ctx, (c) =>
        c.query(
          "UPDATE scheduling.appointments SET starts_at=starts_at+interval '1 hour', version=version+1 WHERE id=$1",
          [id],
        ),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      run(ctx, (c) =>
        c.query("DELETE FROM scheduling.appointments WHERE id=$1", [id]),
      ),
    ).rejects.toThrow(/permission denied/);
    // The SQL transition table and the domain table are the same.
    const pairs = await ownerPool().query<{
      f: string;
      t: string;
      ok: boolean;
    }>(
      `SELECT f, t, scheduling.appointment_transition_allowed(f, t) AS ok
         FROM unnest($1::text[]) f CROSS JOIN unnest($1::text[]) t`,
      [APPOINTMENT_STATUSES],
    );
    for (const r of pairs.rows)
      expect(r.ok, `${r.f}>${r.t}`).toBe(
        canTransition(r.f as never, r.t as never),
      );
  });

  it("guarantees no overlap at the database level even if application checks are bypassed", async () => {
    const start = slot(9, "09:00");
    const id = await book(p, patient, start);
    const row = (
      await ownerPool().query(
        "SELECT * FROM scheduling.appointments WHERE id=$1",
        [id],
      )
    ).rows[0];
    const ctx = staffCtx(p);
    await expect(
      run(ctx, (c) =>
        c.query(
          `INSERT INTO scheduling.appointments(tenant_id,practice_id,id,patient_id,practitioner_id,location_id,appointment_type_id,
             status,starts_at,ends_at,timezone,duration_minutes,buffer_before_minutes,buffer_after_minutes,occupied,
             source_channel,booked_by_actor_type,booked_by_actor_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,'CONFIRMED',$8,$9,'Africa/Johannesburg',30,0,0,'empty','OTHER','STAFF','user:x')`,
          [
            p.tenantId,
            p.practiceId,
            randomUUID(),
            other,
            row.practitioner_id,
            row.location_id,
            row.appointment_type_id,
            new Date(+start + 10 * 60_000),
            new Date(+start + 40 * 60_000),
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE" });
  });

  it("applies appointment-type rules, referrals and availability to every booking", async () => {
    const ctx = staffCtx(p, "PRACTICE_ADMIN");
    // Outside working hours: refused unless an authorised override is used.
    expect(await failure(book(p, patient, slot(10, "18:00")))).toBe(
      "OUTSIDE_AVAILABILITY",
    );
    const noOverride = staffCtx(p, "RECEPTIONIST", {
      mayOverrideAvailability: false,
    });
    expect(
      await failure(
        run(noOverride, (c) =>
          bookAppointment(c, noOverride, {
            patientId: patient,
            appointmentTypeId: p.typeId,
            practitionerId: p.practitionerIds[0],
            locationId: p.locationId,
            start: slot(10, "18:00"),
            overrideAvailability: true,
          }),
        ),
      ),
    ).toBe("OVERRIDE_NOT_PERMITTED");
    // Leave and blocks remove availability.
    await run(ctx, (c) =>
      createAvailabilityException(c, ctx, {
        practitionerId: p.practitionerIds[0],
        kind: "UNAVAILABLE",
        reasonCode: "LEAVE",
        start: slot(11, "00:00"),
        end: slot(12, "00:00"),
      }),
    );
    expect(await failure(book(p, patient, slot(11, "09:00")))).toBe(
      "OUTSIDE_AVAILABILITY",
    );
    await run(ctx, (c) =>
      createScheduleBlock(c, ctx, {
        practitionerId: p.practitionerIds[1],
        reasonCode: "MEETING",
        start: slot(11, "12:00"),
        end: slot(11, "13:00"),
      }),
    );
    expect(await failure(book(p, patient, slot(11, "12:15"), 1))).toBe(
      "OUTSIDE_AVAILABILITY",
    );
    // A block over a booked appointment must be acknowledged.
    const booked = await book(p, other, slot(11, "15:00"), 1);
    expect(
      await failure(
        run(ctx, (c) =>
          createScheduleBlock(c, ctx, {
            practitionerId: p.practitionerIds[1],
            reasonCode: "EMERGENCY",
            start: slot(11, "14:30"),
            end: slot(11, "16:00"),
          }),
        ),
      ),
    ).toBe("SCHEDULE_BLOCK_CONFLICT");
    expect(await status(booked)).toMatchObject({ status: "CONFIRMED" });
    // Referral-required types cannot be booked without a valid referral.
    await run(ctx, (c) =>
      updateAppointmentType(c, ctx, p.typeId, { requiresReferral: true }),
    );
    try {
      expect(await failure(book(p, patient, slot(13, "09:00")))).toBe(
        "REFERRAL_REQUIRED",
      );
    } finally {
      await run(ctx, (c) =>
        updateAppointmentType(c, ctx, p.typeId, { requiresReferral: false }),
      );
    }
    // Patients may not book staff-only types through a channel.
    await run(ctx, (c) =>
      updateAppointmentType(c, ctx, p.typeId, { patientBookable: false }),
    );
    try {
      const pctx = patientCtx(p, patient, randomUUID());
      expect(
        await failure(
          run(pctx, (c) =>
            createHold(c, pctx, {
              patientId: patient,
              appointmentTypeId: p.typeId,
              practitionerId: p.practitionerIds[0],
              locationId: p.locationId,
              start: slot(13, "10:00"),
            }),
          ),
        ),
      ).toBe("CHANNEL_NOT_PERMITTED");
    } finally {
      await run(ctx, (c) =>
        updateAppointmentType(c, ctx, p.typeId, { patientBookable: true }),
      );
    }
    // A patient cannot be in two appointments at once.
    await book(p, patient, slot(14, "09:00"), 0);
    expect(await failure(book(p, patient, slot(14, "09:15"), 1))).toBe(
      "PATIENT_SCHEDULE_CONFLICT",
    );
  });

  it("replays idempotent commands and refuses a reused key with a different request", async () => {
    const ctx = staffCtx(p);
    const key = `test-${randomUUID()}`;
    const exec = (start: Date, patientId = patient) =>
      run(ctx, (c) =>
        withIdempotency(
          c,
          {
            tenantId: p.tenantId,
            scopeId: p.practiceId,
            key,
            operation: "appointment.create",
            requestHash: requestHash({ patientId, start }),
            actorId: ctx.actor.id,
          },
          async () => {
            const id = await bookAppointment(c, ctx, {
              patientId,
              appointmentTypeId: p.typeId,
              practitionerId: p.practitionerIds[0],
              locationId: p.locationId,
              start,
            });
            return {
              status: 201,
              body: { id },
              resourceType: "appointment",
              resourceId: id,
            };
          },
          storedRefusal,
        ),
      );
    const first = await exec(slot(15, "09:00"));
    const second = await exec(slot(15, "09:00"));
    expect(first).toMatchObject({ status: 201, replayed: false });
    expect(second).toEqual({ ...first, replayed: true });
    const count = await ownerPool().query(
      "SELECT count(*)::int n FROM scheduling.appointments WHERE practice_id=$1 AND starts_at=$2",
      [p.practiceId, slot(15, "09:00")],
    );
    expect(count.rows[0].n).toBe(1);
    await expect(exec(slot(15, "10:00"))).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      statusCode: 422,
    });
    // A deterministic refusal is stored and replayed too.
    const refusedKey = `test-${randomUUID()}`;
    const refused = () =>
      run(ctx, (c) =>
        withIdempotency(
          c,
          {
            tenantId: p.tenantId,
            scopeId: p.practiceId,
            key: refusedKey,
            operation: "appointment.create",
            requestHash: requestHash({ other, at: slot(15, "09:00") }),
            actorId: ctx.actor.id,
          },
          async () => {
            await bookAppointment(c, ctx, {
              patientId: other,
              appointmentTypeId: p.typeId,
              practitionerId: p.practitionerIds[0],
              locationId: p.locationId,
              start: slot(15, "09:00"),
            });
            return { status: 201, body: {} };
          },
          storedRefusal,
        ),
      );
    expect(await refused()).toMatchObject({
      status: 409,
      body: { error: "SLOT_UNAVAILABLE" },
      replayed: false,
    });
    expect(await refused()).toMatchObject({ status: 409, replayed: true });
  });

  it("renders a calendar with working hours, blocks and appointments in a bounded set of queries", async () => {
    const ctx = staffCtx(p);
    const from = slot(20, "00:00");
    const to = slot(21, "00:00");
    const id = await book(p, patient, slot(20, "09:00"));
    const view = await run(ctx, (c) => calendar(c, ctx, { from, to }));
    expect(view.practitioners.map((x) => x.id).sort()).toEqual(
      [...p.practitionerIds].sort(),
    );
    expect(view.working_windows).toHaveLength(2);
    expect(view.working_windows[0]).toMatchObject({
      start: slot(20, "08:00").toISOString(),
      end: slot(20, "17:00").toISOString(),
    });
    expect(view.appointments.map((a) => a.id)).toEqual([id]);
    expect(view.truncated).toBe(false);
  });

  it("keeps practices apart: another practice's ids resolve to nothing", async () => {
    const q = await newPractice();
    const theirs = await book(q, await newPatient(q), slot(2, "09:00"));
    const ours = staffCtx(p);
    expect(
      await failure(run(ours, (c) => getAppointmentView(c, ours, theirs))),
    ).toBe("APPOINTMENT_NOT_FOUND");
    expect(
      await failure(
        run(ours, (c) =>
          cancelAppointment(c, ours, theirs, { reasonCode: "OTHER" }),
        ),
      ),
    ).toBe("APPOINTMENT_NOT_FOUND");
    // Even with a forged practice context the API login sees no rows of it.
    const leaked = await run(
      { ...ours, practiceId: p.practiceId },
      (c) =>
        c.query(
          "SELECT count(*)::int n FROM scheduling.appointments WHERE practice_id=$1",
          [q.practiceId],
        ),
      apiPool(),
    );
    expect(leaked.rows[0].n).toBe(0);
  });
});
