import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PracticeRole } from "../../packages/contracts/src/index.js";
import {
  DAY_MS,
  bookAppointment,
  localDateOf,
} from "../../packages/scheduling/src/index.js";
import {
  downloadLinkKey,
  signDownloadLink,
} from "../../apps/core-api/src/referral-routes.js";
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
  asTimePasses,
  consent,
  deliveries,
} from "../support/platform.js";
import {
  TZ,
  newPatient,
  newPractice,
  run,
  slot,
  staffCtx,
  type TestPractice,
} from "../support/scheduling.js";
import {
  APP_SECRET,
  VERIFY_TOKEN,
  appointmentsOf,
  mobileOf,
  whatsAppHarness,
} from "../support/whatsapp.js";

const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(
    () => [],
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

describe.runIf(databaseEnabled)(
  "waitlist offers and the referral register",
  () => {
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

    /** A signed-in member of the practice's staff. */
    async function member(p: TestPractice, role: PracticeRole) {
      const user = randomUUID();
      await ownerPool().query(
        `INSERT INTO directory.practice_memberships(tenant_id,practice_id,user_id,role,status,display_name,created_by,updated_by)
       VALUES($1,$2,$3,$4,'ACTIVE',$5,'test','test')`,
        [p.tenantId, p.practiceId, user, role, `Test ${role}`],
      );
      return { user, token: await mintToken(user) };
    }
    type Member = Awaited<ReturnType<typeof member>>;
    const call = (
      p: TestPractice,
      who: Member,
      method: "GET" | "POST",
      path: string,
      payload?: Record<string, unknown>,
    ) =>
      api.app.inject({
        method,
        url: `/v1/practices/${p.practiceId}${path}`,
        headers: {
          authorization: `Bearer ${who.token}`,
          ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}),
        },
        ...(payload ? { payload } : {}),
      });
    const today = () => localDateOf(Date.now(), TZ);
    const inDays = (n: number) => localDateOf(Date.now() + n * DAY_MS, TZ);
    const offers = async (p: TestPractice) =>
      (
        await ownerPool().query(
          `SELECT o.id, o.status, o.appointment_id, o.starts_at, e.id AS entry_id, e.patient_id, e.status AS entry_status
           FROM scheduling.waitlist_offers o
           JOIN scheduling.waitlist_entries e ON e.tenant_id=o.tenant_id AND e.id=o.waitlist_entry_id
          WHERE o.tenant_id=$1 ORDER BY o.offered_at, o.id`,
          [p.tenantId],
        )
      ).rows;
    const holdOf = async (appointmentId: string) =>
      (
        await ownerPool().query(
          "SELECT status, purpose, close_reason FROM scheduling.slot_holds WHERE appointment_id=$1",
          [appointmentId],
        )
      ).rows[0];
    /** A confirmed appointment that is then cancelled, freeing its slot. */
    async function freeSlot(p: TestPractice, reception: Member, start: Date) {
      const holder = await newPatient(p);
      const ctx = staffCtx(p);
      const id = await run(ctx, (c) =>
        bookAppointment(c, ctx, {
          patientId: holder,
          appointmentTypeId: p.typeId,
          practitionerId: p.practitionerIds[0],
          locationId: p.locationId,
          start,
        }),
      );
      const cancelled = await call(
        p,
        reception,
        "POST",
        `/appointments/${id}/cancel`,
        {
          reason_code: "PATIENT_REQUEST",
        },
      );
      expect(cancelled.statusCode).toBe(200);
      return id;
    }
    const joinWaitlist = (
      p: TestPractice,
      reception: Member,
      patientId: string,
      extra: Record<string, unknown> = {},
    ) =>
      call(p, reception, "POST", "/waitlist", {
        patient_id: patientId,
        appointment_type_id: p.typeId,
        earliest_date: today(),
        latest_date: inDays(30),
        ...extra,
      });

    it("registers referrals and serves their letters only to clinicians, through short-lived signed links", async () => {
      const p = await newPractice();
      const patient = await newPatient(p);
      const reception = await member(p, "RECEPTIONIST");
      const doctor = await member(p, "DOCTOR");
      const created = await call(p, reception, "POST", "/referrals", {
        patient_id: patient,
        referring_practitioner_name: "Dr Referring GP",
        referring_practice_name: "Synthetic Family Practice",
        referral_date: today(),
        valid_until: inDays(90),
        appointment_type_id: p.typeId,
        max_appointments: 2,
      });
      expect(created.statusCode).toBe(201);
      const referral = created.json();
      expect(referral).toMatchObject({
        status: "RECEIVED",
        version: 0,
        appointments_used: 0,
        appointment_type: { id: p.typeId },
        patient: { id: patient },
      });

      const letter = Buffer.from(
        "%PDF-1.4\nSynthetic referral letter for automated tests\n%%EOF\n",
      );
      const pdf = {
        document_type: "REFERRAL_LETTER",
        media_type: "application/pdf",
        content_base64: letter.toString("base64"),
      };
      const upload = (who: Member, body: Record<string, unknown>) =>
        call(p, who, "POST", `/referrals/${referral.id}/documents`, body);
      const first = await upload(reception, pdf);
      expect(first.statusCode).toBe(201);
      const documentId = first.json().document.id as string;
      // The same file again (a second click) is the same document.
      const again = await upload(reception, pdf);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({
        created: false,
        document: { id: documentId },
      });
      // Malware is never stored; content must match its declared type.
      const infected = await upload(reception, {
        document_type: "SUPPORTING_DOCUMENT",
        media_type: "text/plain",
        content_base64: Buffer.from(EICAR).toString("base64"),
      });
      expect(infected.statusCode).toBe(422);
      expect(infected.json().error).toBe("DOCUMENT_REJECTED");
      const disguised = await upload(reception, {
        ...pdf,
        media_type: "image/png",
      });
      expect(disguised.json().error).toBe("DOCUMENT_TYPE_MISMATCH");
      // At rest there is exactly one object, and it is ciphertext.
      const stored = await filesUnder(join(api.artifactRoot, p.tenantId));
      expect(stored).toHaveLength(1);
      const sealed = await readFile(stored[0]!);
      expect(sealed.includes(Buffer.from("Synthetic referral letter"))).toBe(
        false,
      );

      // Reception registers referrals but neither verifies nor reads them.
      expect(
        (
          await call(p, reception, "POST", `/referrals/${referral.id}/verify`, {
            expected_version: 0,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await call(
            p,
            reception,
            "POST",
            `/referrals/${referral.id}/documents/${documentId}/link`,
            {},
          )
        ).statusCode,
      ).toBe(403);
      const verified = await call(
        p,
        doctor,
        "POST",
        `/referrals/${referral.id}/verify`,
        { expected_version: 0 },
      );
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({
        status: "VERIFIED",
        version: 1,
        document_count: 1,
      });
      // A decision on a stale version is refused.
      expect(
        (
          await call(p, doctor, "POST", `/referrals/${referral.id}/cancel`, {
            expected_version: 0,
          })
        ).json().error,
      ).toBe("REFERRAL_CHANGED");

      const link = await call(
        p,
        doctor,
        "POST",
        `/referrals/${referral.id}/documents/${documentId}/link`,
        {},
      );
      expect(link.statusCode).toBe(200);
      const { url, expires_at } = link.json() as {
        url: string;
        expires_at: string;
      };
      expect(+new Date(expires_at) - Date.now()).toBeLessThanOrEqual(61_000);
      const download = await api.app.inject({ method: "GET", url });
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload.equals(letter)).toBe(true);
      expect(download.headers).toMatchObject({
        "content-type": "application/pdf",
        "cache-control": "no-store, private",
        "x-content-type-options": "nosniff",
      });
      expect(String(download.headers["content-disposition"])).toMatch(
        /^attachment; filename="referral-[0-9a-f-]{36}\.pdf"$/,
      );
      // Altered, expired and no-longer-authorised links all fail.
      const altered = url.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
      expect(
        (await api.app.inject({ method: "GET", url: altered })).statusCode,
      ).toBe(403);
      const expired = signDownloadLink(downloadLinkKey(Buffer.alloc(32, 9)), {
        t: p.tenantId,
        p: p.practiceId,
        r: referral.id,
        d: documentId,
        u: `user:${doctor.user}`,
        ur: "DOCTOR",
        e: Math.floor(Date.now() / 1000) - 1,
        n: "00",
      });
      expect(
        (
          await api.app.inject({
            method: "GET",
            url: `/v1/referral-documents/download?token=${expired}`,
          })
        ).statusCode,
      ).toBe(403);
      await ownerPool().query(
        "UPDATE directory.practice_memberships SET status='SUSPENDED', version=version+1 WHERE practice_id=$1 AND user_id=$2",
        [p.practiceId, doctor.user],
      );
      expect((await api.app.inject({ method: "GET", url })).statusCode).toBe(
        403,
      );

      const audit = await ownerPool().query(
        `SELECT action FROM platform.audit_events
        WHERE tenant_id=$1 AND resource_type IN ('referral','referral_document') ORDER BY id`,
        [p.tenantId],
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        "referral.created",
        "referral_document.uploaded",
        "referral.verified",
        "referral_document.link_issued",
        "referral_document.downloaded",
      ]);
      const events = await ownerPool().query(
        "SELECT event_type FROM platform.outbox_events WHERE tenant_id=$1 AND aggregate_type='referral'",
        [p.tenantId],
      );
      expect(events.rows.map((r) => r.event_type)).toEqual([
        "REFERRAL_VERIFIED",
      ]);
    });

    it("books referral-only appointment types only against a verified referral with visits left", async () => {
      const p = await newPractice({ type: { requiresReferral: true } });
      const patient = await newPatient(p);
      const reception = await member(p, "RECEPTIONIST");
      const doctor = await member(p, "DOCTOR");
      const book = (start: Date, referralId?: string) =>
        call(p, reception, "POST", "/appointments", {
          patient_id: patient,
          appointment_type_id: p.typeId,
          practitioner_id: p.practitionerIds[0],
          location_id: p.locationId,
          start: start.toISOString(),
          source_channel: "PHONE",
          ...(referralId ? { referral_id: referralId } : {}),
        });
      expect((await book(slot(2, "09:00"))).json().error).toBe(
        "REFERRAL_REQUIRED",
      );
      const referral = (
        await call(p, reception, "POST", "/referrals", {
          patient_id: patient,
          referring_practitioner_name: "Dr Referring GP",
          appointment_type_id: p.typeId,
          max_appointments: 1,
        })
      ).json();
      expect((await book(slot(2, "09:00"), referral.id)).json().error).toBe(
        "REFERRAL_NOT_VERIFIED",
      );
      expect(
        (
          await call(p, doctor, "POST", `/referrals/${referral.id}/verify`, {
            expected_version: 0,
          })
        ).statusCode,
      ).toBe(200);
      expect((await book(slot(2, "09:00"), referral.id)).statusCode).toBe(201);
      expect((await book(slot(3, "09:00"), referral.id)).json().error).toBe(
        "REFERRAL_EXHAUSTED",
      );
      expect(
        (await call(p, reception, "GET", `/referrals/${referral.id}`)).json(),
      ).toMatchObject({ status: "VERIFIED", appointments_used: 1 });
      // Another patient's referral covers nothing for this one.
      const other = await newPatient(p);
      const theirs = (
        await call(p, reception, "POST", "/referrals", {
          patient_id: other,
          referring_practitioner_name: "Dr Referring GP",
        })
      ).json();
      expect((await book(slot(4, "09:00"), theirs.id)).json().error).toBe(
        "REFERRAL_MISMATCH",
      );
    });

    it("offers a freed slot down the queue, held for each patient in turn; patients answer from WhatsApp", async () => {
      const p = await newPractice();
      const early = await newPatient(p);
      const raised = await newPatient(p);
      for (const w of [early, raised]) await consent(p, w, { whatsapp: true });
      const numbers = [await mobileOf(early), await mobileOf(raised)];
      const { phoneNumberId, platform } = await wa.channelPractice({
        practice: p,
        allowList: numbers,
      });
      const earlyPhone = new wa.Phone(numbers[0]!, phoneNumberId, platform);
      const raisedPhone = new wa.Phone(numbers[1]!, phoneNumberId, platform);
      const reception = await member(p, "RECEPTIONIST");
      expect((await joinWaitlist(p, reception, early)).statusCode).toBe(201);
      // Staff raised this patient's (administrative) priority.
      expect(
        (await joinWaitlist(p, reception, raised, { priority: 1 })).statusCode,
      ).toBe(201);
      expect((await joinWaitlist(p, reception, early)).json().error).toBe(
        "WAITLIST_DUPLICATE",
      );

      const start = slot(3, "10:00");
      await freeSlot(p, reception, start);
      await platform.drain();
      let rows = await offers(p);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "PENDING",
        patient_id: raised,
        entry_status: "OFFERED",
      });
      expect(+rows[0].starts_at).toBe(+start);
      expect(await holdOf(rows[0].appointment_id)).toMatchObject({
        status: "ACTIVE",
        purpose: "WAITLIST_OFFER",
      });
      const firstOffer = rows[0].id as string;
      expect(raisedPhone.last()).toMatchObject({
        type: "template",
        template: {
          name: "waitlist_offer",
          payloads: [
            `OFFER:${firstOffer}:ACCEPT`,
            `OFFER:${firstOffer}:DECLINE`,
          ],
        },
      });
      // While it is offered, nobody else can book the slot.
      const clash = await call(p, reception, "POST", "/appointments", {
        patient_id: await newPatient(p),
        appointment_type_id: p.typeId,
        practitioner_id: p.practitionerIds[0],
        location_id: p.locationId,
        start: start.toISOString(),
        source_channel: "PHONE",
      });
      expect(clash.json().error).toBe("SLOT_UNAVAILABLE");
      // Another patient cannot take someone else's offer.
      await earlyPhone.send({
        button: `OFFER:${firstOffer}:ACCEPT`,
        title: "Book it",
      });
      expect(earlyPhone.last().text).toMatch(/couldn't find that offer/);

      await raisedPhone.send({
        button: `OFFER:${firstOffer}:DECLINE`,
        title: "No thanks",
      });
      expect(raisedPhone.last().text).toMatch(/still on our waitlist/);
      rows = await offers(p);
      expect(rows.map((r) => [r.patient_id, r.status])).toEqual([
        [raised, "DECLINED"],
        [early, "PENDING"],
      ]);
      expect(await holdOf(rows[0].appointment_id)).toMatchObject({
        status: "RELEASED",
        close_reason: "OFFER_DECLINED",
      });
      const secondOffer = rows[1].id as string;
      expect(earlyPhone.last().template?.payloads).toEqual([
        `OFFER:${secondOffer}:ACCEPT`,
        `OFFER:${secondOffer}:DECLINE`,
      ]);

      await earlyPhone.send({
        button: `OFFER:${secondOffer}:ACCEPT`,
        title: "Book it",
      });
      expect(earlyPhone.last().text).toMatch(/^You're booked for /);
      const [booked] = await appointmentsOf(p, early);
      expect(booked).toMatchObject({
        status: "CONFIRMED",
        waitlist_entry_id: rows[1].entry_id,
      });
      expect(+booked.starts_at).toBe(+start);
      const entries = await ownerPool().query(
        "SELECT patient_id, status, booked_appointment_id FROM scheduling.waitlist_entries WHERE tenant_id=$1 ORDER BY created_at",
        [p.tenantId],
      );
      expect(entries.rows).toEqual([
        {
          patient_id: early,
          status: "BOOKED",
          booked_appointment_id: booked.id,
        },
        { patient_id: raised, status: "ACTIVE", booked_appointment_id: null },
      ]);
      expect((await offers(p)).map((r) => r.status)).toEqual([
        "DECLINED",
        "ACCEPTED",
      ]);
      // Confirmed in the conversation: no template repeats it.
      expect(
        (
          await deliveries(
            p,
            "notification_type='APPOINTMENT_CONFIRMATION' AND appointment_id=$3",
            [booked.id],
          )
        )[0],
      ).toMatchObject({
        status: "SKIPPED",
        skip_reason: "CONFIRMED_IN_CONVERSATION",
      });
      // A second tap changes nothing.
      await earlyPhone.send({
        button: `OFFER:${secondOffer}:ACCEPT`,
        title: "Book it",
      });
      expect(earlyPhone.last().text).toMatch(/already answered/);
      expect(await appointmentsOf(p, early)).toHaveLength(1);
    });

    it("skips patients it cannot tell, passes a lapsed offer on, and lets staff answer for a patient", async () => {
      const p = await newPractice();
      const silent = await newPatient(p);
      const lapsing = await newPatient(p);
      const caller = await newPatient(p);
      await consent(p, lapsing, { whatsapp: true });
      await consent(p, caller, { whatsapp: true });
      const { platform } = await wa.channelPractice({
        practice: p,
        allowList: [await mobileOf(lapsing), await mobileOf(caller)],
      });
      const reception = await member(p, "RECEPTIONIST");
      for (const w of [silent, lapsing, caller])
        expect((await joinWaitlist(p, reception, w)).statusCode).toBe(201);
      const start = slot(4, "14:00");
      await freeSlot(p, reception, start);
      await platform.drain();
      // The first in line never agreed to messages: passed over, no trace.
      let rows = await offers(p);
      expect(rows.map((r) => [r.patient_id, r.status])).toEqual([
        [lapsing, "PENDING"],
      ]);
      expect(platform.metrics.snapshot()).toMatchObject({
        'access_waitlist_candidates_skipped_total{reason="NO_CONSENT"}': 1,
      });

      // The offer lapses unanswered.
      await asTimePasses([
        [
          "UPDATE scheduling.waitlist_offers SET offered_at=now()-interval '2 hours', expires_at=now()-interval '1 second' WHERE id=$1",
          [rows[0].id],
        ],
        [
          "UPDATE scheduling.slot_holds SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 second' WHERE appointment_id=$1",
          [rows[0].appointment_id],
        ],
        [
          "UPDATE scheduling.appointments SET created_at=now()-interval '2 hours', hold_expires_at=now()-interval '1 second' WHERE id=$1",
          [rows[0].appointment_id],
        ],
      ]);
      expect(await platform.sweeps.expireHolds(p.tenantId)).toBe(1);
      await platform.drain();
      rows = await offers(p);
      expect(rows.map((r) => [r.patient_id, r.status, r.entry_status])).toEqual(
        [
          [lapsing, "EXPIRED", "ACTIVE"],
          [caller, "PENDING", "OFFERED"],
        ],
      );

      // The patient phones in: staff take the answer.
      const accepted = await call(
        p,
        reception,
        "POST",
        `/waitlist-offers/${rows[1].id}/accept`,
        {},
      );
      expect(accepted.statusCode).toBe(200);
      const appointment = accepted.json().appointment;
      expect(appointment).toMatchObject({
        status: "CONFIRMED",
        patient: { id: caller },
        waitlist_entry_id: rows[1].entry_id,
      });
      await platform.drain();
      // Taken by phone, so the written confirmation does go out.
      expect(
        (
          await deliveries(
            p,
            "notification_type='APPOINTMENT_CONFIRMATION' AND appointment_id=$3",
            [appointment.id],
          )
        )[0],
      ).toMatchObject({ status: "SENT", channel: "WHATSAPP" });
      expect(
        (
          await call(
            p,
            reception,
            "POST",
            `/waitlist-offers/${rows[1].id}/decline`,
            {},
          )
        ).json().error,
      ).toBe("WAITLIST_OFFER_NOT_PENDING");
    });

    it("taking a patient off the waitlist, or booking them directly, passes their held slot to the next patient", async () => {
      const p = await newPractice();
      const [a, b, c] = [
        await newPatient(p),
        await newPatient(p),
        await newPatient(p),
      ];
      for (const w of [a, b, c]) await consent(p, w, { whatsapp: true });
      const { platform } = await wa.channelPractice({
        practice: p,
        allowList: [await mobileOf(a), await mobileOf(b), await mobileOf(c)],
      });
      const reception = await member(p, "RECEPTIONIST");
      const entry = new Map<string, string>();
      for (const w of [a, b, c])
        entry.set(w, (await joinWaitlist(p, reception, w)).json().id);
      const readOnly = await member(p, "READ_ONLY");
      expect(
        (await joinWaitlist(p, readOnly, await newPatient(p))).statusCode,
      ).toBe(403);

      const start = slot(5, "11:00");
      await freeSlot(p, reception, start);
      await platform.drain();
      let rows = await offers(p);
      expect(rows.map((r) => r.patient_id)).toEqual([a]);

      // Staff take the first patient off the list: their offer is withdrawn
      // and the slot goes to the next patient.
      const current = (
        await call(p, reception, "GET", `/waitlist/${entry.get(a)}`)
      ).json();
      expect(current).toMatchObject({
        status: "OFFERED",
        pending_offer: { id: rows[0].id },
      });
      const removed = await call(
        p,
        reception,
        "POST",
        `/waitlist/${entry.get(a)}/cancel`,
        { expected_version: current.version },
      );
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ status: "CANCELLED" });
      await platform.drain();
      rows = await offers(p);
      expect(rows.map((r) => [r.patient_id, r.status])).toEqual([
        [a, "WITHDRAWN"],
        [b, "PENDING"],
      ]);
      expect(await holdOf(rows[0].appointment_id)).toMatchObject({
        status: "RELEASED",
      });

      // The second patient is booked directly for another time: their entry
      // closes, and the slot held for them goes on to the third.
      const direct = await call(p, reception, "POST", "/appointments", {
        patient_id: b,
        appointment_type_id: p.typeId,
        practitioner_id: p.practitionerIds[1],
        location_id: p.locationId,
        start: slot(6, "09:30").toISOString(),
        source_channel: "PHONE",
        waitlist_entry_id: entry.get(b),
      });
      expect(direct.statusCode).toBe(201);
      await platform.drain();
      rows = await offers(p);
      expect(rows.map((r) => [r.patient_id, r.status])).toEqual([
        [a, "WITHDRAWN"],
        [b, "WITHDRAWN"],
        [c, "PENDING"],
      ]);
      expect(
        (await call(p, reception, "GET", `/waitlist/${entry.get(b)}`)).json(),
      ).toMatchObject({
        status: "BOOKED",
        booked_appointment_id: direct.json().appointment.id,
        pending_offer: null,
      });
      // The queue shows who is still waiting, with the live offer.
      const queue = (await call(p, reception, "GET", "/waitlist")).json().items;
      expect(
        queue.map((e: { patient: { id: string } }) => e.patient.id),
      ).toEqual([c]);
      expect(queue[0].pending_offer).toMatchObject({ id: rows[2].id });

      // Entries past their last date close on their own.
      await asTimePasses([
        [
          "UPDATE scheduling.waitlist_entries SET earliest_date=current_date-20, latest_date=current_date-10 WHERE id=$1",
          [entry.get(c)],
        ],
      ]);
      const extra = await newPatient(p);
      const stale = (await joinWaitlist(p, reception, extra)).json().id;
      await asTimePasses([
        [
          "UPDATE scheduling.waitlist_entries SET earliest_date=current_date-20, latest_date=current_date-10 WHERE id=$1",
          [stale],
        ],
      ]);
      expect(await platform.sweeps.expireWaitlistEntries(p.tenantId)).toBe(1);
      expect(
        (await call(p, reception, "GET", `/waitlist/${stale}`)).json().status,
      ).toBe("EXPIRED");
    });
  },
);
