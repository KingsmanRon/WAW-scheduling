import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  secretRefAllowed,
  whatsAppConnectionConfigSchema,
  type WhatsAppConnectionConfig,
} from "@access/integrations";

/**
 * Operator provisioning of a practice's WhatsApp number (the number belongs
 * to the platform's Meta app, so practices cannot route it themselves).
 * Runs with the migration owner's credential (MIGRATION_DATABASE_URL): it
 * writes the connection and the inbound route that maps Meta's
 * phone_number_id to the practice. Re-running updates the configuration;
 * `active: false` takes the number out of service.
 */
export interface WhatsAppProvisioning {
  tenantId: string;
  practiceId: string;
  name: string;
  secretRef: string;
  config: WhatsAppConnectionConfig;
  active: boolean;
  operator: string;
}

export async function provisionWhatsApp(
  owner: pg.Pool,
  input: WhatsAppProvisioning,
): Promise<{ connectionId: string; routeKey: string }> {
  const config = whatsAppConnectionConfigSchema.parse(input.config);
  if (!secretRefAllowed("WHATSAPP_CLOUD", input.secretRef))
    throw new Error(
      "secret ref must name a WHATSAPP_* variable (not the app secret or verify token)",
    );
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    const practice = await c.query(
      "SELECT 1 FROM directory.practices WHERE tenant_id=$1 AND id=$2",
      [input.tenantId, input.practiceId],
    );
    if (!practice.rowCount)
      throw new Error("practice not found in that organisation");
    const route = await c.query<{ tenant_id: string; practice_id: string }>(
      "SELECT tenant_id, practice_id FROM integration.channel_routes WHERE provider='WHATSAPP_CLOUD' AND route_key=$1",
      [config.phone_number_id],
    );
    const existingRoute = route.rows[0];
    if (
      existingRoute &&
      (existingRoute.tenant_id !== input.tenantId ||
        existingRoute.practice_id !== input.practiceId)
    )
      throw new Error(
        "that phone number id is already routed to another practice",
      );
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM integration.connections
        WHERE tenant_id=$1 AND practice_id=$2 AND provider='WHATSAPP_CLOUD' AND config->>'phone_number_id'=$3
        ORDER BY created_at DESC LIMIT 1`,
      [input.tenantId, input.practiceId, config.phone_number_id],
    );
    let connectionId = existing.rows[0]?.id;
    if (connectionId)
      await c.query(
        `UPDATE integration.connections SET name=$4, status=$5, config=$6, secret_ref=$7, version=version+1, updated_at=now()
          WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
        [
          input.tenantId,
          input.practiceId,
          connectionId,
          input.name,
          input.active ? "ACTIVE" : "DISABLED",
          JSON.stringify(config),
          input.secretRef,
        ],
      );
    else {
      connectionId = randomUUID();
      await c.query(
        `INSERT INTO integration.connections(tenant_id, practice_id, id, provider, name, status, config, secret_ref, created_by)
         VALUES($1,$2,$3,'WHATSAPP_CLOUD',$4,$5,$6,$7,$8)`,
        [
          input.tenantId,
          input.practiceId,
          connectionId,
          input.name,
          input.active ? "ACTIVE" : "DISABLED",
          JSON.stringify(config),
          input.secretRef,
          input.operator,
        ],
      );
    }
    if (existingRoute)
      await c.query(
        "UPDATE integration.channel_routes SET active=$2 WHERE provider='WHATSAPP_CLOUD' AND route_key=$1",
        [config.phone_number_id, input.active],
      );
    else
      await c.query(
        `INSERT INTO integration.channel_routes(provider, route_key, tenant_id, practice_id, connection_id, active)
         VALUES('WHATSAPP_CLOUD',$1,$2,$3,$4,$5)`,
        [
          config.phone_number_id,
          input.tenantId,
          input.practiceId,
          connectionId,
          input.active,
        ],
      );
    await c.query(
      `INSERT INTO platform.audit_events(tenant_id, practice_id, actor_type, actor_id, action, resource_type, resource_id,
                                         channel, changes)
       VALUES($1,$2,'OPERATOR',$3,$4,'integration_connection',$5,'SYSTEM',$6)`,
      [
        input.tenantId,
        input.practiceId,
        input.operator,
        existing.rows[0]
          ? "integration_connection.updated"
          : "integration_connection.created",
        connectionId,
        JSON.stringify({
          after: {
            provider: "WHATSAPP_CLOUD",
            phone_number_id: config.phone_number_id,
            active: input.active,
            secret_ref: input.secretRef,
          },
        }),
      ],
    );
    await c.query("COMMIT");
    return { connectionId, routeKey: config.phone_number_id };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
