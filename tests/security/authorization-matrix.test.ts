import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  PRACTICE_ROLES,
  type PracticeRole,
} from "../../packages/contracts/src/index.js";
import {
  practiceCan,
  type PracticePermission,
} from "../../packages/policy/src/index.js";
import {
  closePools,
  databaseEnabled,
  mintToken,
  ownerPool,
  testApi,
  type TestApi,
} from "../support/harness.js";
import { newPractice, type TestPractice } from "../support/scheduling.js";

/**
 * The practice API's authorisation matrix, reviewed: every route under
 * /v1/practices/:practiceId and the one permission it requires. The suite
 * fails when the API gains a route that is not listed here, so a new route
 * cannot ship without a decision about who may call it.
 */
const P = "/v1/practices/:practiceId";
const MATRIX: Record<string, PracticePermission> = {
  [`GET ${P}/context`]: "schedule.read",
  [`GET ${P}/settings`]: "schedule.read",
  [`PATCH ${P}/settings`]: "configuration.manage",
  [`GET ${P}/locations`]: "schedule.read",
  [`POST ${P}/locations`]: "configuration.manage",
  [`PATCH ${P}/locations/:locationId`]: "configuration.manage",
  [`GET ${P}/practitioners`]: "schedule.read",
  [`POST ${P}/practitioners`]: "configuration.manage",
  [`PATCH ${P}/practitioners/:practitionerId`]: "configuration.manage",
  [`GET ${P}/appointment-types`]: "schedule.read",
  [`POST ${P}/appointment-types`]: "configuration.manage",
  [`PATCH ${P}/appointment-types/:typeId`]: "configuration.manage",
  [`GET ${P}/availability-rules`]: "schedule.read",
  [`POST ${P}/availability-rules`]: "schedule.hours.manage",
  [`POST ${P}/availability-rules/:ruleId/remove`]: "schedule.hours.manage",
  [`GET ${P}/availability-exceptions`]: "schedule.read",
  [`POST ${P}/availability-exceptions`]: "schedule.exceptions.manage",
  [`POST ${P}/availability-exceptions/:exceptionId/remove`]:
    "schedule.exceptions.manage",
  [`POST ${P}/schedule-blocks`]: "schedule.blocks.manage",
  [`POST ${P}/schedule-blocks/:blockId/remove`]: "schedule.blocks.manage",
  [`GET ${P}/availability`]: "schedule.read",
  [`GET ${P}/calendar`]: "schedule.read",
  [`GET ${P}/appointments`]: "schedule.read",
  [`POST ${P}/appointments`]: "appointment.book",
  [`GET ${P}/appointments/:appointmentId`]: "schedule.read",
  [`GET ${P}/appointments/:appointmentId/history`]: "schedule.read",
  [`POST ${P}/appointments/:appointmentId/reschedule`]:
    "appointment.reschedule",
  [`POST ${P}/appointments/:appointmentId/cancel`]: "appointment.cancel",
  [`POST ${P}/appointments/:appointmentId/check-in`]: "appointment.check_in",
  [`POST ${P}/appointments/:appointmentId/start`]: "appointment.progress",
  [`POST ${P}/appointments/:appointmentId/complete`]: "appointment.progress",
  [`POST ${P}/appointments/:appointmentId/no-show`]: "appointment.no_show",
  [`PATCH ${P}/appointments/:appointmentId/notes`]: "appointment.notes",
  [`GET ${P}/appointments/:appointmentId/notifications`]: "notification.read",
  [`POST ${P}/slot-holds`]: "appointment.book",
  [`GET ${P}/slot-holds/:holdId`]: "schedule.read",
  [`POST ${P}/slot-holds/:holdId/confirm`]: "appointment.book",
  [`POST ${P}/slot-holds/:holdId/release`]: "appointment.book",
  [`GET ${P}/patients`]: "patient.read",
  [`POST ${P}/patients`]: "patient.write",
  [`GET ${P}/patients/:patientId`]: "patient.read",
  [`PATCH ${P}/patients/:patientId`]: "patient.write",
  [`POST ${P}/patients/:patientId/contacts`]: "patient.write",
  [`POST ${P}/patients/:patientId/contacts/:contactId/remove`]: "patient.write",
  [`POST ${P}/patients/:patientId/identifiers`]: "patient.write",
  [`GET ${P}/patients/:patientId/notification-preferences`]:
    "notification.read",
  [`PUT ${P}/patients/:patientId/notification-preferences`]:
    "notification.preferences.manage",
  [`GET ${P}/patient-duplicates`]: "patient.duplicates.review",
  [`POST ${P}/patient-duplicates/:reviewId/review`]:
    "patient.duplicates.review",
  [`GET ${P}/memberships`]: "staff.manage",
  [`PUT ${P}/memberships/:userId`]: "staff.manage",
  [`GET ${P}/audit-events`]: "audit.read",
  [`GET ${P}/notifications`]: "notification.read",
  [`GET ${P}/integrations/connections`]: "integration.manage",
  [`POST ${P}/integrations/connections`]: "integration.manage",
  [`PATCH ${P}/integrations/connections/:connectionId`]: "integration.manage",
  [`GET ${P}/integrations/events`]: "integration.manage",
  [`GET ${P}/conversations`]: "conversation.manage",
  [`GET ${P}/conversations/:conversationId`]: "conversation.manage",
  [`PATCH ${P}/conversations/:conversationId`]: "conversation.manage",
  [`POST ${P}/conversations/:conversationId/messages`]: "conversation.manage",
  [`GET ${P}/referrals`]: "referral.read",
  [`POST ${P}/referrals`]: "referral.register",
  [`GET ${P}/referrals/:referralId`]: "referral.read",
  [`POST ${P}/referrals/:referralId/verify`]: "referral.verify",
  [`POST ${P}/referrals/:referralId/reject`]: "referral.verify",
  [`POST ${P}/referrals/:referralId/cancel`]: "referral.verify",
  [`POST ${P}/referrals/:referralId/documents`]: "referral.register",
  [`POST ${P}/referrals/:referralId/documents/:documentId/link`]:
    "referral.document.read",
  [`GET ${P}/waitlist`]: "waitlist.read",
  [`POST ${P}/waitlist`]: "waitlist.manage",
  [`POST ${P}/waitlist/announce-slot`]: "waitlist.manage",
  [`GET ${P}/waitlist/:entryId`]: "waitlist.read",
  [`POST ${P}/waitlist/:entryId/cancel`]: "waitlist.manage",
  [`POST ${P}/waitlist-offers/:offerId/accept`]: "appointment.book",
  [`POST ${P}/waitlist-offers/:offerId/decline`]: "waitlist.manage",
};

