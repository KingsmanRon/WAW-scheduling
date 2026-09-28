import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DeliveryFailure,
  assertOutboundUrl,
  classifySmtpError,
  classifyWhatsAppError,
  isPublicAddress,
  resolveSecret,
  retryDelaySeconds,
  retryAfterSeconds,
  safeDetail,
  secretRefAllowed,
  signWebhook,
  templateParam,
  verifyWebhookSignature,
  verifyWhatsAppSignature,
  whatsAppConnectionConfigSchema,
} from "../../packages/integrations/src/index.js";
import {
  NOTIFICATION_CATALOGUE,
  formatDeadline,
  formatWhen,
  maskAddress,
  resolveChannel,
  selectRecipient,
  type Contact,
  type Preferences,
} from "../../packages/notifications/src/index.js";
import { NOTIFICATION_TYPES } from "../../packages/contracts/src/index.js";
import { outboxBackoffSeconds } from "../../apps/worker/src/platform/outbox.js";

describe("outbound target safety", () => {
  it("allows only globally routable addresses", () => {
    for (const ip of ["8.8.8.8", "41.0.0.1", "2001:4860:4860::8888"])
      expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "not-an-ip",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });
  it("requires https without credentials and refuses internal hosts", () => {
    const strict = { allowInsecure: false };
    expect(
      assertOutboundUrl("https://emr.example.com/hooks", strict).host,
    ).toBe("emr.example.com");
    for (const [url, code] of [
      ["http://emr.example.com/hooks", "TARGET_URL_NOT_HTTPS"],
      ["https://user:pw@emr.example.com/", "TARGET_URL_HAS_CREDENTIALS"],
      ["https://localhost/hook", "TARGET_NOT_PUBLIC"],
      ["https://127.0.0.1/hook", "TARGET_NOT_PUBLIC"],
      ["https://[::1]/hook", "TARGET_NOT_PUBLIC"],
      ["https://metadata.internal/", "TARGET_NOT_PUBLIC"],
      ["not a url", "TARGET_URL_INVALID"],
    ] as const) {
      const e = (() => {
        try {
          assertOutboundUrl(url, strict);
        } catch (error) {
          return error as DeliveryFailure;
        }
      })();
      expect(e?.code, url).toBe(code);
      expect(e?.kind).toBe("CONFIGURATION");
    }
    // Local development may target a local receiver.
    expect(
      assertOutboundUrl("http://127.0.0.1:9999/x", { allowInsecure: true })
        .port,
    ).toBe("9999");
  });
});

describe("secrets", () => {
  it("honours only provider-prefixed, non-reserved names", () => {
    expect(secretRefAllowed("EMR_WEBHOOK", "EMR_WEBHOOK_CLINIC_A")).toBe(true);
    expect(secretRefAllowed("EMR_WEBHOOK", "DATABASE_URL")).toBe(false);
    expect(secretRefAllowed("WHATSAPP_CLOUD", "WHATSAPP_APP_SECRET")).toBe(
      false,
    );
    expect(secretRefAllowed("WHATSAPP_CLOUD", "WHATSAPP_TOKEN_A")).toBe(true);
    const env = {
      WHATSAPP_TOKEN_A: "t".repeat(40),
      WHATSAPP_TOKEN_SHORT: "abc",
    };
    expect(resolveSecret("WHATSAPP_CLOUD", "WHATSAPP_TOKEN_A", env)).toBe(
      "t".repeat(40),
    );
    for (const ref of ["WHATSAPP_TOKEN_SHORT", "WHATSAPP_MISSING", "PATH"])
      expect(() => resolveSecret("WHATSAPP_CLOUD", ref, env)).toThrow(
        DeliveryFailure,
      );
  });
});

