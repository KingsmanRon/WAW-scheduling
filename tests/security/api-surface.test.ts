import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  closePools,
  databaseEnabled,
  mintToken,
  ownerPool,
  testApi,
  type TestApi,
} from "../support/harness.js";
import { newPractice, type TestPractice } from "../support/scheduling.js";

describe.runIf(databaseEnabled)("API surface hardening", () => {
  let api: TestApi;
  let p: TestPractice;
  let token: string;
  beforeAll(async () => {
    api = await testApi({ auth: "jwt" });
    p = await newPractice();
    const user = randomUUID();
    await ownerPool().query(
      `INSERT INTO directory.practice_memberships(tenant_id,practice_id,user_id,role,status,display_name,created_by,updated_by)
       VALUES($1,$2,$3,'RECEPTIONIST','ACTIVE','Reception','test','test')`,
      [p.tenantId, p.practiceId, user],
    );
    token = await mintToken(user);
  });
  afterAll(async () => {
    await api.close();
    await closePools();
  });
  const practice = (rest: string) => `/v1/practices/${p.practiceId}${rest}`;

  it("marks every response uncacheable, unsniffable and unframeable", async () => {
    const responses = [
      await api.app.inject({ method: "GET", url: "/health" }),
      await api.app.inject({ method: "GET", url: "/v1/me" }),
      await api.app.inject({
        method: "GET",
        url: practice("/patients?q=Syn"),
        headers: { authorization: `Bearer ${token}` },
      }),
      await api.app.inject({ method: "GET", url: "/v1/no-such-route" }),
    ];
    expect(responses.map((r) => r.statusCode)).toEqual([200, 401, 200, 404]);
    for (const r of responses)
      expect(r.headers).toMatchObject({
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      });
  });

  it("allows the console's origin and no other", async () => {
    const preflight = (origin: string) =>
      api.app.inject({
        method: "OPTIONS",
        url: practice("/appointments"),
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,idempotency-key",
        },
      });
    const allowed = await preflight("http://localhost:3000");
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
    const other = await preflight("https://attacker.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers malformed and oversized requests without internals", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const garbled = await api.app.inject({
      method: "POST",
      url: practice("/patients"),
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: '{"given_name": ',
    });
    const invalid = await api.app.inject({
      method: "POST",
      url: practice("/patients"),
      headers: { ...auth, "idempotency-key": randomUUID() },
      payload: { given_name: "A", family_name: "B", source_channel: "NOPE" },
    });
    const huge = await api.app.inject({
      method: "POST",
      url: practice("/patients"),
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: JSON.stringify({ given_name: "x".repeat(2 * 1024 * 1024) }),
    });
    expect([garbled.statusCode, invalid.statusCode, huge.statusCode]).toEqual([
      400, 400, 413,
    ]);
    // Routes that take a base64 document accept a large body (and then
    // authenticate and validate it as usual).
    const upload = await api.app.inject({
      method: "POST",
      url: practice(`/referrals/${randomUUID()}/documents`),
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      payload: JSON.stringify({
        document_type: "REFERRAL_LETTER",
        media_type: "application/pdf",
        content_base64: "A".repeat(3 * 1024 * 1024),
      }),
    });
    expect(upload.statusCode).not.toBe(413);
    const intake = await api.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(intake.statusCode).toBe(401);
    for (const r of [garbled, invalid, huge]) {
      expect(r.body).not.toMatch(/\bat .*\.(ts|js):\d+/);
      expect(r.body).not.toMatch(/SELECT|INSERT|postgres|node_modules/i);
    }
  });

  it("requires an Idempotency-Key on every change and binds it to one request", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const body = {
      given_name: "Idem",
      family_name: "Potent",
      source_channel: "PHONE",
    };
    const missing = await api.app.inject({
      method: "POST",
      url: practice("/patients"),
      headers: auth,
      payload: body,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const key = randomUUID();
    const first = await api.app.inject({
      method: "POST",
      url: practice("/patients"),
      headers: { ...auth, "idempotency-key": key },
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    const reused = await api.app.inject({
      method: "POST",
      url: practice("/patients"),
      headers: { ...auth, "idempotency-key": key },
      payload: { ...body, family_name: "Different" },
    });
    expect(reused.statusCode).toBe(422);
  });
});
