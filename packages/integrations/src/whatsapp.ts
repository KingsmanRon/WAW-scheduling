import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { NOTIFICATION_TYPES } from "@access/contracts";
import { DeliveryFailure } from "./errors.js";
import { postJson, retryAfterSeconds } from "./http.js";
import type { TargetPolicy } from "./net.js";

/**
 * WhatsApp Business Platform (Meta Cloud API) adapter: outbound messages
 * through the Graph API and verification of inbound webhooks. It carries no
 * business logic; the access layer and the notification dispatcher decide
 * what to send.
 *
 * Credentials (never stored in the database):
 * - access token: a System User token with whatsapp_business_messaging,
 *   held in the environment variable named by the connection's secret_ref;
 * - app secret: WHATSAPP_APP_SECRET, verifies X-Hub-Signature-256;
 * - verify token: WHATSAPP_VERIFY_TOKEN, answers the subscription challenge.
 */
export const WHATSAPP_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const templateRef = z
  .object({
    name: z.string().regex(/^[a-z0-9_]{1,120}$/),
    language: z.string().regex(WHATSAPP_LANGUAGE).optional(),
  })
  .strict();
export const whatsAppConnectionConfigSchema = z
  .object({
    phone_number_id: z.string().regex(/^[0-9]{5,30}$/),
    waba_id: z
      .string()
      .regex(/^[0-9]{5,30}$/)
      .optional(),
    display_phone_number: z
      .string()
      .regex(/^\+[1-9][0-9]{6,14}$/)
      .optional(),
    default_language: z.string().regex(WHATSAPP_LANGUAGE).default("en"),
    /** Approved template names per notification type (defaults apply). */
    templates: z
      .partialRecord(z.enum(NOTIFICATION_TYPES), templateRef)
      .default({}),
  })
  .strict();
export type WhatsAppConnectionConfig = z.infer<
  typeof whatsAppConnectionConfigSchema
>;

export interface WhatsAppClientOptions {
  /** https://graph.facebook.com in production. */
  baseUrl: string;
  /** Graph API version, e.g. v21.0. */
  apiVersion: string;
  accessToken: string;
  phoneNumberId: string;
  timeoutMs: number;
  policy: TargetPolicy;
}
export interface SentMessage {
  messageId: string;
  waId: string | null;
}
export interface ReplyButton {
  id: string;
  title: string;
}
export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

/**
 * Template body parameters may not contain new lines, tabs or runs of more
 * than four spaces, and must not be empty.
 */
export function templateParam(value: string): string {
  const v = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 200);
  return v || "-";
}
const clip = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

export class WhatsAppCloudClient {
  constructor(private readonly options: WhatsAppClientOptions) {}

  /** A pre-approved template: the only kind allowed outside the 24h window. */
  sendTemplate(input: {
    to: string;
    name: string;
    language: string;
    bodyParams: string[];
    /**
     * Payloads for the template's quick-reply buttons, in button order; the
     * payload comes back with the patient's tap.
     */
    buttonPayloads?: string[];
    /** Echoed back in status webhooks (correlates retries and callbacks). */
    callbackData?: string;
  }): Promise<SentMessage> {
    const components: Record<string, unknown>[] = [];
    if (input.bodyParams.length)
      components.push({
        type: "body",
        parameters: input.bodyParams.map((text) => ({
          type: "text",
          text: templateParam(text),
        })),
      });
    (input.buttonPayloads ?? []).forEach((payload, index) =>
      components.push({
        type: "button",
        sub_type: "quick_reply",
        index: String(index),
        parameters: [{ type: "payload", payload: payload.slice(0, 128) }],
      }),
    );
    return this.send(input.to, input.callbackData, {
      type: "template",
      template: {
        name: input.name,
        language: { code: input.language },
        components,
      },
    });
  }

  /** Free-form text: only within 24 hours of the patient's last message. */
  sendText(input: {
    to: string;
    body: string;
    callbackData?: string;
  }): Promise<SentMessage> {
    return this.send(input.to, input.callbackData, {
      type: "text",
      text: { preview_url: false, body: clip(input.body, 4096) },
    });
  }

