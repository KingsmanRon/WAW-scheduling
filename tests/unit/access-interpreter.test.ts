import { describe, expect, it } from "vitest";
import {
  interpret,
  isSafetyConcern,
  parseDateOfBirth,
  parseFullName,
} from "../../packages/access/src/index.js";
import {
  parseWhatsAppWebhook,
  verifySubscription,
} from "../../packages/integrations/src/index.js";

const say = (text: string) => interpret({ kind: "TEXT", text, replyId: null });

describe("deterministic interpretation of patient messages", () => {
  it("maps words, numbers and taps onto a closed set of intents", () => {
    expect(say("Hi")).toEqual({ kind: "GREETING" });
    expect(say("menu")).toEqual({ kind: "MENU" });
    expect(say("I'd like to book an appointment")).toEqual({ kind: "BOOK" });
    expect(say("Can I see the doctor on Friday?")).toEqual({ kind: "BOOK" });
    expect(say("please cancel my appointment")).toEqual({ kind: "CANCEL" });
    expect(say("I need to change my appointment time")).toEqual({
      kind: "RESCHEDULE",
    });
    expect(say("when is my next appointment")).toEqual({ kind: "LIST" });
    expect(say("can I talk to someone")).toEqual({ kind: "HANDOFF" });
    expect(say("YES")).toEqual({ kind: "YES" });
    expect(say("no thanks")).toEqual({ kind: "NO" });
    expect(say("2")).toEqual({ kind: "NUMBER", n: 2 });
    expect(say("STOP")).toEqual({ kind: "OPT_OUT" });
    expect(say("subscribe")).toEqual({ kind: "OPT_IN" });
    expect(say("Thandi Mokoena")).toEqual({
      kind: "TEXT",
      text: "Thandi Mokoena",
    });
    expect(
      interpret({
        kind: "LIST_REPLY",
        text: "Tue 14 Oct, 09:30",
        replyId: "S:3",
      }),
    ).toEqual({ kind: "CHOICE", id: "S:3" });
    expect(
      interpret({ kind: "UNSUPPORTED", text: null, replyId: null }),
    ).toEqual({
      kind: "UNSUPPORTED",
    });
  });
  it("stops the automated flow on anything that may be an emergency", () => {
    for (const message of [
      "I have chest pain",
      "my child can't breathe",
      "Difficulty breathing since this morning",
      "he is unconscious",
      "there is heavy bleeding",
      "I want to kill myself",
      "EMERGENCY",
      "she had a seizure",
      "severe pain in my stomach",
    ]) {
      expect(isSafetyConcern(message), message).toBe(true);
      expect(say(message)).toEqual({ kind: "SAFETY" });
    }
    // Ordinary booking requests are not escalated.
    for (const message of [
      "I'd like to book a check-up",
      "back pain follow up please",
      "can I book for my breathing test",
    ])
      expect(isSafetyConcern(message), message).toBe(false);
  });
  it("parses names and dates of birth strictly", () => {
    const today = new Date("2026-09-28T00:00:00Z");
    expect(parseDateOfBirth("21/03/1990", today)).toBe("1990-03-21");
    expect(parseDateOfBirth("1-4-2001", today)).toBe("2001-04-01");
    expect(parseDateOfBirth("1985-12-31", today)).toBe("1985-12-31");
    for (const bad of [
      "31/02/1990",
      "12/13/1990",
      "01/01/1850",
      "01/01/2030",
      "yesterday",
    ])
      expect(parseDateOfBirth(bad, today), bad).toBeNull();
    expect(parseFullName("Thandi  Mokoena")).toEqual({
      givenName: "Thandi",
      familyName: "Mokoena",
    });
    expect(parseFullName("Mary Jane van Wyk")).toEqual({
      givenName: "Mary Jane van",
      familyName: "Wyk",
    });
    expect(parseFullName("Thandi")).toBeNull();
    expect(parseFullName("Thandi 123 Mokoena")).toBeNull();
  });
});

