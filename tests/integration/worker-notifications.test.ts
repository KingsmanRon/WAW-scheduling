import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import {
  bookAppointment,
  cancelAppointment,
  rescheduleAppointment,
} from "../../packages/scheduling/src/index.js";
import { closePools, databaseEnabled, ownerPool } from "../support/harness.js";
import { GraphApiFixture } from "../support/graph-api-fixture.js";
import {
  PHONE_NUMBER_ID,
  WHATSAPP_TOKEN,
  connectWhatsApp,
  consent,
  deliveries,
  makeDue,
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

async function mobileOf(patientId: string): Promise<string> {
  const r = await ownerPool().query<{ value: string }>(
    "SELECT value FROM directory.patient_contacts WHERE patient_id=$1 AND kind='MOBILE' AND removed_at IS NULL",
    [patientId],
  );
  return r.rows[0]!.value;
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

describe.runIf(databaseEnabled)("notification planning and delivery", () => {
  let graph: GraphApiFixture;
  beforeAll(async () => {
    graph = new GraphApiFixture(WHATSAPP_TOKEN);
    await graph.start();
  });
  afterAll(async () => {
    await graph.stop();
    await closePools();
  });

  async function setup(
    options: {
      consent?: boolean;
      allowListed?: boolean;
      nearTerm?: number;
    } = {},
  ) {
    const p = await newPractice();
    await connectWhatsApp(p);
    const patient = await newPatient(p);
    const number = await mobileOf(patient);
    if (options.consent ?? true) await consent(p, patient, { whatsapp: true });
    if (options.nearTerm)
      await ownerPool().query(
        "UPDATE directory.practices SET near_term_reminder_minutes=$2, version=version+1 WHERE id=$1",
        [p.practiceId, options.nearTerm],
      );
    const platform = testPlatform(p.tenantId, {
      graphUrl: graph.url,
      allowList: options.allowListed === false ? [] : [number],
    });
    return { p, patient, number, platform };
  }

  it("a booking plans its confirmation and reminders; the confirmation goes out as an approved template", async () => {
    const { p, patient, number, platform } = await setup({ nearTerm: 120 });
    const start = slot(3, "10:00");
    const before = graph.messages().length;
    const id = await book(p, patient, start);
    await platform.drain();

    const rows = await deliveries(p, "appointment_id=$3", [id]);
    expect(rows.map((r) => [r.notification_type, r.status, r.channel])).toEqual(
      expect.arrayContaining([
        ["APPOINTMENT_CONFIRMATION", "SENT", "WHATSAPP"],
        ["APPOINTMENT_REMINDER_24H", "PENDING", "WHATSAPP"],
        ["APPOINTMENT_REMINDER_NEAR_TERM", "PENDING", "WHATSAPP"],
      ]),
    );
    expect(rows).toHaveLength(3);
    const reminder = rows.find(
      (r) => r.notification_type === "APPOINTMENT_REMINDER_24H",
    )!;
    expect(+reminder.scheduled_for).toBe(+start - 24 * 3600_000);
    const soon = rows.find(
      (r) => r.notification_type === "APPOINTMENT_REMINDER_NEAR_TERM",
    )!;
    expect(+soon.scheduled_for).toBe(+start - 120 * 60_000);

    const sent = graph.messages().slice(before);
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.path).toBe(`/v23.0/${PHONE_NUMBER_ID}/messages`);
    expect(request.authorization).toBe(`Bearer ${WHATSAPP_TOKEN}`);
    const confirmation = rows.find(
      (r) => r.notification_type === "APPOINTMENT_CONFIRMATION",
    )!;
    expect(request.body).toMatchObject({
      messaging_product: "whatsapp",
      to: number.slice(1),
      type: "template",
      template: { name: "appointment_confirmation", language: { code: "en" } },
      biz_opaque_callback_data: `delivery:${confirmation.id}`,
    });
    const params = (
      request.body.template as {
        components: { parameters: { text: string }[] }[];
      }
    ).components[0]!.parameters.map((x) => x.text);
    expect(params).toHaveLength(5);
    expect(params[3]).toBe("Dr Alpha Test");
    expect(params[4]).toBe("Main rooms");
    expect(params[2]).toMatch(/ at 10:00$/);
    expect(confirmation.provider_message_id).toMatch(/^wamid\./);
    expect(confirmation.template_params).toEqual(params);
    expect(
      platform.metrics.snapshot()[
        'access_notifications_sent_total{channel="WHATSAPP",type="APPOINTMENT_CONFIRMATION"}'
      ],
    ).toBe(1);
    // Re-running changes nothing: plans are exactly-once.
    expect(await platform.drain()).toBe(0);
  });

  it("cancelling withdraws unsent reminders and tells the patient", async () => {
    const { p, patient, platform } = await setup();
    const id = await book(p, patient, slot(4, "09:30"));
    await platform.drain();
    const ctx = staffCtx(p);
    await run(ctx, (c) =>
      cancelAppointment(c, ctx, id, { reasonCode: "PRACTICE_REQUEST" }),
    );
    await platform.drain();
    const rows = await deliveries(p, "appointment_id=$3", [id]);
    expect(
      rows.map((r) => [r.notification_type, r.status, r.cancel_reason]),
    ).toEqual(
      expect.arrayContaining([
        ["APPOINTMENT_CONFIRMATION", "SENT", null],
        ["APPOINTMENT_REMINDER_24H", "CANCELLED", "APPOINTMENT_CANCELLED"],
        ["APPOINTMENT_CANCELLED", "SENT", null],
      ]),
    );
    const last = graph.messages().at(-1)!;
    expect(last.body.template).toMatchObject({ name: "appointment_cancelled" });
  });

  it("rescheduling moves the reminders to the replacement appointment", async () => {
    const { p, patient, platform } = await setup();
    const first = await book(p, patient, slot(5, "09:00"));
    await platform.drain();
    const ctx = staffCtx(p);
    const second = await run(ctx, (c) =>
      rescheduleAppointment(c, ctx, first, { start: slot(6, "11:00") }),
    );
    await platform.drain();
    const old = await deliveries(p, "appointment_id=$3", [first]);
    expect(
      old.find((r) => r.notification_type === "APPOINTMENT_REMINDER_24H"),
    ).toMatchObject({
      status: "CANCELLED",
      cancel_reason: "APPOINTMENT_RESCHEDULED",
    });
    const moved = await deliveries(p, "appointment_id=$3", [second]);
    expect(moved.map((r) => [r.notification_type, r.status]).sort()).toEqual([
      ["APPOINTMENT_REMINDER_24H", "PENDING"],
      ["APPOINTMENT_RESCHEDULED", "SENT"],
    ]);
    expect(graph.messages().at(-1)!.body.template).toMatchObject({
      name: "appointment_rescheduled",
    });
  });

  it("does not repeat a confirmation the WhatsApp conversation already gave, and closes out reminders on arrival", async () => {
    const { p, patient, platform } = await setup();
    const ctx = patientCtx(p, patient, `wa:${randomUUID()}`);
    const id = await run(ctx, (c) =>
      bookAppointment(c, ctx, {
        patientId: patient,
        appointmentTypeId: p.typeId,
        practitionerId: p.practitionerIds[1],
        locationId: p.locationId,
        start: slot(3, "15:00"),
      }),
    );
    const before = graph.messages().length;
    await platform.drain();
    const rows = await deliveries(p, "appointment_id=$3", [id]);
    expect(
      rows.find((r) => r.notification_type === "APPOINTMENT_CONFIRMATION"),
    ).toMatchObject({
      status: "SKIPPED",
      skip_reason: "CONFIRMED_IN_CONVERSATION",
    });
    expect(graph.messages().length).toBe(before);
    // The patient arrives: no reminder is still useful.
    await ownerPool().query(
      `INSERT INTO platform.outbox_events(tenant_id, practice_id, event_type, aggregate_type, aggregate_id, payload, correlation_id)
       VALUES($1,$2,'PATIENT_CHECKED_IN','appointment',$3,'{}',$4)`,
      [p.tenantId, p.practiceId, id, randomUUID()],
    );
    await platform.drain();
    expect(
      (await deliveries(p, "appointment_id=$3", [id])).find(
        (r) => r.notification_type === "APPOINTMENT_REMINDER_24H",
      ),
    ).toMatchObject({
      status: "CANCELLED",
      cancel_reason: "APPOINTMENT_CLOSED",
    });
  });

  it("without consent, or outside the synthetic allow-list, nothing is sent and the reason is recorded", async () => {
    const before = graph.messages().length;
    const noConsent = await setup({ consent: false });
    const a = await book(noConsent.p, noConsent.patient, slot(3, "11:00"));
    await noConsent.platform.drain();
    expect(
      (await deliveries(noConsent.p, "appointment_id=$3", [a])).map((r) => [
        r.status,
        r.skip_reason,
      ]),
    ).toEqual([
      ["SKIPPED", "NO_CONSENT"],
      ["SKIPPED", "NO_CONSENT"],
    ]);
    const unlisted = await setup({ allowListed: false });
    const b = await book(unlisted.p, unlisted.patient, slot(3, "12:00"));
    await unlisted.platform.drain();
    expect(
      (await deliveries(unlisted.p, "appointment_id=$3", [b])).map(
        (r) => r.skip_reason,
      ),
    ).toEqual(["RECIPIENT_NOT_ALLOWED", "RECIPIENT_NOT_ALLOWED"]);
    expect(graph.messages().length).toBe(before);
  });

  it("retries throttling with backoff, fails a permanent refusal at once, and stops after max attempts", async () => {
    const { p, patient, platform } = await setup();
    graph.error(429, 130429, "Rate limit hit");
    const id = await book(p, patient, slot(3, "13:00"));
    await platform.drain();
    let confirmation = (
      await deliveries(
        p,
        "appointment_id=$3 AND notification_type='APPOINTMENT_CONFIRMATION'",
        [id],
      )
    )[0]!;
    expect(confirmation).toMatchObject({
      status: "PENDING",
      attempt_count: 1,
      last_error_code: "WHATSAPP_130429",
    });
    expect(+confirmation.next_attempt_at).toBeGreaterThan(Date.now() + 15_000);
    await makeDue(p, `id='${confirmation.id}'`);
    graph.error(400, 131026, "Message undeliverable");
    await platform.drain();
    confirmation = (await deliveries(p, "id=$3", [confirmation.id]))[0]!;
    expect(confirmation).toMatchObject({
      status: "FAILED",
      attempt_count: 2,
      last_error_code: "WHATSAPP_131026",
    });
    // Bounded: a delivery that keeps failing transiently ends FAILED.
    await ownerPool().query(
      "UPDATE messaging.notification_deliveries SET max_attempts=2, version=version+1 WHERE tenant_id=$1 AND notification_type='APPOINTMENT_REMINDER_24H'",
      [p.tenantId],
    );
    await makeDue(p, "notification_type='APPOINTMENT_REMINDER_24H'");
    graph.error(500, 131000);
    await platform.drain();
    await makeDue(p, "notification_type='APPOINTMENT_REMINDER_24H'");
    graph.error(503, 131016);
    await platform.drain();
    expect(
      (await deliveries(p, "notification_type='APPOINTMENT_REMINDER_24H'"))[0],
    ).toMatchObject({ status: "FAILED", attempt_count: 2 });
  });

  it("treats an unanswered send as ambiguous: retried only after the provider callback window", async () => {
    const { p, patient, platform } = await setup();
    graph.respond({
      status: 200,
      body: { messages: [{ id: "wamid.late" }] },
      delayMs: 3000,
    });
    const id = await book(p, patient, slot(3, "14:00"));
    await platform.drain();
    const confirmation = (
      await deliveries(
        p,
        "appointment_id=$3 AND notification_type='APPOINTMENT_CONFIRMATION'",
        [id],
      )
    )[0]!;
    expect(confirmation.status).toBe("PENDING");
    expect(confirmation.last_error_code).toBe("RESPONSE_TIMEOUT");
    expect(+confirmation.next_attempt_at).toBeGreaterThan(Date.now() + 170_000);
  });

  it("re-checks consent, the appointment and the patient just before sending", async () => {
    const { p, patient, platform } = await setup();
    const id = await book(p, patient, slot(3, "16:00"));
    await platform.drain();
    // The patient opts out after the reminder was planned.
    await consent(p, patient, { whatsapp: false });
    await makeDue(p, `appointment_id='${id}'`);
    await platform.drain();
    expect(
      (
        await deliveries(
          p,
          "appointment_id=$3 AND notification_type='APPOINTMENT_REMINDER_24H'",
          [id],
        )
      )[0],
    ).toMatchObject({ status: "SKIPPED", skip_reason: "NO_CONSENT" });

    // A reminder whose appointment time no longer matches is never sent.
    await consent(p, patient, { whatsapp: true });
    const other = await book(p, patient, slot(4, "16:00"));
    await platform.drain();
    await ownerPool().query(
      `UPDATE messaging.notification_deliveries SET appointment_starts_at=appointment_starts_at+interval '1 hour',
              version=version+1 WHERE appointment_id=$1 AND notification_type='APPOINTMENT_REMINDER_24H'`,
      [other],
    );
    await makeDue(p, `appointment_id='${other}'`);
    await platform.drain();
    expect(
      (
        await deliveries(
          p,
          "appointment_id=$3 AND notification_type='APPOINTMENT_REMINDER_24H'",
          [other],
        )
      )[0],
    ).toMatchObject({ status: "SKIPPED", skip_reason: "APPOINTMENT_CHANGED" });
  });

  it("a worker that lost its claim cannot record over the newer attempt", async () => {
    const { p, patient } = await setup();
    let deliveryId = "";
    const platform = testPlatform(p.tenantId, {
      allowList: [await mobileOf(patient)],
      transports: {
        email: null,
        whatsapp: () => ({
          async sendTemplate(message) {
            deliveryId = message.callbackData!.slice("delivery:".length);
            // Meanwhile the lease expired and another worker re-claimed it.
            await ownerPool().query(
              "UPDATE messaging.notification_deliveries SET attempt_count=attempt_count+1, version=version+1 WHERE id=$1",
              [deliveryId],
            );
            return { messageId: "wamid.stale-worker" };
          },
        }),
      },
    });
    await book(p, patient, slot(3, "08:30"));
    await platform.drain();
    const row = (await deliveries(p, "id=$3", [deliveryId]))[0]!;
    expect(row.status).toBe("PROCESSING");
    expect(row.provider_message_id).toBeNull();
  });

  it("sends e-mail notifications over SMTP when that is the consented channel", async () => {
    const received: { to: string; raw: string }[] = [];
    const smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          received.push({
            to: session.envelope.rcptTo.map((r) => r.address).join(","),
            raw: Buffer.concat(chunks).toString("utf8"),
          });
          callback();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
    try {
      const p = await newPractice();
      const email = `pat-${randomUUID().slice(0, 8)}@example.test`;
      const patient = await newPatient(p, {
        contacts: [{ kind: "EMAIL", value: email }],
      });
      await consent(p, patient, { email: true, preferred: "EMAIL" });
      const port = (smtp.server.address() as AddressInfo).port;
      const platform = testPlatform(p.tenantId, {
        smtp: {
          url: `smtp://127.0.0.1:${port}`,
          from: "Practice Notifications <no-reply@example.test>",
        },
        allowList: [email],
      });
      const id = await book(p, patient, slot(3, "10:30"));
      await platform.drain();
      const confirmation = (
        await deliveries(
          p,
          "appointment_id=$3 AND notification_type='APPOINTMENT_CONFIRMATION'",
          [id],
        )
      )[0]!;
      expect(confirmation).toMatchObject({ channel: "EMAIL", status: "SENT" });
      expect(received).toHaveLength(1);
      expect(received[0]!.to).toBe(email);
      expect(received[0]!.raw).toMatch(/Subject: Appointment confirmed/);
      expect(received[0]!.raw).toContain(
        `X-Access-Delivery: ${confirmation.id}`,
      );
    } finally {
      await new Promise<void>((r) => smtp.close(() => r()));
    }
  });
});