  /** Up to three reply buttons (title 20 characters). */
  sendButtons(input: {
    to: string;
    body: string;
    buttons: ReplyButton[];
    callbackData?: string;
  }): Promise<SentMessage> {
    if (input.buttons.length < 1 || input.buttons.length > 3)
      throw new DeliveryFailure("PERMANENT", "TOO_MANY_BUTTONS");
    return this.send(input.to, input.callbackData, {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: clip(input.body, 1024) },
        action: {
          buttons: input.buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id.slice(0, 256), title: clip(b.title, 20) },
          })),
        },
      },
    });
  }

  /** A list of up to ten rows (title 24, description 72 characters). */
  sendList(input: {
    to: string;
    body: string;
    buttonLabel: string;
    sectionTitle: string;
    rows: ListRow[];
    callbackData?: string;
  }): Promise<SentMessage> {
    if (input.rows.length < 1 || input.rows.length > 10)
      throw new DeliveryFailure("PERMANENT", "TOO_MANY_ROWS");
    return this.send(input.to, input.callbackData, {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: clip(input.body, 4096) },
        action: {
          button: clip(input.buttonLabel, 20),
          sections: [
            {
              title: clip(input.sectionTitle, 24),
              rows: input.rows.map((r) => ({
                id: r.id.slice(0, 200),
                title: clip(r.title, 24),
                ...(r.description
                  ? { description: clip(r.description, 72) }
                  : {}),
              })),
            },
          ],
        },
      },
    });
  }

  /** Mark an inbound message as read (blue ticks). Best effort. */
  async markRead(messageId: string): Promise<void> {
    await this.post({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
  }

  private async send(
    to: string,
    callbackData: string | undefined,
    message: Record<string, unknown>,
  ): Promise<SentMessage> {
    if (!/^\+?[1-9][0-9]{6,14}$/.test(to))
      throw new DeliveryFailure("PERMANENT", "RECIPIENT_INVALID");
    const result = await this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/^\+/, ""),
      ...message,
      ...(callbackData
        ? { biz_opaque_callback_data: callbackData.slice(0, 512) }
        : {}),
    });
    const parsed = sendResponseSchema.safeParse(result);
    if (!parsed.success)
      // Accepted (2xx) but unreadable: it may well have been sent.
      throw new DeliveryFailure("AMBIGUOUS", "UNEXPECTED_PROVIDER_RESPONSE");
    return {
      messageId: parsed.data.messages[0]!.id,
      waId: parsed.data.contacts?.[0]?.wa_id ?? null,
    };
  }

  private async post(payload: Record<string, unknown>): Promise<unknown> {
    const { baseUrl, apiVersion, phoneNumberId } = this.options;
    const url = new URL(
      `${baseUrl.replace(/\/+$/, "")}/${apiVersion}/${phoneNumberId}/messages`,
    );
    const response = await postJson(url, JSON.stringify(payload), {
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      timeoutMs: this.options.timeoutMs,
      policy: this.options.policy,
    });
    let body: unknown = null;
    try {
      body = response.body ? JSON.parse(response.body) : null;
    } catch {
      body = null;
    }
    if (response.status >= 200 && response.status < 300) {
      if (body === null)
        throw new DeliveryFailure("AMBIGUOUS", "UNEXPECTED_PROVIDER_RESPONSE");
      return body;
    }
    throw classifyWhatsAppError(
      response.status,
      body,
      retryAfterSeconds(response.headers["retry-after"]),
    );
  }
}

const sendResponseSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1).max(200) })).min(1),
  contacts: z.array(z.object({ wa_id: z.string().optional() })).optional(),
});

/** Throttling: retry later. */
const RATE_LIMITED = new Set([4, 80007, 130429, 131048, 131056, 133016]);
/** Meta-side trouble: retry. */
const PROVIDER_TRANSIENT = new Set([1, 2, 131000, 131016, 131057]);
/** Credentials, permissions, account or template set-up: operator action. */
const CONFIGURATION = new Set([
  0, 3, 10, 190, 368, 131005, 131031, 131042, 131045, 132001, 132015, 132016,
  133000, 133004, 133005, 133006, 133008, 133009, 133010,
]);

/** Map a Graph API error response onto the retry taxonomy. */
export function classifyWhatsAppError(
  status: number,
  body: unknown,
  retryAfter: number | null,
): DeliveryFailure {
  const error = (body as { error?: { code?: unknown; message?: unknown } })
    ?.error;
  const code = typeof error?.code === "number" ? error.code : null;
  const detail = typeof error?.message === "string" ? error.message : null;
  const label = code === null ? `HTTP_${status}` : `WHATSAPP_${code}`;
  if (code !== null && RATE_LIMITED.has(code))
    return new DeliveryFailure("TRANSIENT", label, detail, retryAfter, status);
  if (code !== null && PROVIDER_TRANSIENT.has(code))
    return new DeliveryFailure("TRANSIENT", label, detail, retryAfter, status);
  // 200-299: API permission errors.
  if (
    code !== null &&
    (CONFIGURATION.has(code) || (code >= 200 && code <= 299))
  )
    return new DeliveryFailure(
      "CONFIGURATION",
      label,
      detail,
      retryAfter,
      status,
    );
  if (status === 429 || status >= 500)
    return new DeliveryFailure("TRANSIENT", label, detail, retryAfter, status);
  if (status === 401 || status === 403)
    return new DeliveryFailure(
      "CONFIGURATION",
      label,
      detail,
      retryAfter,
      status,
    );
  return new DeliveryFailure("PERMANENT", label, detail, null, status);
}

/**
 * Verify X-Hub-Signature-256 ("sha256=<hex>") over the exact raw request
 * body with the app secret, in constant time.
 */
export function verifyWhatsAppSignature(
  appSecret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "");
  if (!match || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
