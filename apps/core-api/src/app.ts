import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ZodError, z } from "zod";
import {
  APPOINTMENT_ACTIONS,
  APPOINTMENT_CHANGES,
  CASE_ACTIONS,
  CASE_TYPES,
  ENABLED_CASE_TYPES,
  QUEUE_FILTERS,
  appointmentActionSchema,
  appointmentChangeSchema,
  caseActionSchema,
  cohortQuerySchema,
  createCaseRequestSchema,
  ingestRequestSchema,
  interactionRequestSchema,
  membershipUpsertSchema,
  observationImportSchema,
  resolutionSchema,
  uuid,
} from "@access/contracts";
import {
  AppError,
  cohortMetrics,
  createRuleSetDraft,
  listRuleSets,
  notFound,
  publishRuleSet,
  requestHash,
  retireRuleSet,
  verifyEvidenceChain,
} from "@access/db";
import { errorFields, log, Metrics } from "@access/observability";
import { assertDirectlyCreatable, authorize } from "@access/policy";
import { RuleValidationError } from "@access/rules";
import type { AuthContext, Authenticator } from "./auth.js";
import { appointmentDetail, caseDetail, queue } from "./queries.js";
import { CaseService } from "./service.js";

export interface AppDeps {
  pool: Pool;
  service: CaseService;
  authenticator: Authenticator;
  corsOrigins: string[];
  info: { profile: string; dataMode: string; buildId: string };
}
declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
    startedAt?: number;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const metrics = new Metrics();
  const app = Fastify({
    logger: false,
    bodyLimit: 14_000_000,
    trustProxy: true,
  });
  await app.register(cors, {
    origin: deps.corsOrigins,
    methods: ["GET", "POST"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "x-access-tenant",
      "x-correlation-id",
      "x-tenant-id",
      "x-access-role",
      "x-access-user",
    ],
  });
  app.addHook("onRequest", async (req) => {
    req.startedAt = Date.now();
  });
  app.addHook("onResponse", async (req, reply) =>
    log("info", "http_request", {
      method: req.method,
      // Route pattern, never the raw URL.
      route: req.routeOptions.url ?? "unmatched",
      status_code: reply.statusCode,
      correlation_id: req.headers["x-correlation-id"],
      tenant_id: req.auth?.tenantId,
      duration_ms: Date.now() - (req.startedAt ?? Date.now()),
    }),
  );
  const auth = async (req: FastifyRequest): Promise<AuthContext> => {
    req.auth = await deps.authenticator.authenticate(req.headers);
    return req.auth;
  };

  app.get("/health", async () => ({
    status: "ok",
    build: deps.info.buildId,
    contracts: "v1.1",
  }));
  app.get("/ready", async (_q, r) => {
    try {
      await deps.pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      r.code(503);
      return { status: "not_ready" };
    }
  });
  app.get("/metrics", async () => metrics.snapshot());

  app.get("/v1/me", async (req) => {
    const a = await auth(req);
    return {
      user_id: a.userId,
      tenant_id: a.tenantId,
      role: a.role,
      auth_mode: a.mode,
      profile: deps.info.profile,
      data_mode: deps.info.dataMode,
    };
  });

  // Referral intake (REFERRAL case type).
  app.post("/v1/referrals", async (req, reply) => {
    const a = await auth(req);
    authorize(a.role, "referral.ingest");
    const input = ingestRequestSchema.parse(req.body);
    const result = await deps.service.ingestReferral(a, input);
    metrics.inc(
      result.deduplicated
        ? "referral_ingest_replayed_total"
        : "referral_ingested_total",
    );
    return reply.code(result.deduplicated ? 200 : 201).send(result);
  });
  // Generic case creation: only referrals are created directly; appointment
  // operations cases start from a referral or a committed appointment.
  app.post("/v1/cases", async (req, reply) => {
    const a = await auth(req);
    authorize(a.role, "referral.ingest");
    const { case_type, ...rest } = createCaseRequestSchema.parse(req.body);
    assertDirectlyCreatable(case_type);
    const input = ingestRequestSchema.parse(rest);
    const result = await deps.service.ingestReferral(a, input);
    return reply.code(result.deduplicated ? 200 : 201).send(result);
  });
  app.get("/v1/case-types", async (req) => {
    await auth(req);
    return CASE_TYPES.map((t) => ({
      case_type: t,
      enabled: ENABLED_CASE_TYPES.includes(t),
      created_from:
        t === "REFERRAL"
          ? "intake"
          : t === "APPOINTMENT_REQUEST"
            ? "referral"
            : ENABLED_CASE_TYPES.includes(t)
              ? "appointment"
              : null,
    }));
  });

  app.get("/v1/cases", async (req) => {
    const a = await auth(req);
    authorize(a.role, "case.read");
    const q = z
      .object({
        filter: z.enum(QUEUE_FILTERS).default("needs_attention"),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
      })
      .parse(req.query);
    return {
      filter: q.filter,
      items: await deps.service.runInTenant(a, (c) =>
        queue(c, a.tenantId, q.filter, q.limit, q.offset),
      ),
    };
  });
  app.get("/v1/cases/:caseId", async (req) => {
    const a = await auth(req);
    authorize(a.role, "case.read");
    const caseId = uuid.parse((req.params as { caseId: string }).caseId);
    return deps.service.runInTenant(a, (c) =>
      caseDetail(c, a.tenantId, caseId, a.role),
    );
  });
  app.get("/v1/cases/:caseId/evidence/verify", async (req) => {
    const a = await auth(req);
    authorize(a.role, "case.read");
    const caseId = uuid.parse((req.params as { caseId: string }).caseId);
    return deps.service.runInTenant(a, (c) =>
      verifyEvidenceChain(c, a.tenantId, caseId),
    );
  });
  app.post("/v1/cases/:caseId/interactions", async (req, reply) => {
    const a = await auth(req);
    authorize(a.role, "case.interaction");
    const caseId = uuid.parse((req.params as { caseId: string }).caseId);
    const result = await deps.service.addInteraction(
      a,
      caseId,
      interactionRequestSchema.parse(req.body),
    );
    return reply.code(result.deduplicated ? 200 : 201).send(result);
  });
  app.post("/v1/cases/:caseId/actions", async (req) => {
    const a = await auth(req);
    // Authorise the named action before validating the rest of the body.
    const named = z
      .object({ action: z.enum(CASE_ACTIONS) })
      .passthrough()
      .parse(req.body);
    authorize(a.role, `case.action.${named.action}`);
    const caseId = uuid.parse((req.params as { caseId: string }).caseId);
    return deps.service.performAction(
      a,
      caseId,
      caseActionSchema.parse(req.body),
    );
  });
  // Appointment operations: booking sub-flow steps on an APPOINTMENT_REQUEST,
  // RESCHEDULING_REQUEST or CANCELLATION_REQUEST case.
  app.post("/v1/cases/:caseId/appointment-actions", async (req) => {
    const a = await auth(req);
    // Coordinators and above; each case type then needs its own permission.
    authorize(a.role, "appointment.book");
    z.object({ action: z.enum(APPOINTMENT_ACTIONS) })
      .passthrough()
      .parse(req.body);
    const caseId = uuid.parse((req.params as { caseId: string }).caseId);
    return deps.service.performAppointmentAction(
      a,
      caseId,
      appointmentActionSchema.parse(req.body),
    );
  });
  app.get("/v1/appointments/:appointmentId", async (req) => {
    const a = await auth(req);
    authorize(a.role, "case.read");
    const id = uuid.parse(
      (req.params as { appointmentId: string }).appointmentId,
    );
    return deps.service.runInTenant(a, (c) =>
      appointmentDetail(c, a.tenantId, id, a.role),
    );
  });
  app.post("/v1/appointments/:appointmentId/actions", async (req) => {
    const a = await auth(req);
    // Authorise the named change before validating the rest of the body.
    const named = z
      .object({ action: z.enum(APPOINTMENT_CHANGES) })
      .passthrough()
      .parse(req.body);
    authorize(
      a.role,
      named.action === "confirm"
        ? "appointment.confirm"
        : named.action === "reschedule"
          ? "appointment.reschedule"
          : "appointment.cancel",
    );
    const id = uuid.parse(
      (req.params as { appointmentId: string }).appointmentId,
    );
    return deps.service.changeAppointment(
      a,
      id,
      appointmentChangeSchema.parse(req.body),
    );
  });
  app.post("/v1/observations/import", async (req) => {
    const a = await auth(req);
    authorize(a.role, "observation.import");
    return deps.service.importObservations(
      a,
      observationImportSchema.parse(req.body),
    );
  });

  // v1 compatibility: referral-addressed reads and resolution.
  app.get("/v1/referrals/:id", async (req) => {
    const a = await auth(req);
    authorize(a.role, "case.read");
    const id = uuid.parse((req.params as { id: string }).id);
    return deps.service.runInTenant(a, async (c) => {
      const row = await c.query<{ case_id: string }>(
        "SELECT case_id FROM referrals WHERE tenant_id=$1 AND id=$2",
        [a.tenantId, id],
      );
      if (!row.rows[0]) throw notFound("referral");
      const detail = await caseDetail(
        c,
        a.tenantId,
        row.rows[0].case_id,
        a.role,
      );
      return {
        referral: {
          id,
          case_id: detail.case.id,
          state: detail.case.current_state,
          version: detail.case.version,
          identity_status: detail.referral?.identity_status ?? null,
          external_id: detail.referral?.destination_reference ?? null,
        },
        events: detail.evidence.events,
        work_items: detail.work_items,
        executions: detail.executions,
        case: detail,
      };
    });
  });
  app.post("/v1/referrals/:id/resolve", async (req) => {
    const a = await auth(req);
    const id = uuid.parse((req.params as { id: string }).id);
    return deps.service.legacyResolve(a, id, resolutionSchema.parse(req.body));
  });

  // Business measurement.
  app.get("/v1/metrics/cohort", async (req) => {
    const a = await auth(req);
    authorize(a.role, "metrics.read");
    const q = cohortQuerySchema.parse(req.query);
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (!(to > from))
      throw new AppError(400, "PERIOD_INVALID", "to must be after from");
    return deps.service.runInTenant(a, (c) =>
      cohortMetrics(c, a.tenantId, from, to),
    );
  });

  // Versioned rule sets (ADMIN writes).
  app.get("/v1/rule-sets", async (req) => {
    const a = await auth(req);
    authorize(a.role, "rule_set.read");
    return deps.service.runInTenant(a, (c) => listRuleSets(c, a.tenantId));
  });
  app.post("/v1/rule-sets", async (req, reply) => {
    const a = await auth(req);
    authorize(a.role, "rule_set.write");
    const body = z
      .object({ command_id: uuid, definition: z.unknown() })
      .strict()
      .parse(req.body);
    const correlation = randomUUID();
    const result = await deps.service.commandInTenant(
      a,
      {
        tenantId: a.tenantId,
        commandId: body.command_id,
        type: "rule_set.create",
        requestHash: requestHash({
          type: "rule_set.create",
          definition: body.definition,
        }),
        actor: a.actor,
      },
      async (c) => {
        const draft = await createRuleSetDraft(c, {
          tenantId: a.tenantId,
          definition: body.definition,
          createdBy: a.actor.id,
        });
        await deps.service.audit(
          c,
          a,
          correlation,
          "rule_set.create",
          "rule_set",
          draft.id,
          { version: draft.version, definition_hash: draft.definition_hash },
        );
        return draft;
      },
    );
    return reply.code(result.deduplicated ? 200 : 201).send(result);
  });
  app.post("/v1/rule-sets/:id/publish", async (req) => {
    const a = await auth(req);
    authorize(a.role, "rule_set.write");
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z
      .object({ command_id: uuid, effective_from: z.iso.datetime().optional() })
      .strict()
      .parse(req.body);
    const effectiveFrom = body.effective_from
      ? new Date(body.effective_from)
      : new Date();
    return deps.service.commandInTenant(
      a,
      {
        tenantId: a.tenantId,
        commandId: body.command_id,
        type: "rule_set.publish",
        requestHash: requestHash({
          type: "rule_set.publish",
          id,
          effective_from: body.effective_from ?? null,
        }),
        actor: a.actor,
      },
      async (c) => {
        const published = await publishRuleSet(c, {
          tenantId: a.tenantId,
          id,
          effectiveFrom,
          publishedBy: a.actor.id,
        });
        await deps.service.audit(
          c,
          a,
          body.command_id,
          "rule_set.publish",
          "rule_set",
          id,
          {
            version: published.version,
            effective_from: effectiveFrom.toISOString(),
            closed: published.retired,
          },
        );
        return published;
      },
    );
  });
  app.post("/v1/rule-sets/:id/retire", async (req) => {
    const a = await auth(req);
    authorize(a.role, "rule_set.write");
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z.object({ command_id: uuid }).strict().parse(req.body);
    return deps.service.commandInTenant(
      a,
      {
        tenantId: a.tenantId,
        commandId: body.command_id,
        type: "rule_set.retire",
        requestHash: requestHash({ type: "rule_set.retire", id }),
        actor: a.actor,
      },
      async (c) => {
        await retireRuleSet(c, { tenantId: a.tenantId, id });
        await deps.service.audit(
          c,
          a,
          body.command_id,
          "rule_set.retire",
          "rule_set",
          id,
          {},
        );
        return { id, status: "RETIRED" };
      },
    );
  });

  // Workforce membership administration (ADMIN, own organisation only).
  app.get("/v1/admin/memberships", async (req) => {
    const a = await auth(req);
    authorize(a.role, "membership.manage");
    return deps.service.runInTenant(
      a,
      async (c) =>
        (
          await c.query(
            "SELECT user_id,role,status,created_by,updated_by,created_at,updated_at FROM organisation_memberships WHERE tenant_id=$1 ORDER BY created_at",
            [a.tenantId],
          )
        ).rows,
    );
  });
  app.post("/v1/admin/memberships", async (req) => {
    const a = await auth(req);
    authorize(a.role, "membership.manage");
    const body = membershipUpsertSchema.parse(req.body);
    if (
      body.user_id === a.userId &&
      (body.role !== "ADMIN" || body.status !== "ACTIVE")
    )
      throw new AppError(
        409,
        "SELF_DEMOTION",
        "an administrator cannot demote or suspend themselves",
      );
    return deps.service.commandInTenant(
      a,
      {
        tenantId: a.tenantId,
        commandId: body.command_id,
        type: "membership.upsert",
        requestHash: requestHash({
          type: "membership.upsert",
          ...body,
          command_id: undefined,
        }),
        actor: a.actor,
      },
      async (c) => {
        await c.query(
          `INSERT INTO organisation_memberships(tenant_id,user_id,role,status,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5)
           ON CONFLICT (tenant_id,user_id) DO UPDATE SET role=excluded.role,status=excluded.status,updated_by=excluded.updated_by,updated_at=now()`,
          [a.tenantId, body.user_id, body.role, body.status, a.actor.id],
        );
        await deps.service.audit(
          c,
          a,
          body.command_id,
          "membership.upsert",
          "user",
          body.user_id,
          { role: body.role, status: body.status },
        );
        return { user_id: body.user_id, role: body.role, status: body.status };
      },
    );
  });

  app.setErrorHandler((e, req, r) => {
    if (e instanceof ZodError) {
      log("warn", "request_rejected", {
        route: req.routeOptions.url,
        code: "VALIDATION_FAILED",
      });
      return r.code(400).send({
        error: "VALIDATION_FAILED",
        issues: e.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
      });
    }
    if (e instanceof RuleValidationError)
      return r
        .code(422)
        .send({ error: e.code, message: e.message, issues: e.issues });
    const status = (e as { statusCode?: number }).statusCode;
    const code = (e as { code?: string }).code;
    // Fastify's own client errors (e.g. body too large) carry a statusCode.
    if (status && status >= 400 && status < 500) {
      log("warn", "request_rejected", {
        route: req.routeOptions.url,
        ...errorFields(e),
      });
      return r
        .code(status)
        .send({ error: code ?? "BAD_REQUEST", message: (e as Error).message });
    }
    // PostgreSQL integrity violations are conflicts, reported without detail.
    if (code === "23505" || code === "23514" || code === "23P01")
      return r.code(409).send({
        error: "CONFLICT",
        message: "request conflicts with current state",
      });
    log("error", "request_failed", {
      route: req.routeOptions.url,
      ...errorFields(e),
    });
    return r.code(status && status >= 500 ? status : 500).send({
      error: status === 503 ? (code ?? "UNAVAILABLE") : "INTERNAL",
      message: status === 503 ? (e as Error).message : "internal error",
    });
  });
  return app;
}
