import { randomUUID } from "node:crypto";
import type { EmrEventType } from "@access/contracts";
import {
  AppError,
  recordAuditEvent,
  type AuditActor,
  type AuditRequestMeta,
  type DbClient,
} from "@access/db";
import { emrWebhookConfigSchema, EMR_EVENT_TYPES } from "./emr-webhook.js";
import { DeliveryFailure } from "./errors.js";
import {
  assertOutboundUrl,
  assertPublicTarget,
  type TargetPolicy,
} from "./net.js";
import { secretRefAllowed } from "./secrets.js";
import { whatsAppConnectionConfigSchema } from "./whatsapp.js";

/** Who is changing a practice's integrations (from the verified session). */
export interface IntegrationAdminContext {
  tenantId: string;
  practiceId: string;
  actor: AuditActor;
  request?: AuditRequestMeta;
}
export interface ConnectionView {
  id: string;
  provider: "WHATSAPP_CLOUD" | "EMR_WEBHOOK";
  name: string;
  status: "ACTIVE" | "DISABLED";
  /** Provider settings; never secrets (only the secret's name). */
  config: Record<string, unknown>;
  secret_ref: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
interface ConnectionRow extends ConnectionView {
  created_by: string;
}

function view(row: ConnectionRow): ConnectionView {
  let config: Record<string, unknown> = {};
  if (row.provider === "EMR_WEBHOOK") {
    const parsed = emrWebhookConfigSchema.safeParse(row.config);
    config = parsed.success ? { ...parsed.data } : {};
  } else {
    const parsed = whatsAppConnectionConfigSchema.safeParse(row.config);
    config = parsed.success ? { ...parsed.data } : {};
  }
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    status: row.status,
    config,
    secret_ref: row.secret_ref,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const COLUMNS =
  "id, provider, name, status, config, secret_ref, version, created_at, updated_at, created_by";

export async function listConnections(
  c: DbClient,
  ctx: IntegrationAdminContext,
): Promise<ConnectionView[]> {
  const r = await c.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM integration.connections WHERE tenant_id=$1 AND practice_id=$2 ORDER BY provider, name, id`,
    [ctx.tenantId, ctx.practiceId],
  );
  return r.rows.map(view);
}

async function validateTarget(
  url: string,
  policy: TargetPolicy,
): Promise<void> {
  try {
    await assertPublicTarget(assertOutboundUrl(url, policy), policy);
  } catch (e) {
    if (e instanceof DeliveryFailure)
      throw new AppError(
        422,
        e.code,
        "the webhook URL is not an allowed target",
      );
    throw e;
  }
}
function assertSecretRef(ref: string): void {
  if (!secretRefAllowed("EMR_WEBHOOK", ref))
    throw new AppError(
      422,
      "SECRET_REF_INVALID",
      "secret_ref must name an EMR_WEBHOOK_* variable in the worker environment",
    );
}

/**
 * Add an EMR / practice-system webhook. The URL must be public HTTPS; the
 * signing secret lives in the worker's environment under secret_ref (the
 * database stores only that name).
 */
export async function createEmrConnection(
  c: DbClient,
  ctx: IntegrationAdminContext,
  input: {
    name: string;
    url: string;
    eventTypes?: EmrEventType[];
    patientIdentifierIssuer?: string;
    secretRef: string;
  },
  policy: TargetPolicy,
): Promise<ConnectionView> {
  await validateTarget(input.url, policy);
  assertSecretRef(input.secretRef);
  const config = emrWebhookConfigSchema.parse({
    url: input.url,
    event_types: input.eventTypes ?? [...EMR_EVENT_TYPES],
    ...(input.patientIdentifierIssuer
      ? { patient_identifier_issuer: input.patientIdentifierIssuer }
      : {}),
  });
  const id = randomUUID();
  const r = await c.query<ConnectionRow>(
    `INSERT INTO integration.connections(tenant_id, practice_id, id, provider, name, status, config, secret_ref, created_by)
     VALUES($1,$2,$3,'EMR_WEBHOOK',$4,'ACTIVE',$5,$6,$7) RETURNING ${COLUMNS}`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      input.name,
      JSON.stringify(config),
      input.secretRef,
      ctx.actor.id,
    ],
  );
  const created = view(r.rows[0]!);
  await recordAuditEvent(c, {
    tenantId: ctx.tenantId,
    practiceId: ctx.practiceId,
    actor: ctx.actor,
    action: "integration_connection.created",
    resourceType: "integration_connection",
    resourceId: id,
    channel: "INTERNAL",
    changes: {
      after: {
        provider: "EMR_WEBHOOK",
        name: created.name,
        config: created.config,
        secret_ref: created.secret_ref,
      },
    },
    ...(ctx.request ? { request: ctx.request } : {}),
  });
  return created;
}

/** Change or disable an EMR webhook. WhatsApp connections are operator-managed. */
export async function updateEmrConnection(
  c: DbClient,
  ctx: IntegrationAdminContext,
  connectionId: string,
  patch: {
    name?: string;
    url?: string;
    eventTypes?: EmrEventType[];
    patientIdentifierIssuer?: string | null;
    secretRef?: string;
    status?: "ACTIVE" | "DISABLED";
    expectedVersion: number;
  },
  policy: TargetPolicy,
): Promise<ConnectionView> {
  const r = await c.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM integration.connections WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId, connectionId],
  );
  const row = r.rows[0];
  if (!row)
    throw new AppError(
      404,
      "CONNECTION_NOT_FOUND",
      "integration connection not found",
    );
  if (row.provider !== "EMR_WEBHOOK")
    throw new AppError(
      403,
      "CONNECTION_OPERATOR_MANAGED",
      "WhatsApp connections are provisioned by the platform operator",
    );
  if (row.version !== patch.expectedVersion)
    throw new AppError(
      409,
      "VERSION_CONFLICT",
      "the connection changed; reload it",
    );
  const before = view(row);
  const current = emrWebhookConfigSchema.parse(row.config);
  if (patch.url !== undefined) await validateTarget(patch.url, policy);
  if (patch.secretRef !== undefined) assertSecretRef(patch.secretRef);
  const issuer =
    patch.patientIdentifierIssuer === undefined
      ? current.patient_identifier_issuer
      : (patch.patientIdentifierIssuer ?? undefined);
  const config = emrWebhookConfigSchema.parse({
    url: patch.url ?? current.url,
    event_types: patch.eventTypes ?? current.event_types,
    ...(issuer ? { patient_identifier_issuer: issuer } : {}),
  });
  const updated = await c.query<ConnectionRow>(
    `UPDATE integration.connections
        SET name=$4, status=$5, config=$6, secret_ref=$7, version=version+1, updated_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 RETURNING ${COLUMNS}`,
    [
      ctx.tenantId,
      ctx.practiceId,
      connectionId,
      patch.name ?? row.name,
      patch.status ?? row.status,
      JSON.stringify(config),
      patch.secretRef ?? row.secret_ref,
    ],
  );
  const after = view(updated.rows[0]!);
  await recordAuditEvent(c, {
    tenantId: ctx.tenantId,
    practiceId: ctx.practiceId,
    actor: ctx.actor,
    action:
      patch.status && patch.status !== row.status
        ? `integration_connection.${patch.status === "DISABLED" ? "disabled" : "enabled"}`
        : "integration_connection.updated",
    resourceType: "integration_connection",
    resourceId: connectionId,
    channel: "INTERNAL",
    changes: {
      before: {
        name: before.name,
        status: before.status,
        config: before.config,
        secret_ref: before.secret_ref,
      },
      after: {
        name: after.name,
        status: after.status,
        config: after.config,
        secret_ref: after.secret_ref,
      },
    },
    ...(ctx.request ? { request: ctx.request } : {}),
  });
  return after;
}

export interface IntegrationEventView {
  id: string;
  connection_id: string;
  direction: string;
  event_type: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  last_error_code: string | null;
  response_status: number | null;
  created_at: Date;
  completed_at: Date | null;
}
export async function listIntegrationEvents(
  c: DbClient,
  ctx: IntegrationAdminContext,
  q: {
    status?: string;
    connectionId?: string;
    before?: Date;
    limit: number;
  },
): Promise<IntegrationEventView[]> {
  const r = await c.query<IntegrationEventView>(
    `SELECT id, connection_id, direction, event_type, status, attempt_count, next_attempt_at, last_error_code,
            response_status, created_at, completed_at
       FROM integration.events
      WHERE tenant_id=$1 AND practice_id=$2 AND ($3::text IS NULL OR status=$3)
        AND ($4::uuid IS NULL OR connection_id=$4) AND ($5::timestamptz IS NULL OR created_at < $5)
      ORDER BY created_at DESC, id DESC LIMIT $6`,
    [
      ctx.tenantId,
      ctx.practiceId,
      q.status ?? null,
      q.connectionId ?? null,
      q.before ?? null,
      q.limit,
    ],
  );
  return r.rows;
}
