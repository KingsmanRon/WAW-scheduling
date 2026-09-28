import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Metrics } from "@access/observability";
import {
  bookAppointment,
  createHold,
} from "../../packages/scheduling/src/index.js";
import {
  platformRoutes,
  extendRoutes,
} from "../../apps/worker/src/platform/routes.js";
import { startHealthServer } from "../../apps/worker/src/platform/health.js";
import { closePools, databaseEnabled, ownerPool } from "../support/harness.js";
import {
  asTimePasses,
  connectWhatsApp,
  consent,
  deliveries,
  testPlatform,
} from "../support/platform.js";
import {
  newPatient,
  newPractice,
  patientCtx,
  run,
  slot,
  staffCtx,
  type TestPractice,
} from "../support/scheduling.js";

async function outbox(p: TestPractice) {
  return (
    await ownerPool().query<{
      id: string;
      event_type: string;
      status: string;
      attempts: number;
      last_error_code: string | null;
      available_at: Date;
      processed_at: Date | null;
    }>(
      `SELECT id::text, event_type, status, attempts, last_error_code, available_at, processed_at
         FROM platform.outbox_events WHERE tenant_id=$1 ORDER BY id`,
      [p.tenantId],
    )
  ).rows;
}
function book(p: TestPractice, patientId: string, start: Date) {
  const ctx = staffCtx(p);
  return run(ctx, (c) =>
    bookAppointment(c, ctx, {
      patientId,
      appointmentTypeId: p.typeId,
      practitionerId: p.practitionerIds[0],
      locationId: p.locationId,
      start,
    }),
  );
}

/** A working-hours start between `min` and `max` hours from now. */
function startBetween(min: number, max: number): Date {
  for (const day of [1, 2, 3])
    for (let hour = 8; hour <= 16; hour++) {
      const start = slot(day, `${String(hour).padStart(2, "0")}:00`);
      const lead = (+start - Date.now()) / 3600_000;
      if (lead > min && lead < max) return start;
    }
  throw new Error("no working-hours slot in range");
}

