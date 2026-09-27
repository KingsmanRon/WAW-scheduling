import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  bookAppointment,
  createHold,
  rescheduleAppointment,
  type CommandContext,
} from "../../packages/scheduling/src/index.js";
import { requestHash } from "../../packages/db/src/index.js";
import { closePools, databaseEnabled, ownerPool } from "../support/harness.js";
import {
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

/**
 * Real concurrency against PostgreSQL: every request runs in its own
 * transaction on its own connection (as concurrent API requests do), released
 * together. The invariant under test: a practitioner's exclusive time is
 * never held or booked twice.
 */
let pool: pg.Pool;
function apiLogin(): pg.Pool {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.username = "access_request";
  url.password = "integration-api";
  return new pg.Pool({ connectionString: url.toString(), max: 40 });
}

/** Outcome of a command: "ok" or its domain error code. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return code;
    throw e;
  }
}
function tally(results: string[]): Record<string, number> {
  return results.reduce<Record<string, number>>((acc, r) => {
    acc[r] = (acc[r] ?? 0) + 1;
    return acc;
  }, {});
}
async function occupying(
  p: TestPractice,
  practitionerId: string,
  start: Date,
  end: Date,
) {
  const rows = await ownerPool().query(
    `SELECT id,status FROM scheduling.appointments
      WHERE practice_id=$1 AND practitioner_id=$2
        AND status IN ('HELD','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED')
        AND occupied && tstzrange($3,$4,'[)')`,
    [p.practiceId, practitionerId, start, end],
  );
  return rows.rows as { id: string; status: string }[];
}

describe.runIf(databaseEnabled)("concurrent scheduling", () => {
  let p: TestPractice;
  const patients: string[] = [];
  beforeAll(async () => {
    pool = apiLogin();
    p = await newPractice();
    for (let i = 0; i < 25; i++) patients.push(await newPatient(p));
  });
  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  it("25 simultaneous bookings of one slot: exactly one confirmed, 24 SLOT_UNAVAILABLE", async () => {
    const start = slot(30, "09:00");
    const attempts = patients.map((patientId) => {
      const ctx = staffCtx(p);
      // Each request carries its own Idempotency-Key, as the API requires.
      // As in the API, a stored refusal is a committed response, not a throw.
      return run(
        ctx,
        (c) =>
          withIdempotency(
            c,
            {
              tenantId: p.tenantId,
              scopeId: p.practiceId,
              key: `race-${randomUUID()}`,
              operation: "appointment.create",
              requestHash: requestHash({ patientId, start }),
              actorId: ctx.actor.id,
            },
            async () => ({
              status: 201,
              body: {
                id: await bookAppointment(c, ctx, {
                  patientId,
                  appointmentTypeId: p.typeId,
                  practitionerId: p.practitionerIds[0],
                  locationId: p.locationId,
                  start,
                }),
              },
            }),
            storedRefusal,
          ),
        pool,
      ).then((r) =>
        r.status < 400 ? "ok" : (r.body as { error: string }).error,
      );
    });
    const results = await Promise.all(attempts);
    expect(tally(results)).toEqual({ ok: 1, SLOT_UNAVAILABLE: 24 });
    const booked = await occupying(
      p,
      p.practitionerIds[0],
      start,
      new Date(+start + 30 * 60_000),
    );
    expect(booked).toHaveLength(1);
    expect(booked[0]!.status).toBe("CONFIRMED");
    // Every refusal was recorded against its key as a 409 for replay.
    const stored = await ownerPool().query(
      `SELECT response_status, count(*)::int n FROM platform.idempotency_keys
        WHERE scope_id=$1 AND operation='appointment.create' AND idempotency_key LIKE 'race-%' GROUP BY 1 ORDER BY 1`,
      [p.practiceId],
    );
    expect(stored.rows).toEqual([
      { response_status: 201, n: 1 },
      { response_status: 409, n: 24 },
    ]);
  });

  it("the database alone admits exactly one of 25 concurrent overlapping inserts", async () => {
    // Bypasses the Scheduling Core (no practitioner lock, no checks): the
    // exclusion constraint is the invariant of last resort.
    const start = slot(31, "10:00");
    const results = await Promise.all(
      patients.map((patientId, i) =>
        outcome(
          run(
            staffCtx(p),
            (c) =>
              c.query(
                `INSERT INTO scheduling.appointments(tenant_id,practice_id,id,patient_id,practitioner_id,location_id,
                   appointment_type_id,status,starts_at,ends_at,timezone,duration_minutes,buffer_before_minutes,
                   buffer_after_minutes,occupied,source_channel,booked_by_actor_type,booked_by_actor_id)
                 VALUES($1,$2,$3,$4,$5,$6,$7,'CONFIRMED',$8,$9,'Africa/Johannesburg',30,0,0,'empty','OTHER','STAFF','user:race')`,
                [
                  p.tenantId,
                  p.practiceId,
                  randomUUID(),
                  patientId,
                  p.practitionerIds[1],
                  p.locationId,
                  p.typeId,
                  // Staggered, all overlapping 10:00-10:30.
                  new Date(+start + (i % 5) * 60_000),
                  new Date(+start + (30 + (i % 5)) * 60_000),
                ],
              ),
            pool,
          ),
        ),
      ),
    );
    expect(tally(results)).toEqual({ ok: 1, SLOT_UNAVAILABLE: 24 });
  });

  it("hold vs hold: one of ten concurrent holds wins", async () => {
    const start = slot(32, "11:00");
    const results = await Promise.all(
      patients.slice(0, 10).map((patientId) => {
        const ctx = patientCtx(p, patientId, randomUUID());
        return outcome(
          run(
            ctx,
            (c) =>
              createHold(c, ctx, {
                patientId,
                appointmentTypeId: p.typeId,
                practitionerId: p.practitionerIds[0],
                locationId: p.locationId,
                start,
              }),
            pool,
          ),
        );
      }),
    );
    expect(tally(results)).toEqual({ ok: 1, SLOT_UNAVAILABLE: 9 });
    const held = await occupying(
      p,
      p.practitionerIds[0],
      start,
      new Date(+start + 1800_000),
    );
    expect(held.map((h) => h.status)).toEqual(["HELD"]);
  });

  it("hold vs direct booking: exactly one of each racing pair wins", async () => {
    for (let round = 0; round < 5; round++) {
      const start = slot(33, `${String(9 + round).padStart(2, "0")}:00`);
      const wa = patientCtx(p, patients[round * 2]!, randomUUID());
      const desk = staffCtx(p);
      const results = await Promise.all([
        outcome(
          run(
            wa,
            (c) =>
              createHold(c, wa, {
                patientId: patients[round * 2]!,
                appointmentTypeId: p.typeId,
                practitionerId: p.practitionerIds[0],
                locationId: p.locationId,
                start,
              }),
            pool,
          ),
        ),
        outcome(
          run(
            desk,
            (c) =>
              bookAppointment(c, desk, {
                patientId: patients[round * 2 + 1]!,
                appointmentTypeId: p.typeId,
                practitionerId: p.practitionerIds[0],
                locationId: p.locationId,
                start,
              }),
            pool,
          ),
        ),
      ]);
      expect(results.sort()).toEqual(["SLOT_UNAVAILABLE", "ok"]);
      expect(
        await occupying(
          p,
          p.practitionerIds[0],
          start,
          new Date(+start + 1800_000),
        ),
      ).toHaveLength(1);
    }
  });

  it("booking vs booking with partially overlapping times: one wins", async () => {
    const base = slot(34, "14:00");
    const results = await Promise.all(
      patients.slice(0, 6).map((patientId, i) => {
        const ctx: CommandContext = staffCtx(p);
        return outcome(
          run(
            ctx,
            (c) =>
              bookAppointment(c, ctx, {
                patientId,
                appointmentTypeId: p.typeId,
                practitionerId: p.practitionerIds[1],
                locationId: p.locationId,
                // 14:00, 14:05, ... 14:25: every pair overlaps.
                start: new Date(+base + i * 5 * 60_000),
              }),
            pool,
          ),
        );
      }),
    );
    expect(tally(results)).toEqual({ ok: 1, SLOT_UNAVAILABLE: 5 });
  });

  it("reschedule vs booking into the same slot: exactly one gets it", async () => {
    for (let round = 0; round < 5; round++) {
      const day = 35 + round;
      const existing = await (async () => {
        const ctx = staffCtx(p);
        return run(ctx, (c) =>
          bookAppointment(c, ctx, {
            patientId: patients[20]!,
            appointmentTypeId: p.typeId,
            practitionerId: p.practitionerIds[0],
            locationId: p.locationId,
            start: slot(day, "09:00"),
          }),
        );
      })();
      const target = slot(day, "12:00");
      const mover = staffCtx(p);
      const booker = staffCtx(p);
      const results = await Promise.all([
        outcome(
          run(
            mover,
            (c) => rescheduleAppointment(c, mover, existing, { start: target }),
            pool,
          ),
        ),
        outcome(
          run(
            booker,
            (c) =>
              bookAppointment(c, booker, {
                patientId: patients[21]!,
                appointmentTypeId: p.typeId,
                practitionerId: p.practitionerIds[0],
                locationId: p.locationId,
                start: target,
              }),
            pool,
          ),
        ),
      ]);
      expect(results.sort()).toEqual(["SLOT_UNAVAILABLE", "ok"]);
      expect(
        await occupying(
          p,
          p.practitionerIds[0],
          target,
          new Date(+target + 1800_000),
        ),
      ).toHaveLength(1);
      // If the reschedule lost, the original is untouched.
      const original = await ownerPool().query(
        "SELECT status FROM scheduling.appointments WHERE id=$1",
        [existing],
      );
      expect(["CONFIRMED", "RESCHEDULED"]).toContain(original.rows[0].status);
    }
  });
});
