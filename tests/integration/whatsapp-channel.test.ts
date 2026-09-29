import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PracticeRole } from "../../packages/contracts/src/index.js";
import type {
  Intent,
  IntentClassifier,
} from "../../packages/access/src/index.js";
import { bookAppointment } from "../../packages/scheduling/src/index.js";
import {
  closePools,
  databaseEnabled,
  mintToken,
  ownerPool,
  testApi,
  type TestApi,
} from "../support/harness.js";
import { GraphApiFixture } from "../support/graph-api-fixture.js";
import {
  WHATSAPP_TOKEN,
  consent,
  deliveries,
  testPlatform,
  type TestPlatform,
} from "../support/platform.js";
import { newPatient, run, slot, staffCtx } from "../support/scheduling.js";
import {
  APP_SECRET,
  VERIFY_TOKEN,
  WEBHOOK,
  appointmentsOf,
  conversationOf,
  mobileOf,
  whatsAppHarness,
} from "../support/whatsapp.js";

describe.runIf(databaseEnabled)("WhatsApp channel and access layer", () => {
  let api: TestApi;
  let graph: GraphApiFixture;
  let wa: ReturnType<typeof whatsAppHarness>;
  beforeAll(async () => {
    graph = new GraphApiFixture(WHATSAPP_TOKEN);
    await graph.start();
    api = await testApi({
      auth: "jwt",
      whatsapp: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN },
    });
    wa = whatsAppHarness(api, graph);
  });
  afterAll(async () => {
    await api.close();
    await graph.stop();
    await closePools();
  });
  const post = (raw: string, signature?: string | null) =>
    signature === undefined ? wa.post(raw) : wa.post(raw, signature);
  const envelope = (id: string, value: Record<string, unknown>) =>
    wa.envelope(id, value);
  const channelPractice = (classifier?: IntentClassifier) =>
    wa.channelPractice(classifier ? { classifier } : {});
  const phoneOf = (
    number: string,
    phoneNumberId: string,
    platform: TestPlatform,
  ) => new wa.Phone(number, phoneNumberId, platform);

  it("verifies the subscription and refuses unsigned or unrouted notifications", async () => {
    const ok = await api.app.inject({
      method: "GET",
      url: `${WEBHOOK}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("1158201444");
    const wrong = await api.app.inject({
      method: "GET",
      url: `${WEBHOOK}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`,
    });
    expect(wrong.statusCode).toBe(403);
    const raw = envelope("5550001112", {
      messages: [
        {
          from: "27820000000",
          id: "wamid.x",
          timestamp: "1790000000",
          type: "text",
          text: { body: "hi" },
        },
      ],
    });
    expect((await post(raw, "sha256=" + "0".repeat(64))).statusCode).toBe(401);
    expect((await post(raw, null)).statusCode).toBe(401);
    // Signed but for a number no practice owns: acknowledged, nothing stored.
    expect((await post(raw)).statusCode).toBe(200);
    const stored = await ownerPool().query(
      "SELECT count(*)::int n FROM messaging.channel_messages WHERE provider_message_id='wamid.x'",
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it("a known patient books end to end; the Scheduling Core records it once", async () => {
    const { p, phoneNumberId, platform } = await channelPractice();
    const patient = await newPatient(p);
    const phone = phoneOf(await mobileOf(patient), phoneNumberId, platform);

    const hi = await phone.send({ text: "Hi" });
    expect(phone.last()).toMatchObject({
      type: "button",
      options: ["M:BOOK", "M:LIST", "M:STAFF"],
    });
    await phone.send({ tap: "M:BOOK" });
    const slots = phone.last();
    expect(slots.type).toBe("list");
    expect(slots.options[0]).toBe("S:1");
    expect(slots.titles[0]).toMatch(/^\w{3} \d{1,2} \w{3,4}, \d{2}:\d{2}$/);
    await phone.send({ tap: "S:1" });
    expect(phone.last()).toMatchObject({
      type: "button",
      options: ["H:YES", "H:NO"],
    });
    expect(phone.last().text).toMatch(
      /I've reserved .* for the next \d+ minutes/,
    );
    await phone.send({ tap: "H:YES" });
    expect(phone.last().text).toMatch(/^You're booked for /);

    const booked = await appointmentsOf(p, patient);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({
      status: "CONFIRMED",
      source_channel: "WHATSAPP",
      booked_by_actor_type: "PATIENT",
    });
    const conversation = await conversationOf(p, phone.number);
    expect(conversation).toMatchObject({
      state: "IDLE",
      status: "ACTIVE",
      patient_id: patient,
    });
    // Meta may deliver a message twice: the second is a no-op.
    const before = phone.replies().length;
    await phone.send({ text: "Hi" }, hi);
    expect(phone.replies().length).toBe(before);
    // The conversation confirmed it; no template repeats it.
    expect(
      (await deliveries(p, "notification_type='APPOINTMENT_CONFIRMATION'"))[0],
    ).toMatchObject({
      status: "SKIPPED",
      skip_reason: "CONFIRMED_IN_CONVERSATION",
    });
    const contact = await ownerPool().query(
      "SELECT whatsapp_capable, verification_method FROM directory.patient_contacts WHERE patient_id=$1",
      [patient],
    );
    expect(contact.rows[0]).toEqual({
      whatsapp_capable: true,
      verification_method: "WHATSAPP_INBOUND",
    });
  });

  it("a new number registers, gives consent and books", async () => {
    const { p, phoneNumberId, platform } = await channelPractice();
    const phone = phoneOf(
      `+2783${String(Date.now()).slice(-7)}`,
      phoneNumberId,
      platform,
    );
    await phone.send({ text: "I would like to book an appointment" });
    expect(phone.last().text).toMatch(/first name and surname/);
    await phone.send({ text: "Thandi" });
    expect(phone.last().text).toMatch(/first name and surname/);
    await phone.send({ text: "Thandi Mokoena" });
    expect(phone.last().text).toMatch(/date of birth/);
    await phone.send({ text: "21/03/1990" });
    expect(phone.last()).toMatchObject({ options: ["R:YES", "R:NO"] });
    await phone.send({ tap: "R:YES" });
    expect(phone.last().type).toBe("list");
    await phone.send({ tap: "S:2" });
    await phone.send({ text: "yes" });
    expect(phone.last().text).toMatch(/^You're booked for /);

    const conversation = await conversationOf(p, phone.number);
    const patient = await ownerPool().query(
      `SELECT given_name, family_name, date_of_birth::text AS dob, identity_verification, source_channel
         FROM directory.patients WHERE id=$1`,
      [conversation.patient_id],
    );
    expect(patient.rows[0]).toEqual({
      given_name: "Thandi",
      family_name: "Mokoena",
      dob: "1990-03-21",
      identity_verification: "UNVERIFIED",
      source_channel: "WHATSAPP",
    });
    const prefs = await ownerPool().query(
      "SELECT whatsapp_opt_in, whatsapp_consent_source FROM messaging.notification_preferences WHERE patient_id=$1",
      [conversation.patient_id],
    );
    expect(prefs.rows[0]).toEqual({
      whatsapp_opt_in: true,
      whatsapp_consent_source: "PATIENT_WHATSAPP",
    });
    expect(await appointmentsOf(p, conversation.patient_id)).toHaveLength(1);
    const audit = await ownerPool().query(
      "SELECT actor_type, actor_id FROM platform.audit_events WHERE tenant_id=$1 AND action='patient.created'",
      [p.tenantId],
    );
    expect(audit.rows).toEqual([
      { actor_type: "PATIENT", actor_id: `conversation:${conversation.id}` },
    ]);
  });

  it("a patient reschedules and then cancels through WhatsApp", async () => {
    const { p, phoneNumberId, platform } = await channelPractice();
    const patient = await newPatient(p);
    const phone = phoneOf(await mobileOf(patient), phoneNumberId, platform);
    const ctx = staffCtx(p);
    const original = await run(ctx, (c) =>
      bookAppointment(c, ctx, {
        patientId: patient,
        appointmentTypeId: p.typeId,
        practitionerId: p.practitionerIds[0],
        locationId: p.locationId,
        start: slot(5, "10:00"),
      }),
    );
    await platform.drain();
    await phone.send({ text: "I need to reschedule my appointment" });
    expect(phone.last().type).toBe("list");
    await phone.send({ tap: "S:1" });
    await phone.send({ tap: "H:YES" });
    expect(phone.last().text).toMatch(/^Done - your appointment has moved to /);
    let rows = await appointmentsOf(p, patient);
    expect(rows.map((a) => a.status)).toEqual(["RESCHEDULED", "CONFIRMED"]);
    expect(rows[1]!.rescheduled_from_id).toBe(original);

    // Inside the practice's change cutoff the patient is sent to reception.
    const cutoff = (minutes: number) =>
      ownerPool().query(
        "UPDATE directory.practices SET patient_change_cutoff_minutes=$2, version=version+1 WHERE id=$1",
        [p.practiceId, minutes],
      );
    await cutoff(10_080);
    await phone.send({ text: "cancel" });
    expect(phone.last()).toMatchObject({ options: ["C:YES", "C:NO"] });
    await phone.send({ tap: "C:YES" });
    expect(phone.last().text).toMatch(/too close to the appointment/);
    expect((await appointmentsOf(p, patient))[1]!.status).toBe("CONFIRMED");
    await cutoff(0);
    await phone.send({ text: "cancel" });
    await phone.send({ tap: "C:YES" });
    expect(phone.last().text).toMatch(/is cancelled/);
    rows = await appointmentsOf(p, patient);
    expect(rows[1]).toMatchObject({
      status: "CANCELLED",
      cancellation_reason_code: "PATIENT_REQUEST",
    });
  });

  it("offers fresh times when the chosen one was taken meanwhile", async () => {
    const { p, phoneNumberId, platform } = await channelPractice();
    const patient = await newPatient(p);
    const phone = phoneOf(await mobileOf(patient), phoneNumberId, platform);
    await phone.send({ text: "book" });
    const offered = (await conversationOf(p, phone.number)).state_data.slots[0];
    // Reception books that exact time for someone else on the phone.
    const other = await newPatient(p);
    const ctx = staffCtx(p);
    await run(ctx, (c) =>
      bookAppointment(c, ctx, {
        patientId: other,
        appointmentTypeId: p.typeId,
        practitionerId: offered.practitionerId,
        locationId: offered.locationId,
        start: new Date(offered.start),
      }),
    );
    await phone.send({ tap: "S:1" });
    const reply = phone.last();
    expect(reply.text).toMatch(/^Sorry, that time was just taken/);
    const fresh = (await conversationOf(p, phone.number)).state_data.slots;
    expect(
      fresh.some(
        (s: { start: string; practitionerId: string }) =>
          s.start === offered.start &&
          s.practitionerId === offered.practitionerId,
      ),
    ).toBe(false);
    expect(await appointmentsOf(p, patient)).toEqual([]);
  });

  it("never acts on an option the conversation did not offer", async () => {
    const { p, phoneNumberId, platform } = await channelPractice();
    const patient = await newPatient(p);
    const phone = phoneOf(await mobileOf(patient), phoneNumberId, platform);
    await phone.send({ text: "book" });
    await phone.send({ tap: "S:42" });
    expect(phone.last().text).toMatch(/choose one of the times/);
    await phone.send({ text: "menu" });
    await phone.send({ tap: `A:${randomUUID()}` });
    expect(phone.last().text).toMatch(/no longer available/);
    expect(await appointmentsOf(p, patient)).toEqual([]);
    const holds = await ownerPool().query(
      "SELECT count(*)::int n FROM scheduling.slot_holds WHERE tenant_id=$1",
      [p.tenantId],
    );
    expect(holds.rows[0].n).toBe(0);
  });

  it("stops on a possible emergency and hands over to staff, who reply and hand back", async () => {
    const { p, phoneNumberId, platform } = await channelPractice();
    const patient = await newPatient(p);
    const phone = phoneOf(await mobileOf(patient), phoneNumberId, platform);
    await phone.send({ text: "book" });
    await phone.send({ text: "my father has chest pain" });
    expect(phone.last().text).toMatch(/10177 or 112/);
    expect(await conversationOf(p, phone.number)).toMatchObject({
      status: "NEEDS_STAFF",
      needs_staff_reason: "SAFETY_CONCERN",
      state: "IDLE",
    });
    // A person is handling it: the assistant stays quiet.
    const quiet = phone.replies().length;
    await phone.send({ text: "hello?" });
    expect(phone.replies().length).toBe(quiet);

    const user = randomUUID();
    await ownerPool().query(
      `INSERT INTO directory.practice_memberships(tenant_id,practice_id,user_id,role,status,display_name,created_by,updated_by)
       VALUES($1,$2,$3,$4,'ACTIVE','Reception','test','test')`,
      [p.tenantId, p.practiceId, user, "RECEPTIONIST" satisfies PracticeRole],
    );
    const token = await mintToken(user);
    const headers = { authorization: `Bearer ${token}` };
    const base = `/v1/practices/${p.practiceId}/conversations`;
    const queue = await api.app.inject({
      method: "GET",
      url: `${base}?status=NEEDS_STAFF`,
      headers,
    });
    expect(queue.statusCode).toBe(200);
    const item = queue.json().items[0];
    expect(item).toMatchObject({
      needs_staff_reason: "SAFETY_CONCERN",
      within_service_window: true,
      patient: { id: patient },
    });
    const thread = await api.app.inject({
      method: "GET",
      url: `${base}/${item.id}`,
      headers,
    });
    expect(
      thread.json().messages.map((m: { body: string }) => m.body),
    ).toContain("my father has chest pain");
    const replied = await api.app.inject({
      method: "POST",
      url: `${base}/${item.id}/messages`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { body: "Dr Naidoo will call you in the next few minutes." },
    });
    expect(replied.statusCode).toBe(202);
    await platform.drain();
    expect(phone.last()).toMatchObject({
      type: "text",
      text: "Dr Naidoo will call you in the next few minutes.",
    });
    // Linking the patient alone keeps the conversation with reception.
    const linked = await api.app.inject({
      method: "PATCH",
      url: `${base}/${item.id}`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { patient_id: patient, expected_version: item.version + 1 },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().conversation).toMatchObject({
      status: "NEEDS_STAFF",
      needs_staff_reason: "SAFETY_CONCERN",
      patient: { id: patient },
    });
    const nothing = await api.app.inject({
      method: "PATCH",
      url: `${base}/${item.id}`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { expected_version: item.version + 2 },
    });
    expect(nothing.statusCode).toBe(400);
    const resolved = await api.app.inject({
      method: "PATCH",
      url: `${base}/${item.id}`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { status: "ACTIVE", expected_version: item.version + 2 },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().conversation.status).toBe("ACTIVE");
    await phone.send({ text: "hi" });
    expect(phone.last().options).toEqual(["M:BOOK", "M:LIST", "M:STAFF"]);
    const audit = await ownerPool().query(
      "SELECT action FROM platform.audit_events WHERE tenant_id=$1 AND resource_type='conversation' ORDER BY id",
      [p.tenantId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "conversation.replied",
      "conversation.patient_linked",
      "conversation.resolved",
    ]);
  });

  it("an optional classifier only starts flows or escalates; failures and staff time bypass it", async () => {
    const seen: string[] = [];
    const answers: Record<string, Intent | "throw"> = {
      "my son needs a check-up next week": { kind: "BOOK" },
      // A classifier must not be able to tap, pick or confirm anything.
      "whatever you think is best": { kind: "CHOICE", id: "M:BOOK" },
      "just do it": "throw",
      "my baby is floppy and won't wake up": { kind: "SAFETY" },
    };
    const classifier: IntentClassifier = {
      async classify(text) {
        seen.push(text);
        const answer = answers[text];
        if (answer === "throw") throw new Error("provider down");
        return answer ?? null;
      },
    };
    const { p, phoneNumberId, platform } = await channelPractice(classifier);
    const patient = await newPatient(p);
    const phone = phoneOf(await mobileOf(patient), phoneNumberId, platform);

    await phone.send({ text: "my son needs a check-up next week" });
    expect(phone.last()).toMatchObject({ type: "list" });
    expect(phone.last().options[0]).toBe("S:1");
    // Mid-flow text is the deterministic engine's alone.
    await phone.send({ text: "hmm not sure" });
    expect(seen).toEqual(["my son needs a check-up next week"]);
    await phone.send({ text: "menu" });

    await phone.send({ text: "whatever you think is best" });
    expect(phone.last().text).toMatch(/^Sorry, I didn't understand/);
    await phone.send({ text: "just do it" });
    expect(phone.last().text).toMatch(/^Sorry, I didn't understand/);
    expect(await conversationOf(p, phone.number)).toMatchObject({
      status: "ACTIVE",
      state: "IDLE",
    });
    expect(await appointmentsOf(p, patient)).toEqual([]);

    await phone.send({ text: "my baby is floppy and won't wake up" });
    expect(phone.last().text).toMatch(/10177 or 112/);
    expect(await conversationOf(p, phone.number)).toMatchObject({
      status: "NEEDS_STAFF",
      needs_staff_reason: "SAFETY_CONCERN",
    });
    // Staff have it now: nothing more goes to the classifier.
    const quiet = phone.replies().length;
    await phone.send({ text: "are you there" });
    expect(phone.replies().length).toBe(quiet);
    expect(seen).not.toContain("are you there");
  });

  it("applies delivery statuses forward only, settles an unrecorded send, and honours STOP", async () => {
    const { p, phoneNumberId, platform } = await channelPractice();
    const patient = await newPatient(p);
    await consent(p, patient, { whatsapp: true });
    const phone = phoneOf(await mobileOf(patient), phoneNumberId, platform);
    await phone.send({ text: "Hi" });
    const sent = (
      await ownerPool().query(
        `SELECT id, provider_message_id FROM messaging.channel_messages
          WHERE tenant_id=$1 AND direction='OUTBOUND' AND status='SENT' ORDER BY created_at DESC LIMIT 1`,
        [p.tenantId],
      )
    ).rows[0];
    const status = (
      id: string,
      s: string,
      extra: Record<string, unknown> = {},
    ) =>
      post(
        envelope(phoneNumberId, {
          statuses: [
            {
              id,
              status: s,
              timestamp: String(Math.floor(Date.now() / 1000)),
              recipient_id: phone.number.slice(1),
              ...extra,
            },
          ],
        }),
      );
    await status(sent.provider_message_id, "read");
    await status(sent.provider_message_id, "delivered");
    await status(sent.provider_message_id, "delivered");
    const message = await ownerPool().query(
      "SELECT status, read_at IS NOT NULL AS read FROM messaging.channel_messages WHERE id=$1",
      [sent.id],
    );
    expect(message.rows[0]).toEqual({ status: "READ", read: true });

    // A reminder whose send the worker never got to record: the callback
    // data settles it, so it is not sent again.
    const ctx = staffCtx(p);
    await run(ctx, (c) =>
      bookAppointment(c, ctx, {
        patientId: patient,
        appointmentTypeId: p.typeId,
        practitionerId: p.practitionerIds[0],
        locationId: p.locationId,
        start: slot(4, "11:00"),
      }),
    );
    // Planned by a worker whose (synthetic) allow-list includes the patient.
    await testPlatform(p.tenantId, {
      graphUrl: graph.url,
      allowList: [phone.number],
    }).outbox.run(p.tenantId);
    const [planned] = await deliveries(
      p,
      "notification_type='APPOINTMENT_CONFIRMATION'",
    );
    expect(planned!.status).toBe("PENDING");
    await status("wamid.settled-by-callback", "sent", {
      biz_opaque_callback_data: `delivery:${planned!.id}`,
    });
    expect((await deliveries(p, "id=$3", [planned!.id]))[0]).toMatchObject({
      status: "SENT",
      provider_message_id: "wamid.settled-by-callback",
    });

    await phone.send({ text: "STOP" });
    expect(phone.last().text).toMatch(/no longer receive reminders/);
    const prefs = await ownerPool().query(
      "SELECT whatsapp_opt_in FROM messaging.notification_preferences WHERE patient_id=$1",
      [patient],
    );
    expect(prefs.rows[0].whatsapp_opt_in).toBe(false);
  });
});
