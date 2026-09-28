import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  DAY_MS,
  acceptWaitlistOffer,
  addToWaitlist,
  createWaitlistOffer,
  declineWaitlistOffer,
  localDateOf,
} from "../../packages/scheduling/src/index.js";
import { closePools, databaseEnabled, ownerPool } from "../support/harness.js";
import {
  TZ,
  newPatient,
  newPractice,
  patientCtx,
  run,
  slot,
  staffCtx,
  systemCtx,
  type TestPractice,
} from "../support/scheduling.js";

/**
 * Answers to one waitlist offer racing each other (the patient tapping twice,
 * staff answering for them at the same moment) in separate transactions on
 * separate connections, as they arrive in production. The invariants: an
 * offer is answered exactly once, and its slot ends either booked or free.
 */
let pool: pg.Pool;
function apiLogin(): pg.Pool {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.username = "access_request";
  url.password = "integration-api";
  return new pg.Pool({ connectionString: url.toString(), max: 20 });
}
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
/** A patient on the waitlist with a pending offer for a slot. */
async function offered(p: TestPractice, patientId: string, start: Date) {
  const staff = staffCtx(p);
  const entryId = await run(staff, (c) =>
    addToWaitlist(c, staff, {
      patientId,
      appointmentTypeId: p.typeId,
      earliestDate: localDateOf(Date.now(), TZ),
      latestDate: localDateOf(Date.now() + 30 * DAY_MS, TZ),
    }),
  );
  const system = systemCtx(p);
  const offer = await run(system, (c) =>
    createWaitlistOffer(c, system, {
      entryId,
      practitionerId: p.practitionerIds[0],
      locationId: p.locationId,
      start,
    }),
  );
  return { ...offer, entryId };
}
async function state(offerId: string) {
  const r = await ownerPool().query(
    `SELECT o.status AS offer, h.status AS hold, a.status AS appointment, e.status AS entry
       FROM scheduling.waitlist_offers o
       JOIN scheduling.slot_holds h ON h.appointment_id=o.appointment_id
       JOIN scheduling.appointments a ON a.id=o.appointment_id
       JOIN scheduling.waitlist_entries e ON e.id=o.waitlist_entry_id
      WHERE o.id=$1`,
    [offerId],
  );
  return r.rows[0];
}

describe.runIf(databaseEnabled)("waitlist offer concurrency", () => {
  beforeAll(() => {
    pool = apiLogin();
  });
  afterAll(async () => {
    await pool.end();
    await closePools();
  });

  it("an offer is taken exactly once, however many answers race", async () => {
    const p = await newPractice();
    const patient = await newPatient(p);
    const offer = await offered(p, patient, slot(3, "10:00"));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const ctx =
          i % 2
            ? staffCtx(p)
            : patientCtx(p, patient, `whatsapp:${randomUUID()}`);
        return outcome(
          run(ctx, (c) => acceptWaitlistOffer(c, ctx, offer.offerId), pool),
        );
      }),
    );
    expect(tally(results)).toEqual({
      ok: 1,
      WAITLIST_OFFER_NOT_PENDING: 11,
    });
    expect(await state(offer.offerId)).toEqual({
      offer: "ACCEPTED",
      hold: "CONSUMED",
      appointment: "CONFIRMED",
      entry: "BOOKED",
    });
    const live = await ownerPool().query(
      "SELECT count(*)::int AS n FROM scheduling.appointments WHERE patient_id=$1 AND status='CONFIRMED'",
      [patient],
    );
    expect(live.rows[0].n).toBe(1);
  });

  it("accepting and declining at once leaves exactly one consistent outcome", async () => {
    const p = await newPractice();
    for (let round = 0; round < 6; round++) {
      const patient = await newPatient(p);
      const offer = await offered(p, patient, slot(3 + round, "11:00"));
      const accepting = staffCtx(p);
      const declining = patientCtx(p, patient, `whatsapp:${randomUUID()}`);
      const [accepted, declined] = await Promise.all([
        outcome(
          run(
            accepting,
            (c) => acceptWaitlistOffer(c, accepting, offer.offerId),
            pool,
          ),
        ),
        outcome(
          run(
            declining,
            (c) => declineWaitlistOffer(c, declining, offer.offerId),
            pool,
          ),
        ),
      ]);
      expect([accepted, declined].filter((r) => r === "ok")).toHaveLength(1);
      expect([accepted, declined]).toContain("WAITLIST_OFFER_NOT_PENDING");
      expect(await state(offer.offerId)).toEqual(
        accepted === "ok"
          ? {
              offer: "ACCEPTED",
              hold: "CONSUMED",
              appointment: "CONFIRMED",
              entry: "BOOKED",
            }
          : {
              offer: "DECLINED",
              hold: "RELEASED",
              appointment: "CANCELLED",
              entry: "ACTIVE",
            },
      );
    }
  });

  it("two offers of one slot cannot both hold it", async () => {
    const p = await newPractice();
    const [a, b] = [await newPatient(p), await newPatient(p)];
    const staff = staffCtx(p);
    const entries = await Promise.all(
      [a, b].map((patientId) =>
        run(staff, (c) =>
          addToWaitlist(c, staff, {
            patientId,
            appointmentTypeId: p.typeId,
            earliestDate: localDateOf(Date.now(), TZ),
            latestDate: localDateOf(Date.now() + 30 * DAY_MS, TZ),
          }),
        ),
      ),
    );
    const start = slot(4, "15:00");
    const results = await Promise.all(
      entries.map((entryId) => {
        const system = systemCtx(p);
        return outcome(
          run(
            system,
            (c) =>
              createWaitlistOffer(c, system, {
                entryId,
                practitionerId: p.practitionerIds[0],
                locationId: p.locationId,
                start,
              }),
            pool,
          ),
        );
      }),
    );
    expect(tally(results)).toEqual({ ok: 1, SLOT_UNAVAILABLE: 1 });
  });
});