/** Every route the running app serves, from Fastify's own route tree. */
function servedRoutes(app: TestApi["app"]): string[] {
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = /^(.*?)[├└]── (.*?)(?: \(([^)]*)\))?$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    const path = (depth ? stack[depth - 1] : "") + m[2]!;
    stack[depth] = path;
    stack.length = depth + 1;
    for (const method of (m[3] ?? "").split(", ").filter(Boolean))
      if (method !== "HEAD" && method !== "OPTIONS")
        out.push(`${method} ${path}`);
  }
  return out;
}

describe.runIf(databaseEnabled)("practice API authorisation matrix", () => {
  let api: TestApi;
  let p: TestPractice;
  const tokens = new Map<PracticeRole | "OUTSIDER", string>();
  beforeAll(async () => {
    api = await testApi({ auth: "jwt" });
    p = await newPractice();
    const other = await newPractice();
    const grant = async (x: TestPractice, role: PracticeRole) => {
      const user = randomUUID();
      await ownerPool().query(
        `INSERT INTO directory.practice_memberships(tenant_id,practice_id,user_id,role,status,display_name,created_by,updated_by)
         VALUES($1,$2,$3,$4,'ACTIVE',$5,'test','test')`,
        [x.tenantId, x.practiceId, user, role, `${role} user`],
      );
      return mintToken(user);
    };
    for (const role of PRACTICE_ROLES) tokens.set(role, await grant(p, role));
    // An administrator of another practice (and organisation).
    tokens.set("OUTSIDER", await grant(other, "PRACTICE_ADMIN"));
  });
  afterAll(async () => {
    await api.close();
    await closePools();
  });
  const request = (route: string, token: string | null) => {
    const [method, pattern] = route.split(" ") as [string, string];
    const url = pattern.replace(/:(\w+)/g, (_, name: string) =>
      name === "practiceId" ? p.practiceId : randomUUID(),
    );
    return api.app.inject({
      method: method as "GET",
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      },
      ...(method === "GET" ? {} : { payload: {} }),
    });
  };

  it("lists every practice route the API serves, and nothing it does not", () => {
    const served = servedRoutes(api.app).filter((r) =>
      r.split(" ")[1]!.startsWith(`${P}/`),
    );
    expect(served.length).toBeGreaterThan(60);
    expect([...served].sort()).toEqual(Object.keys(MATRIX).sort());
  });

  it("answers each role exactly as the policy says, on every route", async () => {
    const wrong: string[] = [];
    for (const [route, permission] of Object.entries(MATRIX))
      for (const role of PRACTICE_ROLES) {
        const res = await request(route, tokens.get(role)!);
        const allowed = practiceCan(role, permission);
        // Permitted calls get past authorisation (their empty payloads and
        // unknown ids then fail validation or lookup, never with 403).
        if (allowed ? res.statusCode === 403 : res.statusCode !== 403)
          wrong.push(`${role} ${route} -> ${res.statusCode}`);
        if (!allowed && res.statusCode === 403)
          expect(res.json().error).toBe("FORBIDDEN");
      }
    expect(wrong).toEqual([]);
  });

  it("refuses every route without credentials, and to members of other practices", async () => {
    const leaks: string[] = [];
    for (const route of Object.keys(MATRIX)) {
      const anonymous = await request(route, null);
      if (anonymous.statusCode !== 401)
        leaks.push(`anonymous ${route} -> ${anonymous.statusCode}`);
      const outsider = await request(route, tokens.get("OUTSIDER")!);
      if (![403, 404].includes(outsider.statusCode))
        leaks.push(`outsider ${route} -> ${outsider.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });

  it("ignores development identity headers when JWT authentication is on", async () => {
    // The synthetic bridge's headers must not grant anything in JWT mode.
    for (const route of [`GET ${P}/context`, `GET ${P}/patients`]) {
      const [method, pattern] = route.split(" ") as [string, string];
      const res = await api.app.inject({
        method: method as "GET",
        url: pattern.replace(":practiceId", p.practiceId),
        headers: {
          "x-tenant-id": p.tenantId,
          "x-practice-role": "PRACTICE_ADMIN",
          "x-access-role": "ADMIN",
          "x-access-user": "intruder",
        },
      });
      expect(res.statusCode, route).toBe(401);
    }
  });
});
