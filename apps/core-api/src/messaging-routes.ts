import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  deliveryListQuerySchema,
  emrConnectionPatchSchema,
  emrConnectionSchema,
  integrationEventListQuerySchema,
  notificationPreferencesSchema,
} from "@access/contracts";
import {
  createEmrConnection,
  listConnections,
  listIntegrationEvents,
  updateEmrConnection,
  type TargetPolicy,
} from "@access/integrations";
import {
  getNotificationPreferences,
  listDeliveries,
  setNotificationPreferences,
} from "@access/notifications";
import type { PracticeAuthContext } from "./auth.js";
import {
  createPracticeKit,
  idParam,
  requestMeta,
  type PracticeRouteDeps,
} from "./route-kit.js";

export interface MessagingRouteDeps extends PracticeRouteDeps {
  /** Webhook targets: public HTTPS only, except in the local profile. */
  integrationPolicy: TargetPolicy;
}

/**
 * Patient notification consent, delivery visibility (what was sent, skipped
 * or failed, and why) and the practice's EMR webhook connections.
 */
export async function registerMessagingRoutes(
  app: FastifyInstance,
  deps: MessagingRouteDeps,
): Promise<void> {
  const base = "/v1/practices/:practiceId";
  const { authorize, context, read, mutate } = createPracticeKit(deps);
  const admin = (req: FastifyRequest, auth: PracticeAuthContext) => ({
    tenantId: auth.tenantId,
    practiceId: auth.practiceId,
    actor: auth.actor,
    request: requestMeta(req),
  });

  app.get(
    `${base}/patients/:patientId/notification-preferences`,
    async (req) => {
      const auth = await authorize(req, "notification.read");
      const patientId = idParam(req, "patientId");
      return {
        preferences: await read(req, auth, (c) =>
          getNotificationPreferences(c, admin(req, auth), patientId),
        ),
      };
    },
  );
  app.put(
    `${base}/patients/:patientId/notification-preferences`,
    async (req, reply) => {
      const auth = await authorize(req, "notification.preferences.manage");
      const patientId = idParam(req, "patientId");
      const body = notificationPreferencesSchema.parse(req.body);
      return mutate(
        req,
        reply,
        auth,
        "notification_preferences.set",
        { patientId, body },
        context(req, auth),
        async (c) => ({
          status: 200,
          body: {
            preferences: await setNotificationPreferences(
              c,
              admin(req, auth),
              patientId,
              {
                whatsappOptIn: body.whatsapp_opt_in,
                emailOptIn: body.email_opt_in,
                remindersEnabled: body.reminders_enabled,
                preferredChannel: body.preferred_channel,
                expectedVersion: body.expected_version,
              },
            ),
          },
          resourceType: "patient",
          resourceId: patientId,
        }),
      );
    },
  );

  app.get(`${base}/notifications`, async (req) => {
    const auth = await authorize(req, "notification.read");
    const q = deliveryListQuerySchema.parse(req.query);
    const items = await read(req, auth, (c) =>
      listDeliveries(c, admin(req, auth), {
        limit: q.limit,
        ...(q.status ? { statuses: q.status } : {}),
        ...(q.type ? { type: q.type } : {}),
        ...(q.patient_id ? { patientId: q.patient_id } : {}),
        ...(q.appointment_id ? { appointmentId: q.appointment_id } : {}),
        ...(q.before ? { before: q.before } : {}),
      }),
    );
    return {
      items,
      next_before:
        items.length === q.limit ? items[items.length - 1]!.created_at : null,
    };
  });
  app.get(`${base}/appointments/:appointmentId/notifications`, async (req) => {
    const auth = await authorize(req, "notification.read");
    const appointmentId = idParam(req, "appointmentId");
    return {
      items: await read(req, auth, (c) =>
        listDeliveries(c, admin(req, auth), { appointmentId, limit: 200 }),
      ),
    };
  });

  app.get(`${base}/integrations/connections`, async (req) => {
    const auth = await authorize(req, "integration.manage");
    return {
      items: await read(req, auth, (c) => listConnections(c, admin(req, auth))),
    };
  });
  app.post(`${base}/integrations/connections`, async (req, reply) => {
    const auth = await authorize(req, "integration.manage");
    const body = emrConnectionSchema.parse(req.body);
    return mutate(
      req,
      reply,
      auth,
      "integration_connection.create",
      body,
      context(req, auth),
      async (c) => {
        const connection = await createEmrConnection(
          c,
          admin(req, auth),
          {
            name: body.name,
            url: body.url,
            secretRef: body.secret_ref,
            ...(body.event_types ? { eventTypes: body.event_types } : {}),
            ...(body.patient_identifier_issuer
              ? { patientIdentifierIssuer: body.patient_identifier_issuer }
              : {}),
          },
          deps.integrationPolicy,
        );
        return {
          status: 201,
          body: { connection },
          resourceType: "integration_connection",
          resourceId: connection.id,
        };
      },
    );
  });
  app.patch(
    `${base}/integrations/connections/:connectionId`,
    async (req, reply) => {
      const auth = await authorize(req, "integration.manage");
      const connectionId = idParam(req, "connectionId");
      const body = emrConnectionPatchSchema.parse(req.body);
      return mutate(
        req,
        reply,
        auth,
        "integration_connection.update",
        { connectionId, body },
        context(req, auth),
        async (c) => ({
          status: 200,
          body: {
            connection: await updateEmrConnection(
              c,
              admin(req, auth),
              connectionId,
              {
                expectedVersion: body.expected_version,
                ...(body.name !== undefined ? { name: body.name } : {}),
                ...(body.url !== undefined ? { url: body.url } : {}),
                ...(body.event_types !== undefined
                  ? { eventTypes: body.event_types }
                  : {}),
                ...(body.patient_identifier_issuer !== undefined
                  ? { patientIdentifierIssuer: body.patient_identifier_issuer }
                  : {}),
                ...(body.secret_ref !== undefined
                  ? { secretRef: body.secret_ref }
                  : {}),
                ...(body.status !== undefined ? { status: body.status } : {}),
              },
              deps.integrationPolicy,
            ),
          },
          resourceType: "integration_connection",
          resourceId: connectionId,
        }),
      );
    },
  );
  app.get(`${base}/integrations/events`, async (req) => {
    const auth = await authorize(req, "integration.manage");
    const q = integrationEventListQuerySchema.parse(req.query);
    const items = await read(req, auth, (c) =>
      listIntegrationEvents(c, admin(req, auth), {
        limit: q.limit,
        ...(q.status ? { status: q.status } : {}),
        ...(q.connection_id ? { connectionId: q.connection_id } : {}),
        ...(q.before ? { before: q.before } : {}),
      }),
    );
    return {
      items,
      next_before:
        items.length === q.limit ? items[items.length - 1]!.created_at : null,
    };
  });
}
