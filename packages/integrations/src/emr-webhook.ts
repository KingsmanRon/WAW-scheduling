import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { EMR_EVENT_TYPES, type EmrEventType } from "@access/contracts";
import { DeliveryFailure } from "./errors.js";
import { postJson, retryAfterSeconds } from "./http.js";
import { assertOutboundUrl, type TargetPolicy } from "./net.js";

/**
 * EMR / practice-system integration boundary: appointment facts pushed as
 * signed webhooks. The platform works without any EMR; a practice adds one
 * by configuring a connection. The contract for receivers (docs):
 *
 *   POST <url>, JSON body {id, type, occurred_at, practice_id, data}
 *   X-Access-Event-Id      event id (also Idempotency-Key): de-duplicate on it
 *   X-Access-Event-Type    e.g. appointment.confirmed
 *   X-Access-Timestamp     unix seconds
 *   X-Access-Signature     v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
 *
 * Any 2xx acknowledges. Retries reuse the same id, so they are safe.
 */
export { EMR_EVENT_TYPES, type EmrEventType };

export const emrWebhookConfigSchema = z
  .object({
    url: z.string().min(8).max(500),
    event_types: z
      .array(z.enum(EMR_EVENT_TYPES))
      .min(1)
      .max(EMR_EVENT_TYPES.length)
      .default([...EMR_EVENT_TYPES]),
    /**
     * Include the patient's EXTERNAL identifier issued by this system (the
     * EMR's own patient number), so the receiver can match its record.
     */
    patient_identifier_issuer: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,80}$/)
      .optional(),
  })
  .strict();
export type EmrWebhookConfig = z.infer<typeof emrWebhookConfigSchema>;

export function signWebhook(
  secret: string,
  timestamp: number,
  body: string,
): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** For receivers (and tests): constant-time check with a replay window. */
export function verifyWebhookSignature(input: {
  secret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  now?: number;
  toleranceSeconds?: number;
}): boolean {
  const ts = Number(input.timestamp);
  if (!Number.isInteger(ts)) return false;
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - ts) > (input.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signWebhook(input.secret, ts, input.body));
  const given = Buffer.from(input.signature ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface WebhookDelivered {
  status: number;
  /** The receiver's request id, if it returned one. */
  reference: string | null;
}

export async function deliverWebhook(input: {
  url: string;
  secret: string;
  eventId: string;
  eventType: string;
  body: string;
  timeoutMs: number;
  policy: TargetPolicy;
  now?: number;
}): Promise<WebhookDelivered> {
  const url = assertOutboundUrl(input.url, input.policy);
  const timestamp = Math.floor((input.now ?? Date.now()) / 1000);
  let response;
  try {
    response = await postJson(url, input.body, {
      headers: {
        "content-type": "application/json",
        "user-agent": "access-scheduling-webhooks/1",
        "x-access-event-id": input.eventId,
        "x-access-event-type": input.eventType,
        "x-access-timestamp": String(timestamp),
        "x-access-signature": signWebhook(input.secret, timestamp, input.body),
        "idempotency-key": input.eventId,
      },
      timeoutMs: input.timeoutMs,
      policy: input.policy,
      maxResponseBytes: 4096,
    });
  } catch (e) {
    // Receivers de-duplicate on the event id: a possibly-sent request is
    // safe to repeat.
    if (e instanceof DeliveryFailure && e.kind === "AMBIGUOUS")
      throw new DeliveryFailure("TRANSIENT", e.code, e.detail);
    throw e;
  }
  const s = response.status;
  if (s >= 200 && s < 300) {
    const ref = response.headers["x-request-id"];
    const reference = (Array.isArray(ref) ? ref[0] : ref) ?? null;
    return {
      status: s,
      reference:
        reference && /^[\w.:-]{1,200}$/.test(reference) ? reference : null,
    };
  }
  const retryAfter = retryAfterSeconds(response.headers["retry-after"]);
  if (s === 408 || s === 425 || s === 429 || s >= 500)
    throw new DeliveryFailure("TRANSIENT", `HTTP_${s}`, null, retryAfter, s);
  if (s === 401 || s === 403 || s === 404 || s === 410)
    throw new DeliveryFailure(
      "CONFIGURATION",
      `HTTP_${s}`,
      null,
      retryAfter,
      s,
    );
  throw new DeliveryFailure("PERMANENT", `HTTP_${s}`, null, null, s);
}
