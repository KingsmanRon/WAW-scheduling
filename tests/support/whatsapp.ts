import { createHmac, randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { IntentClassifier } from "@access/access";
import { provisionWhatsApp } from "../../packages/access/src/index.js";
import type { GraphApiFixture } from "./graph-api-fixture.js";
import { ownerPool, type TestApi } from "./harness.js";
import { testPlatform, type TestPlatform } from "./platform.js";
import { newPractice, type TestPractice } from "./scheduling.js";

/** The Meta app credentials the test API is configured with. */
export const APP_SECRET = "meta-app-secret-for-tests-0011223344";
export const VERIFY_TOKEN = "verify-token-for-tests-12345";
export const WEBHOOK = "/v1/channels/whatsapp/webhook";

/** A message the patient's phone received, as the Graph API was asked. */
export interface Reply {
  type: string;
  text: string;
  options: string[];
  titles: string[];
  /** Template messages: name and quick-reply payloads. */
  template?: { name: string; payloads: string[] };
}
interface SentMessage {
  type: string;
  text?: { body: string };
  interactive?: {
    type: string;
    body: { text: string };
    action: {
      buttons?: { reply: { id: string; title: string } }[];
      sections?: { rows: { id: string; title: string }[] }[];
    };
  };
  template?: {
    name: string;
    components?: {
      type: string;
      sub_type?: string;
      parameters?: { type: string; payload?: string }[];
    }[];
  };
}

/**
 * Patients on WhatsApp for integration tests: signed Meta notifications go
 * through the real webhook, the worker's platform jobs answer, and replies
 * are read back from the Graph API fixture.
 */
export function whatsAppHarness(api: TestApi, graph: GraphApiFixture) {
  const sign = (raw: string) =>
    `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
  const post = (raw: string, signature: string | null = sign(raw)) =>
    api.app.inject({
      method: "POST",
      url: WEBHOOK,
      headers: {
        "content-type": "application/json",
        ...(signature ? { "x-hub-signature-256": signature } : {}),
      },
      payload: raw,
    });
  const envelope = (phoneNumberId: string, value: Record<string, unknown>) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-TEST",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "27110000000",
                  phone_number_id: phoneNumberId,
                },
                ...value,
              },
            },
          ],
        },
      ],
    });

  /** A practice on WhatsApp, as the operator provisions it. */
  async function channelPractice(
    options: {
      classifier?: IntentClassifier;
      practice?: TestPractice;
      allowList?: string[];
    } = {},
  ) {
    const p = options.practice ?? (await newPractice());
    const phoneNumberId = String(
      1_000_000_000 + Math.floor(Math.random() * 8_999_999_999),
    );
    await provisionWhatsApp(ownerPool(), {
      tenantId: p.tenantId,
      practiceId: p.practiceId,
      name: "Practice WhatsApp",
      secretRef: "WHATSAPP_TEST_TOKEN",
      active: true,
      operator: "operator:test",
      config: {
        phone_number_id: phoneNumberId,
        default_language: "en",
        templates: {},
      },
    });
    const platform = testPlatform(p.tenantId, {
      graphUrl: graph.url,
      ...(options.allowList ? { allowList: options.allowList } : {}),
      ...(options.classifier ? { classifier: options.classifier } : {}),
    });
    return { p, phoneNumberId, platform };
  }

  function replyOf(body: SentMessage): Reply {
    if (body.type === "text" && body.text)
      return { type: "text", text: body.text.body, options: [], titles: [] };
    if (body.type === "interactive" && body.interactive) {
      const i = body.interactive;
      const rows =
        i.type === "button"
          ? (i.action.buttons ?? []).map((x) => x.reply)
          : (i.action.sections?.[0]?.rows ?? []);
      return {
        type: i.type,
        text: i.body.text,
        options: rows.map((r) => r.id),
        titles: rows.map((r) => r.title),
      };
    }
    if (body.type === "template" && body.template)
      return {
        type: "template",
        text: "",
        options: [],
        titles: [],
        template: {
          name: body.template.name,
          payloads: (body.template.components ?? [])
            .filter((c) => c.type === "button")
            .map((c) => c.parameters?.[0]?.payload ?? ""),
        },
      };
    return { type: body.type, text: "", options: [], titles: [] };
  }

  /** A patient's phone talking to the practice's WhatsApp number. */
  class Phone {
    constructor(
      readonly number: string,
      readonly phoneNumberId: string,
      readonly platform: TestPlatform,
    ) {}
    async send(
      content:
        | { text: string }
        | { tap: string; title?: string }
        | { button: string; title?: string },
      id = `wamid.in.${randomUUID().replace(/-/g, "")}`,
    ) {
      const message =
        "text" in content
          ? { type: "text", text: { body: content.text } }
          : "tap" in content
            ? {
                type: "interactive",
                interactive: {
                  type: "button_reply",
                  button_reply: {
                    id: content.tap,
                    title: content.title ?? "option",
                  },
                },
              }
            : {
                // A template quick-reply button.
                type: "button",
                button: {
                  payload: content.button,
                  text: content.title ?? "option",
                },
              };
      const response = await post(
        envelope(this.phoneNumberId, {
          contacts: [
            { profile: { name: "Patient" }, wa_id: this.number.slice(1) },
          ],
          messages: [
            {
              from: this.number.slice(1),
              id,
              timestamp: String(Math.floor(Date.now() / 1000)),
              ...message,
            },
          ],
        }),
      );
      expect(response.statusCode).toBe(200);
      await this.platform.drain();
      return id;
    }
    replies(): Reply[] {
      return graph
        .messages()
        .filter((m) => m.body.to === this.number.slice(1))
        .map((m) => replyOf(m.body as unknown as SentMessage));
    }
    last(): Reply {
      return this.replies().at(-1)!;
    }
  }

  return { sign, post, envelope, channelPractice, Phone };
}

export const mobileOf = async (patientId: string) =>
  (
    await ownerPool().query(
      "SELECT value FROM directory.patient_contacts WHERE patient_id=$1 AND kind='MOBILE'",
      [patientId],
    )
  ).rows[0].value as string;
export const conversationOf = async (p: TestPractice, number: string) =>
  (
    await ownerPool().query(
      `SELECT id, status, needs_staff_reason, state, state_data, patient_id, version
         FROM messaging.channel_conversations WHERE tenant_id=$1 AND participant_address=$2`,
      [p.tenantId, number],
    )
  ).rows[0];
export const appointmentsOf = async (p: TestPractice, patientId: string) =>
  (
    await ownerPool().query(
      `SELECT id, status, starts_at, source_channel, booked_by_actor_type, rescheduled_from_id, cancellation_reason_code,
              waitlist_entry_id
         FROM scheduling.appointments WHERE tenant_id=$1 AND patient_id=$2 ORDER BY created_at`,
      [p.tenantId, patientId],
    )
  ).rows;