describe("WhatsApp Cloud API adapter", () => {
  it("classifies Graph API errors onto the retry taxonomy", () => {
    const body = (code: number) => ({ error: { code, message: "x" } });
    expect(classifyWhatsAppError(429, body(130429), 30)).toMatchObject({
      kind: "TRANSIENT",
      code: "WHATSAPP_130429",
      retryAfterSeconds: 30,
    });
    expect(classifyWhatsAppError(400, body(131056), null).kind).toBe(
      "TRANSIENT",
    );
    expect(classifyWhatsAppError(400, body(131026), null)).toMatchObject({
      kind: "PERMANENT",
      code: "WHATSAPP_131026",
    });
    expect(classifyWhatsAppError(401, body(190), null).kind).toBe(
      "CONFIGURATION",
    );
    expect(classifyWhatsAppError(400, body(132001), null).kind).toBe(
      "CONFIGURATION",
    );
    expect(classifyWhatsAppError(403, body(200), null).kind).toBe(
      "CONFIGURATION",
    );
    expect(classifyWhatsAppError(500, body(131000), null).kind).toBe(
      "TRANSIENT",
    );
    expect(classifyWhatsAppError(503, "<html>", null)).toMatchObject({
      kind: "TRANSIENT",
      code: "HTTP_503",
    });
    expect(classifyWhatsAppError(400, body(131008), null).kind).toBe(
      "PERMANENT",
    );
  });
  it("verifies webhook signatures over the raw body in constant time", () => {
    const secret = "app-secret-for-tests";
    const raw = Buffer.from('{"object":"whatsapp_business_account"}');
    const good = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    expect(verifyWhatsAppSignature(secret, raw, good)).toBe(true);
    expect(verifyWhatsAppSignature(secret, Buffer.from("{}"), good)).toBe(
      false,
    );
    expect(verifyWhatsAppSignature("other", raw, good)).toBe(false);
    expect(verifyWhatsAppSignature(secret, raw, undefined)).toBe(false);
    expect(verifyWhatsAppSignature(secret, raw, "sha1=abc")).toBe(false);
    expect(verifyWhatsAppSignature("", raw, good)).toBe(false);
  });
  it("sanitises template parameters and validates connection config", () => {
    expect(templateParam("Line one\nline\ttwo    three ")).toBe(
      "Line one line two three",
    );
    expect(templateParam("   ")).toBe("-");
    expect(templateParam("x".repeat(300))).toHaveLength(200);
    expect(
      whatsAppConnectionConfigSchema.parse({ phone_number_id: "1234567890" }),
    ).toEqual({
      phone_number_id: "1234567890",
      default_language: "en",
      templates: {},
    });
    expect(
      whatsAppConnectionConfigSchema.safeParse({
        phone_number_id: "1234567890",
        access_token: "never-stored-here",
      }).success,
    ).toBe(false);
  });
});

describe("EMR webhook signing", () => {
  it("signs timestamp.body and verifies within the replay window", () => {
    const secret = "emr-webhook-secret-of-sufficient-length";
    const body = '{"id":"1"}';
    const now = Date.UTC(2026, 9, 1, 8, 0, 0);
    const ts = Math.floor(now / 1000);
    const signature = signWebhook(secret, ts, body);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    const check = (
      over: Partial<Parameters<typeof verifyWebhookSignature>[0]>,
    ) =>
      verifyWebhookSignature({
        secret,
        signature,
        timestamp: String(ts),
        body,
        now,
        ...over,
      });
    expect(check({})).toBe(true);
    expect(check({ body: '{"id":"2"}' })).toBe(false);
    expect(check({ secret: "another-secret-of-sufficient-length" })).toBe(
      false,
    );
    expect(check({ now: now + 301_000 })).toBe(false);
    expect(check({ timestamp: "soon" })).toBe(false);
  });
});

describe("failure handling", () => {
  it("never stores phone numbers or addresses in error details", () => {
    expect(
      safeDetail("Recipient +27 82 123 4567 (jane@example.com) not reachable"),
    ).toBe("Recipient [number] ([email]) not reachable");
    expect(new DeliveryFailure("PERMANENT", "bad code!").code).toBe("BAD_CODE");
  });
  it("backs off exponentially with floors for ambiguity and configuration", () => {
    const fixed = () => 0.5;
    const t = (
      kind: DeliveryFailure["kind"],
      retryAfter: number | null = null,
    ) => new DeliveryFailure(kind, "X", null, retryAfter);
    expect(retryDelaySeconds(1, t("TRANSIENT"), fixed)).toBe(30);
    expect(retryDelaySeconds(3, t("TRANSIENT"), fixed)).toBe(120);
    expect(retryDelaySeconds(20, t("TRANSIENT"), fixed)).toBe(3600);
    expect(retryDelaySeconds(1, t("AMBIGUOUS"), fixed)).toBe(180);
    expect(retryDelaySeconds(1, t("CONFIGURATION"), fixed)).toBe(300);
    expect(retryDelaySeconds(1, t("TRANSIENT", 900), fixed)).toBe(900);
    expect(retryAfterSeconds("120")).toBe(120);
    expect(
      retryAfterSeconds(new Date(Date.now() + 60_000).toUTCString()),
    ).toBeGreaterThan(50);
    expect(retryAfterSeconds(undefined)).toBeNull();
    expect(outboxBackoffSeconds(1)).toBe(10);
    expect(outboxBackoffSeconds(4)).toBe(80);
    expect(outboxBackoffSeconds(30)).toBe(900);
  });
  it("classifies SMTP failures", () => {
    expect(classifySmtpError({ code: "EAUTH", responseCode: 535 }).kind).toBe(
      "CONFIGURATION",
    );
    expect(classifySmtpError({ responseCode: 550, response: "no" }).kind).toBe(
      "PERMANENT",
    );
    expect(classifySmtpError({ responseCode: 451 }).kind).toBe("TRANSIENT");
    expect(classifySmtpError({ code: "ECONNECTION" }).kind).toBe("TRANSIENT");
    expect(classifySmtpError({ code: "ETIMEDOUT", command: "DATA" }).kind).toBe(
      "AMBIGUOUS",
    );
  });
});

