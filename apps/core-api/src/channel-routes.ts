import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  conversationListQuerySchema,
  resolveConversationSchema,
  staffReplySchema,
} from "@access/contracts";
import {
  getConversation,
  ingestWhatsApp,
  listConversations,
  resolveConversation,
  staffReply,
} from "@access/access";
import {
  parseWhatsAppWebhook,
  verifySubscription,
  verifyWhatsAppSignature,
} from "@access/integrations";
import { log } from "@access/observability";
import type { PracticeAuthContext } from "./auth.js";
import {
  createPracticeKit,
  idParam,
  requestMeta,
  type PracticeRouteDeps,
} from "./route-kit.js";

export interface ChannelRouteDeps extends PracticeRouteDeps {
  /** The platform Meta app's credentials; null: the channel is off. */
  whatsapp: { appSecret: string; verifyToken: string } | null;
}

/**
 * The WhatsApp Cloud API webhook (adapter only: verify, parse, record,
 * acknowledge - conversations are answered by the worker's access layer)
 * and the staff side of patient conversations.
 */
export async function registerChannelRoutes(
  app: FastifyInstance,
  deps: ChannelRouteDeps,
): Promise<void> {
  const webhook = "/v1/channels/whatsapp/webhook";

  // Subscription handshake (Meta calls this once when the webhook is set).
  app.get(webhook, async (req, reply) => {
    if (!deps.whatsapp)
      return reply.code(404).send({ error: "CHANNEL_DISABLED" });
    const challenge = verifySubscription(
      req.query as Record<string, unknown>,
      deps.whatsapp.verifyToken,
    );
    if (!challenge)
      return reply.code(403).send({ error: "VERIFICATION_FAILED" });
    return reply.type("text/plain").send(challenge);
  });

  // Notifications: the signature covers the exact bytes, so this route
  // reads the raw body.
  await app.register(async (scoped) => {
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 1_048_576 },
      (_req, body, done) => done(null, body),
    );
    scoped.post(webhook, async (req, reply) => {
      if (!deps.whatsapp)
        return reply.code(404).send({ error: "CHANNEL_DISABLED" });
      const raw = req.body as Buffer;
      const signature = req.headers["x-hub-signature-256"];
      if (
        !Buffer.isBuffer(raw) ||
        !verifyWhatsAppSignature(
          deps.whatsapp.appSecret,
          raw,
          Array.isArray(signature) ? signature[0] : signature,
        )
      ) {
        deps.metrics.inc("whatsapp_webhook_rejected_total", {
          reason: "signature",
        });
        return reply.code(401).send({ error: "SIGNATURE_INVALID" });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        deps.metrics.inc("whatsapp_webhook_rejected_total", { reason: "json" });
        return reply.code(400).send({ error: "INVALID_JSON" });
      }
      const parsed = parseWhatsAppWebhook(body);
      const result = await ingestWhatsApp(deps.pool, parsed);
      deps.metrics.inc(
        "whatsapp_webhook_messages_total",
        { outcome: "received" },
        result.received,
      );
      deps.metrics.inc(
        "whatsapp_webhook_messages_total",
        { outcome: "duplicate" },
        result.duplicates,
      );
      deps.metrics.inc("whatsapp_webhook_statuses_total", {}, result.statuses);
      if (result.unrouted || parsed.ignored)
        log("warn", "whatsapp_webhook_partial", {
          request_id: String(req.id),
          count: result.unrouted + parsed.ignored,
        });
      // Always acknowledge a verified notification; Meta retries otherwise.
      return reply.code(200).send({ received: true });
    });
  });

  // -----------------------------------------------------------------------
  // Staff: the reception queue and conversation threads.
  // -----------------------------------------------------------------------

  const base = "/v1/practices/:practiceId/conversations";
  const { authorize, context, read, mutate } = createPracticeKit(deps);
  const staff = (req: FastifyRequest, auth: PracticeAuthContext) => ({
    tenantId: auth.tenantId,
    practiceId: auth.practiceId,
    actor: auth.actor,
    request: requestMeta(req),
  });

  app.get(base, async (req) => {
    const auth = await authorize(req, "conversation.manage");
    const q = conversationListQuerySchema.parse(req.query);
    const items = await read(req, auth, (c) =>
      listConversations(c, staff(req, auth), {
        limit: q.limit,
        ...(q.status ? { status: q.status } : {}),
        ...(q.before ? { before: q.before } : {}),
      }),
    );
    return {
      items,
      next_before:
        items.length === q.limit ? items[items.length - 1]!.updated_at : null,
    };
  });
  app.get(`${base}/:conversationId`, async (req) => {
    const auth = await authorize(req, "conversation.manage");
    const id = idParam(req, "conversationId");
    return read(req, auth, (c) => getConversation(c, staff(req, auth), id));
  });
  app.post(`${base}/:conversationId/messages`, async (req, reply) => {
    const auth = await authorize(req, "conversation.manage");
    const id = idParam(req, "conversationId");
    const body = staffReplySchema.parse(req.body);
    return mutate(
      req,
      reply,
      auth,
      "conversation.reply",
      { id, body },
      context(req, auth, "WHATSAPP"),
      async (c) => ({
        status: 202,
        body: await staffReply(c, staff(req, auth), id, body.body),
        resourceType: "conversation",
        resourceId: id,
      }),
    );
  });
  app.patch(`${base}/:conversationId`, async (req, reply) => {
    const auth = await authorize(req, "conversation.manage");
    const id = idParam(req, "conversationId");
    const body = resolveConversationSchema.parse(req.body);
    return mutate(
      req,
      reply,
      auth,
      "conversation.resolve",
      { id, body },
      context(req, auth, "WHATSAPP"),
      async (c) => ({
        status: 200,
        body: {
          conversation: await resolveConversation(c, staff(req, auth), id, {
            ...(body.status !== undefined ? { status: body.status } : {}),
            expectedVersion: body.expected_version,
            ...(body.patient_id !== undefined
              ? { patientId: body.patient_id }
              : {}),
          }),
        },
        resourceType: "conversation",
        resourceId: id,
      }),
    );
  });
}