describe("WhatsApp webhook normalisation", () => {
  const envelope = (value: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "27110000000",
                phone_number_id: "1234567890",
              },
              ...value,
            },
          },
        ],
      },
    ],
  });
  it("normalises text, interactive and template-button messages", () => {
    const parsed = parseWhatsAppWebhook(
      envelope({
        contacts: [{ profile: { name: "Thandi" }, wa_id: "27821234567" }],
        messages: [
          {
            from: "27821234567",
            id: "wamid.A",
            timestamp: "1790000000",
            type: "text",
            text: { body: "Hi there" },
          },
          {
            from: "27821234567",
            id: "wamid.B",
            timestamp: "1790000001",
            type: "interactive",
            interactive: {
              type: "list_reply",
              list_reply: { id: "S:2", title: "Tue 14 Oct, 09:30" },
            },
            context: { id: "wamid.OUT" },
          },
          {
            from: "27821234567",
            id: "wamid.C",
            timestamp: "1790000002",
            type: "button",
            button: { payload: "OFFER:x:ACCEPT", text: "Book it" },
          },
          {
            from: "27821234567",
            id: "wamid.D",
            timestamp: "1790000003",
            type: "image",
            image: { id: "media" },
          },
          {
            from: "27821234567",
            id: "wamid.E",
            timestamp: "1",
            type: "reaction",
          },
        ],
      }),
    );
    expect(parsed.messages.map((m) => [m.kind, m.text, m.replyId])).toEqual([
      ["TEXT", "Hi there", null],
      ["LIST_REPLY", "Tue 14 Oct, 09:30", "S:2"],
      ["BUTTON_REPLY", "Book it", "OFFER:x:ACCEPT"],
      ["UNSUPPORTED", null, null],
    ]);
    expect(parsed.messages[0]).toMatchObject({
      from: "+27821234567",
      phoneNumberId: "1234567890",
      providerMessageId: "wamid.A",
    });
    expect(parsed.messages[1]!.contextMessageId).toBe("wamid.OUT");
    expect(parsed.ignored).toBe(1);
  });
  it("normalises delivery statuses with callback data and errors", () => {
    const parsed = parseWhatsAppWebhook(
      envelope({
        statuses: [
          {
            id: "wamid.X",
            status: "delivered",
            timestamp: "1790000010",
            recipient_id: "27821234567",
            biz_opaque_callback_data: "delivery:abc",
          },
          {
            id: "wamid.Y",
            status: "failed",
            timestamp: "1790000011",
            errors: [{ code: 131026, title: "Message undeliverable" }],
          },
          { id: "wamid.Z", status: "deleted", timestamp: "1" },
        ],
      }),
    );
    expect(parsed.statuses).toEqual([
      expect.objectContaining({
        providerMessageId: "wamid.X",
        status: "delivered",
        callbackData: "delivery:abc",
        errorCode: null,
      }),
      expect.objectContaining({
        status: "failed",
        errorCode: 131026,
        errorTitle: "Message undeliverable",
      }),
    ]);
    expect(parsed.ignored).toBe(1);
  });
  it("ignores anything that is not a WhatsApp messages notification", () => {
    expect(parseWhatsAppWebhook({ object: "page", entry: [] }).ignored).toBe(1);
    expect(parseWhatsAppWebhook("garbage").messages).toEqual([]);
    expect(
      parseWhatsAppWebhook({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "account_update", value: {} }] }],
      }).ignored,
    ).toBe(1);
  });
  it("answers the subscription challenge only for the configured token", () => {
    const token = "verify-token-for-tests-123";
    expect(
      verifySubscription(
        {
          "hub.mode": "subscribe",
          "hub.verify_token": token,
          "hub.challenge": "1158201444",
        },
        token,
      ),
    ).toBe("1158201444");
    expect(
      verifySubscription(
        {
          "hub.mode": "subscribe",
          "hub.verify_token": "wrong",
          "hub.challenge": "1",
        },
        token,
      ),
    ).toBeNull();
    expect(
      verifySubscription(
        {
          "hub.mode": "subscribe",
          "hub.verify_token": token,
          "hub.challenge": "<script>",
        },
        token,
      ),
    ).toBeNull();
  });
});