describe("notification recipient selection", () => {
  const whatsapp: Contact = {
    id: "c1",
    kind: "MOBILE",
    value: "+27820000001",
    is_primary: true,
    whatsapp_capable: true,
  };
  const email: Contact = {
    id: "c2",
    kind: "EMAIL",
    value: "pat@example.com",
    is_primary: true,
    whatsapp_capable: false,
  };
  const prefs = (over: Partial<Preferences> = {}): Preferences => ({
    whatsapp_opt_in: true,
    email_opt_in: false,
    reminders_enabled: true,
    preferred_channel: null,
    ...over,
  });
  const setup = {
    whatsappConnectionId: "conn",
    emailConfigured: true,
    allowList: null,
  };
  it("needs consent, an address and a configured channel", () => {
    const pick = selectRecipient(
      "APPOINTMENT_CONFIRMATION",
      prefs(),
      [whatsapp, email],
      setup,
    );
    expect(pick).toMatchObject({
      ok: true,
      recipient: { channel: "WHATSAPP", address: "+27820000001" },
    });
    expect(
      selectRecipient("APPOINTMENT_CONFIRMATION", null, [whatsapp], setup),
    ).toMatchObject({ ok: false, reason: "NO_CONSENT" });
    expect(
      selectRecipient("APPOINTMENT_CONFIRMATION", prefs(), [email], setup),
    ).toMatchObject({ ok: false, channel: "WHATSAPP", reason: "NO_CONTACT" });
    expect(
      selectRecipient("APPOINTMENT_CONFIRMATION", prefs(), [whatsapp], {
        ...setup,
        whatsappConnectionId: null,
      }),
    ).toMatchObject({ ok: false, reason: "CHANNEL_NOT_CONFIGURED" });
  });
  it("prefers the patient's channel and falls back to another consented one", () => {
    expect(
      selectRecipient(
        "APPOINTMENT_CONFIRMATION",
        prefs({ email_opt_in: true, preferred_channel: "EMAIL" }),
        [whatsapp, email],
        setup,
      ),
    ).toMatchObject({ ok: true, recipient: { channel: "EMAIL" } });
    expect(
      selectRecipient(
        "APPOINTMENT_CONFIRMATION",
        prefs({ email_opt_in: true }),
        [whatsapp, email],
        { ...setup, whatsappConnectionId: null },
      ),
    ).toMatchObject({ ok: true, recipient: { channel: "EMAIL" } });
  });
  it("honours reminder opt-out and the synthetic allow-list", () => {
    expect(
      resolveChannel(
        "WHATSAPP",
        "APPOINTMENT_REMINDER_24H",
        prefs({ reminders_enabled: false }),
        [whatsapp],
        setup,
      ),
    ).toMatchObject({ ok: false, reason: "REMINDERS_DISABLED" });
    // Not a reminder: still sent.
    expect(
      resolveChannel(
        "WHATSAPP",
        "APPOINTMENT_CANCELLED",
        prefs({ reminders_enabled: false }),
        [whatsapp],
        setup,
      ).ok,
    ).toBe(true);
    expect(
      resolveChannel(
        "WHATSAPP",
        "APPOINTMENT_CONFIRMATION",
        prefs(),
        [whatsapp],
        {
          ...setup,
          allowList: new Set(["+27829999999"]),
        },
      ),
    ).toMatchObject({ ok: false, reason: "RECIPIENT_NOT_ALLOWED" });
  });
});

describe("notification catalogue", () => {
  it("defines a template, parameters and e-mail text for every type", () => {
    const facts = {
      practiceName: "Rosebank Family Practice",
      patientFirstName: "Thandi",
      when: "Tuesday 14 October 2026 at 09:30",
      practitionerName: "Dr Naidoo",
      locationName: "Main rooms",
      offerExpires: "10:15",
      offerId: "offer-1",
    };
    for (const type of NOTIFICATION_TYPES) {
      const entry = NOTIFICATION_CATALOGUE[type];
      expect(entry.template).toMatch(/^[a-z0-9_]+$/);
      const params = entry.params(facts);
      // Every {{n}} in the registered body has a parameter.
      const placeholders = [...entry.templateBody.matchAll(/\{\{(\d+)\}\}/g)];
      expect(params.length, type).toBe(placeholders.length);
      expect(entry.text(facts)).toContain("Thandi");
      expect(entry.subject(facts)).toContain("Rosebank Family Practice");
      // Administrative content only.
      expect(JSON.stringify(params)).not.toMatch(/diagnos|reason|symptom/i);
    }
    expect(
      NOTIFICATION_CATALOGUE.WAITLIST_OFFER.buttonPayloads!(facts),
    ).toEqual(["OFFER:offer-1:ACCEPT", "OFFER:offer-1:DECLINE"]);
  });
  it("formats times in the location's zone and masks addresses", () => {
    const instant = new Date("2026-10-14T07:30:00Z");
    expect(formatWhen(instant, "Africa/Johannesburg")).toBe(
      "Wednesday 14 October 2026 at 09:30",
    );
    expect(
      formatDeadline(
        instant,
        "Africa/Johannesburg",
        new Date("2026-10-14T06:00:00Z"),
      ),
    ).toBe("09:30");
    expect(maskAddress("+27821234567")).toBe("+27 •••• 4567");
    expect(maskAddress("thandi@example.com")).toBe("t•••@example.com");
  });
});