describe.runIf(databaseEnabled)("outbox routing and housekeeping", () => {
  afterAll(closePools);

  it("a failing handler rolls back its partial effects, retries with backoff, then fails for an operator", async () => {
    const p = await newPractice();
    const patient = await newPatient(p);
    await consent(p, patient, { whatsapp: true });
    let failures = 0;
    const platform = testPlatform(p.tenantId, {
      outboxMaxAttempts: 2,
      routes: (plan) =>
        extendRoutes(platformRoutes(plan), {
          APPOINTMENT_CONFIRMED: [
            async () => {
              failures++;
              throw Object.assign(new Error("downstream"), { code: "XX000" });
            },
          ],
        }),
    });
    await book(p, patient, slot(3, "10:00"));
    await platform.outbox.run(p.tenantId);
    let [event] = await outbox(p);
    expect(event).toMatchObject({
      status: "PENDING",
      attempts: 1,
      last_error_code: "HANDLER_XX000",
    });
    expect(+event!.available_at).toBeGreaterThan(Date.now() + 5_000);
    // The planning handler ran before the failure; its rows were rolled back.
    expect(await deliveries(p)).toEqual([]);
    await ownerPool().query(
      "UPDATE platform.outbox_events SET available_at=now() WHERE tenant_id=$1",
      [p.tenantId],
    );
    await platform.outbox.run(p.tenantId);
    [event] = await outbox(p);
    expect(event).toMatchObject({ status: "FAILED", attempts: 2 });
    expect(failures).toBe(2);
    expect(await platform.outbox.run(p.tenantId)).toBe(0);
    expect(
      platform.metrics.snapshot()[
        'access_outbox_events_failed_total{event_type="APPOINTMENT_CONFIRMED"}'
      ],
    ).toBe(1);
  });

  it("handles one aggregate's events in order, even when the first is backing off", async () => {
    const p = await newPractice();
    const aggregate = randomUUID();
    const insert = (type: string, availableIn: string) =>
      ownerPool().query(
        `INSERT INTO platform.outbox_events(tenant_id, practice_id, event_type, aggregate_type, aggregate_id, payload,
                                            correlation_id, available_at)
         VALUES($1,$2,$3,'appointment',$4,'{}',$5, now() + $6::interval)`,
        [p.tenantId, p.practiceId, type, aggregate, randomUUID(), availableIn],
      );
    await insert("HOLD_RELEASED", "1 hour");
    await insert("HOLD_EXPIRED", "0 seconds");
    const platform = testPlatform(p.tenantId);
    expect(await platform.outbox.run(p.tenantId)).toBe(0);
    expect((await outbox(p)).map((e) => e.status)).toEqual([
      "PENDING",
      "PENDING",
    ]);
    await ownerPool().query(
      "UPDATE platform.outbox_events SET available_at=now() WHERE tenant_id=$1",
      [p.tenantId],
    );
    expect(await platform.outbox.run(p.tenantId)).toBe(2);
    const [first, second] = await outbox(p);
    expect(first!.status).toBe("PROCESSED");
    expect(+first!.processed_at!).toBeLessThanOrEqual(+second!.processed_at!);
  });

  it("records lapsed holds as expired through the Scheduling Core", async () => {
    const p = await newPractice();
    const patient = await newPatient(p);
    const ctx = patientCtx(p, patient, `wa:${randomUUID()}`);
    const hold = await run(ctx, (c) =>
      createHold(c, ctx, {
        patientId: patient,
        appointmentTypeId: p.typeId,
        practitionerId: p.practitionerIds[0],
        locationId: p.locationId,
        start: slot(3, "09:00"),
      }),
    );
    await asTimePasses([
      [
        "UPDATE scheduling.slot_holds SET expires_at=now()-interval '1 second', created_at=now()-interval '10 minutes' WHERE id=$1",
        [hold.holdId],
      ],
      [
        "UPDATE scheduling.appointments SET hold_expires_at=now()-interval '1 second' WHERE id=$1",
        [hold.appointmentId],
      ],
    ]);
    const platform = testPlatform(p.tenantId);
    expect(await platform.sweeps.expireHolds(p.tenantId)).toBe(1);
    expect(await platform.sweeps.expireHolds(p.tenantId)).toBe(0);
    const state = await ownerPool().query(
      `SELECT h.status AS hold, a.status AS appointment FROM scheduling.slot_holds h
         JOIN scheduling.appointments a ON a.id=h.appointment_id WHERE h.id=$1`,
      [hold.holdId],
    );
    expect(state.rows[0]).toEqual({ hold: "EXPIRED", appointment: "EXPIRED" });
    expect((await outbox(p)).map((e) => e.event_type)).toContain(
      "HOLD_EXPIRED",
    );
    // The appointment's history says who expired it and when.
    const history = await ownerPool().query(
      "SELECT event_type, actor_type, actor_id FROM scheduling.appointment_events WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY id",
      [p.tenantId, hold.appointmentId],
    );
    expect(history.rows.at(-1)).toEqual({
      event_type: "EXPIRED",
      actor_type: "SYSTEM",
      actor_id: "system:hold-expiry",
    });
  });

  it("purges expired idempotency keys and redacts message content after its retention period", async () => {
    const p = await newPractice();
    await connectWhatsApp(p);
    const patient = await newPatient(p);
    await consent(p, patient, { whatsapp: true });
    const number = (
      await ownerPool().query(
        "SELECT value FROM directory.patient_contacts WHERE patient_id=$1",
        [patient],
      )
    ).rows[0].value as string;
    const platform = testPlatform(p.tenantId, {
      allowList: [number],
      transports: {
        email: null,
        whatsapp: () => ({
          sendTemplate: async () => ({ messageId: `wamid.${randomUUID()}` }),
        }),
      },
    });
    await book(p, patient, slot(3, "11:00"));
    await platform.drain();
    await ownerPool().query(
      `INSERT INTO platform.idempotency_keys(tenant_id, scope_id, idempotency_key, operation, request_hash, state,
                                             actor_id, created_at, expires_at)
       VALUES($1,$2,'expired-key-0001','appointment.create',repeat('a',64),'PENDING','user:x', now()-interval '2 days',
              now()-interval '1 minute'),
             ($1,$2,'live-key-0001','appointment.create',repeat('b',64),'PENDING','user:x', now(), now()+interval '1 day')`,
      [p.tenantId, p.practiceId],
    );
    expect(await platform.sweeps.purgeIdempotencyKeys(p.tenantId)).toBe(1);
    const keys = await ownerPool().query(
      "SELECT idempotency_key FROM platform.idempotency_keys WHERE tenant_id=$1",
      [p.tenantId],
    );
    expect(keys.rows.map((r) => r.idempotency_key)).toContain("live-key-0001");
    expect(keys.rows.map((r) => r.idempotency_key)).not.toContain(
      "expired-key-0001",
    );

    // Nothing is due yet...
    expect(await platform.sweeps.redactExpiredContent(p.tenantId)).toBe(0);
    // ...until the sent confirmation is older than the retention period.
    await asTimePasses([
      [
        "UPDATE messaging.notification_deliveries SET created_at=now()-interval '120 days' WHERE tenant_id=$1 AND status='SENT'",
        [p.tenantId],
      ],
    ]);
    expect(await platform.sweeps.redactExpiredContent(p.tenantId)).toBe(1);
    const [sent] = await deliveries(p, "status='SENT'");
    expect(sent).toMatchObject({
      recipient_address: null,
      template_params: null,
    });
    // Status and identifiers stay for audit and reporting.
    expect(sent!.provider_message_id).toMatch(/^wamid\./);
  });

  it("reconciles reminders a practice's settings call for but that were never planned", async () => {
    const p = await newPractice();
    await connectWhatsApp(p);
    const patient = await newPatient(p);
    await consent(p, patient, { whatsapp: true });
    await ownerPool().query(
      "UPDATE directory.practices SET reminder_24h_enabled=false, version=version+1 WHERE id=$1",
      [p.practiceId],
    );
    const platform = testPlatform(p.tenantId);
    // Inside the reconciliation window (24-49 hours ahead), in working hours.
    const id = await book(p, patient, startBetween(24.5, 48));
    await platform.outbox.run(p.tenantId);
    expect(
      (await deliveries(p, "appointment_id=$3", [id])).map(
        (r) => r.notification_type,
      ),
    ).toEqual(["APPOINTMENT_CONFIRMATION"]);
    // The practice switches 24-hour reminders on after the booking.
    await ownerPool().query(
      "UPDATE directory.practices SET reminder_24h_enabled=true, version=version+1 WHERE id=$1",
      [p.practiceId],
    );
    expect(await platform.sweeps.reconcileReminders(p.tenantId)).toBe(1);
    expect(await platform.sweeps.reconcileReminders(p.tenantId)).toBe(0);
    expect(
      (await deliveries(p, "appointment_id=$3", [id]))
        .map((r) => r.notification_type)
        .sort(),
    ).toEqual(["APPOINTMENT_CONFIRMATION", "APPOINTMENT_REMINDER_24H"]);
  });

  it("serves health, readiness and token-protected metrics", async () => {
    const metrics = new Metrics();
    metrics.describe("worker_job_seconds", "Background job cycle duration");
    metrics.observe("worker_job_seconds", 0.2, { job: "outbox" });
    let live = true;
    const server = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      metrics,
      metricsToken: "metrics-token-that-is-long-enough-000",
      build: "test",
      live: () => live,
      ready: async () => {
        await ownerPool().query("SELECT 1");
        return true;
      },
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/ready`)).status).toBe(200);
      expect((await fetch(`${base}/metrics`)).status).toBe(401);
      const scraped = await fetch(`${base}/metrics`, {
        headers: {
          authorization: "Bearer metrics-token-that-is-long-enough-000",
        },
      });
      expect(scraped.status).toBe(200);
      expect(await scraped.text()).toContain("access_worker_job_seconds");
      live = false;
      expect((await fetch(`${base}/health`)).status).toBe(503);
      expect((await fetch(`${base}/anything`)).status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
