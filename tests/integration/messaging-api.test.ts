import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { PracticeRole } from "../../packages/contracts/src/index.js";
import { verifyWebhookSignature } from "../../packages/integrations/src/index.js";
import { bookAppointment } from "../../packages/scheduling/src/index.js";
import {
  closePools,
  databaseEnabled,
  mintToken,
  ownerPool,
  testApi,
  type TestApi,
} from "../support/harness.js";
import {
  connectWhatsApp,
  deliveries,
  testPlatform,
} from "../support/platform.js";
import {
  newPatient,
  newPractice,
  run,
  slot,
  staffCtx,
  type TestPractice,
} from "../support/scheduling.js";

const EMR_SECRET = "emr-webhook-shared-secret-for-tests-0123456789";

async function grantPracticeRole(
  p: TestPractice,
  userId: string,
  role: PracticeRole,
) {
  await ownerPool().query(
    `INSERT INTO directory.practice_memberships(tenant_id,practice_id,user_id,role,status,display_name,created_by,updated_by)
     VALUES($1,$2,$3,$4,'ACTIVE',$5,'test','test')`,
    [p.tenantId, p.practiceId, userId, role, `${role} user`],
  );
}

/** A practice system receiving webhooks: scripted status codes, recorded calls. */
class Receiver {
  readonly calls: {
    headers: http.IncomingHttpHeaders;
    body: string;
  }[] = [];
  statuses: number[] = [];
  private server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      this.calls.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(this.statuses.shift() ?? 200, {
        "x-request-id": `emr-${this.calls.length}`,
      });
      res.end("{}");
    });
  });
  url = "";
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hooks/access`;
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

describe.runIf(databaseEnabled)(
  "notification consent, visibility and EMR webhooks (API)",
  () => {
    let api: TestApi;
    let strictApi: TestApi;
    let p: TestPractice;
    let q: TestPractice;
    let patient: string;
    const tokens: Record<string, string> = {};
    const receiver = new Receiver();
    beforeAll(async () => {
      api = await testApi({ auth: "jwt", allowPrivateTargets: true });
      strictApi = await testApi({ auth: "jwt" });
      await receiver.start();
      p = await newPractice();
      q = await newPractice();
      for (const role of [
        "PRACTICE_ADMIN",
        "RECEPTIONIST",
        "READ_ONLY",
      ] as const) {
        const user = randomUUID();
        await grantPracticeRole(p, user, role);
        tokens[role] = await mintToken(user);
      }
      const other = randomUUID();
      await grantPracticeRole(q, other, "PRACTICE_ADMIN");
      tokens.OTHER = await mintToken(other);
      patient = await newPatient(p);
    });
    afterAll(async () => {
      await api.close();
      await strictApi.close();
      await receiver.stop();
      await closePools();
    });
    const call = (
      method: "GET" | "POST" | "PATCH" | "PUT",
      url: string,
      as: string,
      payload?: unknown,
      key: string | null = randomUUID(),
      target: TestApi = api,
    ) =>
      target.app.inject({
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

    it("records a patient's notification consent idempotently, with optimistic concurrency and audit", async () => {
      const url = path(p, `/patients/${patient}/notification-preferences`);
      const initial = await call("GET", url, "RECEPTIONIST");
      expect(initial.statusCode).toBe(200);
      expect(initial.json().preferences).toMatchObject({
        whatsapp_opt_in: false,
        version: null,
      });
      const body = {
        whatsapp_opt_in: true,
        email_opt_in: false,
        reminders_enabled: true,
        preferred_channel: "WHATSAPP",
      };
      const key = randomUUID();
      const set = await call("PUT", url, "RECEPTIONIST", body, key);
      expect(set.statusCode).toBe(200);
      expect(set.json().preferences).toMatchObject({
        whatsapp_opt_in: true,
        whatsapp_consent_source: "STAFF_RECORDED",
        version: 0,
      });
      expect(set.json().preferences.whatsapp_consent_at).toBeTruthy();
      const replay = await call("PUT", url, "RECEPTIONIST", body, key);
      expect(replay.statusCode).toBe(200);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(
        (
          await call(
            "PUT",
            url,
            "RECEPTIONIST",
            { ...body, reminders_enabled: false },
            key,
          )
        ).statusCode,
      ).toBe(422);
      // A second writer that did not read the current version is refused.
      const stale = await call("PUT", url, "RECEPTIONIST", body);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe("VERSION_CONFLICT");
      const unconsented = await call("PUT", url, "RECEPTIONIST", {
        ...body,
        preferred_channel: "EMAIL",
        expected_version: 0,
      });
      expect(unconsented.statusCode).toBe(422);
      expect(unconsented.json().error).toBe("PREFERRED_CHANNEL_NOT_CONSENTED");
      expect((await call("PUT", url, "READ_ONLY", body)).statusCode).toBe(403);
      expect(
        (await call("PUT", url, "RECEPTIONIST", body, null)).statusCode,
      ).toBe(400);
      // Another practice's staff cannot reach this patient through their own practice.
      expect(
        (
          await call(
            "GET",
            path(q, `/patients/${patient}/notification-preferences`),
            "OTHER",
          )
        ).statusCode,
      ).toBe(404);
      expect((await call("GET", url, "OTHER")).statusCode).toBe(403);
      const audit = await ownerPool().query(
        "SELECT action, changes FROM platform.audit_events WHERE tenant_id=$1 AND resource_id=$2 AND action='notification_preferences.updated'",
        [p.tenantId, patient],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].changes).toEqual({
        before: null,
        after: {
          whatsapp_opt_in: true,
          email_opt_in: false,
          reminders_enabled: true,
          preferred_channel: "WHATSAPP",
        },
      });
    });

    it("shows staff what was sent, skipped or failed, with masked recipients", async () => {
      await connectWhatsApp(p);
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
      const ctx = staffCtx(p);
      const id = await run(ctx, (c) =>
        bookAppointment(c, ctx, {
          patientId: patient,
          appointmentTypeId: p.typeId,
          practitionerId: p.practitionerIds[0],
          locationId: p.locationId,
          start: slot(4, "10:00"),
        }),
      );
      await platform.drain();
      const list = await call(
        "GET",
        path(p, "/notifications?status=SENT,PENDING"),
        "RECEPTIONIST",
      );
      expect(list.statusCode).toBe(200);
      const items = list.json().items as {
        notification_type: string;
        status: string;
        recipient: string;
        appointment_id: string;
      }[];
      expect(items.map((i) => [i.notification_type, i.status]).sort()).toEqual([
        ["APPOINTMENT_CONFIRMATION", "SENT"],
        ["APPOINTMENT_REMINDER_24H", "PENDING"],
      ]);
      expect(items[0]!.recipient).toBe(
        `${number.slice(0, 3)} •••• ${number.slice(-4)}`,
      );
      expect(JSON.stringify(list.json())).not.toContain(number);
      const forAppointment = await call(
        "GET",
        path(p, `/appointments/${id}/notifications`),
        "RECEPTIONIST",
      );
      expect(forAppointment.json().items).toHaveLength(2);
      expect(
        (await call("GET", path(p, "/notifications"), "READ_ONLY")).statusCode,
      ).toBe(403);
    });

    it("manages EMR webhook connections: admin only, public HTTPS targets, secrets by reference", async () => {
      const create = {
        name: "Practice EMR",
        url: receiver.url,
        secret_ref: "EMR_WEBHOOK_TEST",
        event_types: ["appointment.confirmed", "appointment.cancelled"],
      };
      expect(
        (
          await call(
            "POST",
            path(p, "/integrations/connections"),
            "RECEPTIONIST",
            create,
          )
        ).statusCode,
      ).toBe(403);
      // Production rules: https and a public address only.
      const plain = await call(
        "POST",
        path(p, "/integrations/connections"),
        "PRACTICE_ADMIN",
        create,
        randomUUID(),
        strictApi,
      );
      expect(plain.statusCode).toBe(422);
      expect(plain.json().error).toBe("TARGET_URL_NOT_HTTPS");
      const internal = await call(
        "POST",
        path(p, "/integrations/connections"),
        "PRACTICE_ADMIN",
        { ...create, url: "https://127.0.0.1/hooks" },
        randomUUID(),
        strictApi,
      );
      expect(internal.json().error).toBe("TARGET_NOT_PUBLIC");
      expect(
        (
          await call(
            "POST",
            path(p, "/integrations/connections"),
            "PRACTICE_ADMIN",
            {
              ...create,
              secret_ref: "DATABASE_URL",
            },
          )
        ).json().error,
      ).toBe("VALIDATION_FAILED");
      const created = await call(
        "POST",
        path(p, "/integrations/connections"),
        "PRACTICE_ADMIN",
        create,
      );
      expect(created.statusCode).toBe(201);
      const connection = created.json().connection;
      expect(connection).toMatchObject({
        provider: "EMR_WEBHOOK",
        status: "ACTIVE",
        secret_ref: "EMR_WEBHOOK_TEST",
        config: { url: receiver.url, event_types: create.event_types },
        version: 0,
      });
      const listed = await call(
        "GET",
        path(p, "/integrations/connections"),
        "PRACTICE_ADMIN",
      );
      expect(
        listed
          .json()
          .items.map((c: { provider: string }) => c.provider)
          .sort(),
      ).toEqual(["EMR_WEBHOOK", "WHATSAPP_CLOUD"]);
      // Operator-provisioned WhatsApp connections cannot be edited here.
      const whatsapp = listed
        .json()
        .items.find(
          (c: { provider: string }) => c.provider === "WHATSAPP_CLOUD",
        );
      expect(
        (
          await call(
            "PATCH",
            path(p, `/integrations/connections/${whatsapp.id}`),
            "PRACTICE_ADMIN",
            {
              status: "DISABLED",
              expected_version: 0,
            },
          )
        ).statusCode,
      ).toBe(403);
      const audit = await ownerPool().query(
        "SELECT action FROM platform.audit_events WHERE tenant_id=$1 AND resource_id=$2",
        [p.tenantId, connection.id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        "integration_connection.created",
      ]);
    });

    it("delivers signed appointment events to the EMR, retries server errors and stops on refusals", async () => {
      const platform = testPlatform(p.tenantId, {
        env: { EMR_WEBHOOK_TEST: EMR_SECRET },
        transports: {
          email: null,
          whatsapp: () => ({
            sendTemplate: async () => ({ messageId: `wamid.${randomUUID()}` }),
          }),
        },
      });
      const ctx = staffCtx(p);
      const book = (start: Date) =>
        run(ctx, (c) =>
          bookAppointment(c, ctx, {
            patientId: patient,
            appointmentTypeId: p.typeId,
            practitionerId: p.practitionerIds[1],
            locationId: p.locationId,
            start,
          }),
        );
      receiver.statuses = [500];
      const id = await book(slot(5, "09:00"));
      await platform.drain();
      const events = async () =>
        (
          await ownerPool().query(
            `SELECT id, event_type, status, attempt_count, last_error_code, response_status, external_reference,
                  payload->'data'->>'appointment_id' AS appointment_id
             FROM integration.events WHERE tenant_id=$1 ORDER BY created_at`,
            [p.tenantId],
          )
        ).rows;
      let [event] = await events();
      expect(event).toMatchObject({
        event_type: "appointment.confirmed",
        status: "PENDING",
        attempt_count: 1,
        last_error_code: "HTTP_500",
        appointment_id: id,
      });
      await ownerPool().query(
        "UPDATE integration.events SET next_attempt_at=now() WHERE tenant_id=$1",
        [p.tenantId],
      );
      await platform.drain();
      [event] = await events();
      expect(event).toMatchObject({
        status: "DELIVERED",
        attempt_count: 2,
        response_status: 200,
        external_reference: "emr-2",
      });
      // Both attempts carried the same id and a valid signature.
      expect(receiver.calls).toHaveLength(2);
      for (const call of receiver.calls) {
        expect(call.headers["x-access-event-id"]).toBe(event!.id);
        expect(call.headers["idempotency-key"]).toBe(event!.id);
        expect(
          verifyWebhookSignature({
            secret: EMR_SECRET,
            signature: call.headers["x-access-signature"] as string,
            timestamp: call.headers["x-access-timestamp"] as string,
            body: call.body,
          }),
        ).toBe(true);
      }
      const body = JSON.parse(receiver.calls[1]!.body);
      expect(body).toMatchObject({
        id: event!.id,
        type: "appointment.confirmed",
        practice_id: p.practiceId,
        data: {
          appointment_id: id,
          status: "CONFIRMED",
          patient: { id: patient },
        },
      });
      expect(body.data.patient.patient_number).toMatch(/^[A-Z0-9-]{3,}$/);
      // Administrative facts only: no names leave the platform.
      expect(receiver.calls[1]!.body).not.toMatch(
        /given_name|family_name|Synthetic/,
      );

      // A client error is permanent: no retry.
      receiver.statuses = [400];
      await book(slot(5, "11:00"));
      await platform.drain();
      expect((await events()).at(-1)).toMatchObject({
        status: "FAILED",
        last_error_code: "HTTP_400",
        attempt_count: 1,
      });
      const visible = await call(
        "GET",
        path(p, "/integrations/events?status=FAILED"),
        "PRACTICE_ADMIN",
      );
      expect(visible.json().items).toHaveLength(1);

      // Disabling the connection stops new events; queued ones fail closed.
      const current = (
        await call(
          "GET",
          path(p, "/integrations/connections"),
          "PRACTICE_ADMIN",
        )
      )
        .json()
        .items.find((c: { provider: string }) => c.provider === "EMR_WEBHOOK");
      const stale = await call(
        "PATCH",
        path(p, `/integrations/connections/${current.id}`),
        "PRACTICE_ADMIN",
        {
          status: "DISABLED",
          expected_version: current.version + 1,
        },
      );
      expect(stale.statusCode).toBe(409);
      const disabled = await call(
        "PATCH",
        path(p, `/integrations/connections/${current.id}`),
        "PRACTICE_ADMIN",
        {
          status: "DISABLED",
          expected_version: current.version,
        },
      );
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json().connection.status).toBe("DISABLED");
      const before = (await events()).length;
      await book(slot(6, "09:00"));
      await platform.drain();
      expect((await events()).length).toBe(before);
      expect(await deliveries(p, "status='FAILED'")).toEqual([]);
    });
  },
);
