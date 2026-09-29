import { z } from "zod";

/**
 * Normalisation of WhatsApp Cloud API webhook notifications
 * (object=whatsapp_business_account, field=messages). Meta adds fields over
 * time, so unknown fields are tolerated; anything we do not understand is
 * counted and ignored, never guessed at. The payload's own claims about the
 * business are only used to route (phone_number_id); tenant and practice
 * come from the operator-provisioned route.
 */
export type InboundKind =
  "TEXT" | "BUTTON_REPLY" | "LIST_REPLY" | "UNSUPPORTED";
export interface InboundMessage {
  phoneNumberId: string;
  /** The patient's number, E.164 (from wa_id / from). */
  from: string;
  providerMessageId: string;
  timestamp: Date;
  kind: InboundKind;
  /** Text body, or the tapped option's title. */
  text: string | null;
  /** The id of the tapped interactive option or template button payload. */
  replyId: string | null;
  /** The message this one replies to, if any. */
  contextMessageId: string | null;
  /** The provider's type for unsupported messages (image, audio, ...). */
  providerType: string;
}
export type StatusKind = "sent" | "delivered" | "read" | "failed";
export interface StatusUpdate {
  phoneNumberId: string;
  providerMessageId: string;
  status: StatusKind;
  timestamp: Date;
  /** biz_opaque_callback_data we attached when sending. */
  callbackData: string | null;
  errorCode: number | null;
  errorTitle: string | null;
}
export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
  /** Changes or items skipped as not understood. */
  ignored: number;
}

const text = z.string().max(4096);
const messageSchema = z.looseObject({
  from: z.string().regex(/^[1-9][0-9]{6,14}$/),
  id: z.string().min(1).max(200),
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.string().max(40),
  text: z.looseObject({ body: text }).optional(),
  interactive: z
    .looseObject({
      type: z.string(),
      button_reply: z
        .looseObject({ id: z.string().max(256), title: z.string().max(100) })
        .optional(),
      list_reply: z
        .looseObject({ id: z.string().max(256), title: z.string().max(100) })
        .optional(),
    })
    .optional(),
  button: z
    .looseObject({ payload: z.string().max(256), text: z.string().max(100) })
    .optional(),
  context: z.looseObject({ id: z.string().max(200).optional() }).optional(),
});
const statusSchema = z.looseObject({
  id: z.string().min(1).max(200),
  status: z.enum(["sent", "delivered", "read", "failed"]),
  timestamp: z.string().regex(/^\d{1,12}$/),
  biz_opaque_callback_data: z.string().max(512).optional(),
  errors: z
    .array(
      z.looseObject({
        code: z.number().int().optional(),
        title: z.string().max(300).optional(),
      }),
    )
    .optional(),
});
const valueSchema = z.looseObject({
  messaging_product: z.literal("whatsapp"),
  metadata: z.looseObject({
    phone_number_id: z.string().regex(/^[0-9]{5,30}$/),
  }),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});
const envelopeSchema = z.looseObject({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.looseObject({
      changes: z.array(
        z.looseObject({ field: z.string(), value: z.unknown() }),
      ),
    }),
  ),
});

const at = (unix: string) => new Date(Number(unix) * 1000);

export function parseWhatsAppWebhook(body: unknown): ParsedWebhook {
  const envelope = envelopeSchema.safeParse(body);
  const out: ParsedWebhook = { messages: [], statuses: [], ignored: 0 };
  if (!envelope.success) {
    out.ignored++;
    return out;
  }
  for (const entry of envelope.data.entry)
    for (const change of entry.changes) {
      const value = valueSchema.safeParse(change.value);
      if (change.field !== "messages" || !value.success) {
        out.ignored++;
        continue;
      }
      const phoneNumberId = value.data.metadata.phone_number_id;
      for (const raw of value.data.messages ?? []) {
        const m = messageSchema.safeParse(raw);
        if (!m.success) {
          out.ignored++;
          continue;
        }
        const base = {
          phoneNumberId,
          from: `+${m.data.from}`,
          providerMessageId: m.data.id,
          timestamp: at(m.data.timestamp),
          contextMessageId: m.data.context?.id ?? null,
          providerType: m.data.type,
        };
        if (m.data.type === "text" && m.data.text)
          out.messages.push({
            ...base,
            kind: "TEXT",
            text: m.data.text.body,
            replyId: null,
          });
        else if (
          m.data.type === "interactive" &&
          m.data.interactive?.button_reply
        )
          out.messages.push({
            ...base,
            kind: "BUTTON_REPLY",
            text: m.data.interactive.button_reply.title,
            replyId: m.data.interactive.button_reply.id,
          });
        else if (
          m.data.type === "interactive" &&
          m.data.interactive?.list_reply
        )
          out.messages.push({
            ...base,
            kind: "LIST_REPLY",
            text: m.data.interactive.list_reply.title,
            replyId: m.data.interactive.list_reply.id,
          });
        else if (m.data.type === "button" && m.data.button)
          // A tap on a template's quick-reply button.
          out.messages.push({
            ...base,
            kind: "BUTTON_REPLY",
            text: m.data.button.text,
            replyId: m.data.button.payload,
          });
        else if (m.data.type === "reaction" || m.data.type === "system")
          out.ignored++;
        else
          out.messages.push({
            ...base,
            kind: "UNSUPPORTED",
            text: null,
            replyId: null,
          });
      }
      for (const raw of value.data.statuses ?? []) {
        const s = statusSchema.safeParse(raw);
        if (!s.success) {
          out.ignored++;
          continue;
        }
        out.statuses.push({
          phoneNumberId,
          providerMessageId: s.data.id,
          status: s.data.status,
          timestamp: at(s.data.timestamp),
          callbackData: s.data.biz_opaque_callback_data ?? null,
          errorCode: s.data.errors?.[0]?.code ?? null,
          errorTitle: s.data.errors?.[0]?.title ?? null,
        });
      }
    }
  return out;
}

/** GET subscription handshake: echo the challenge only for our token. */
export function verifySubscription(
  query: Record<string, unknown>,
  verifyToken: string,
): string | null {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (
    mode === "subscribe" &&
    typeof token === "string" &&
    verifyToken.length > 0 &&
    token === verifyToken &&
    typeof challenge === "string" &&
    /^[\w-]{1,200}$/.test(challenge)
  )
    return challenge;
  return null;
}
