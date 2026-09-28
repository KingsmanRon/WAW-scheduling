import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { uuid, type BookingChannel } from "@access/contracts";
import {
  AppError,
  requestHash,
  withIdempotency,
  type AuditRequestMeta,
  type DbClient,
} from "@access/db";
import type { Metrics } from "@access/observability";
import type { IdentifierHasher } from "@access/patients";
import {
  authorizePractice,
  practiceCan,
  type PracticePermission,
} from "@access/policy";
import {
  SchedulingError,
  inPracticeTransaction,
  schedulingErrorFromDatabase,
  type CommandContext,
} from "@access/scheduling";
import type { Authenticator, PracticeAuthContext } from "./auth.js";

export interface PracticeRouteDeps {
  pool: Pool;
  authenticator: Authenticator;
  hasher: IdentifierHasher;
  metrics: Metrics;
}
declare module "fastify" {
  interface FastifyRequest {
    practiceAuth?: PracticeAuthContext;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function correlationId(req: FastifyRequest): string {
  const h = req.headers["x-correlation-id"];
  const v = Array.isArray(h) ? h[0] : h;
  return v && UUID.test(v) ? v : randomUUID();
}
export function requestMeta(req: FastifyRequest): AuditRequestMeta {
  const ua = req.headers["user-agent"];
  return {
    requestId: String(req.id),
    ip: req.ip,
    userAgent: Array.isArray(ua) ? ua[0] : ua,
  };
}

/** Deterministic domain refusals are stored against the key and replayed. */
export function storableRefusal(
  e: unknown,
): { status: number; body: unknown } | null {
  const domain =
    e instanceof SchedulingError ? e : schedulingErrorFromDatabase(e);
  if (domain)
    return {
      status: domain.statusCode,
      body: {
        error: domain.code,
        message: domain.message,
        ...(domain.details ? { details: domain.details } : {}),
      },
    };
  if (e instanceof AppError && e.statusCode >= 400 && e.statusCode < 500)
    return {
      status: e.statusCode,
      body: { error: e.code, message: e.message },
    };
  return null;
}

type Params = Record<string, string>;
export const params = (req: FastifyRequest) => req.params as Params;
export const idParam = (req: FastifyRequest, name: string) =>
  uuid.parse(params(req)[name]);

/**
 * Shared plumbing of the practice-scoped API (/v1/practices/:practiceId/*):
 * authentication and membership resolution for the practice in the path,
 * the central permission check, one practice-scoped transaction per request,
 * and Idempotency-Key handling for mutations (a retry replays the original
 * response; a reused key with a different request fails).
 */
export function createPracticeKit(deps: PracticeRouteDeps) {
  const { pool, metrics } = deps;

  async function authorize(
    req: FastifyRequest,
    permission: PracticePermission,
  ): Promise<PracticeAuthContext> {
    const auth =
      req.practiceAuth ??
      (await deps.authenticator.authenticatePractice(
        req.headers,
        params(req).practiceId ?? "",
      ));
    req.practiceAuth = auth;
    authorizePractice(auth.role, permission);
    return auth;
  }
  function context(
    req: FastifyRequest,
    auth: PracticeAuthContext,
    channel: BookingChannel = "INTERNAL",
    sessionRef?: string,
  ): CommandContext {
    return {
      tenantId: auth.tenantId,
      practiceId: auth.practiceId,
      actor: auth.actor,
      channel,
      correlationId: correlationId(req),
      sessionRef: sessionRef ?? null,
      mayOverrideAvailability: practiceCan(
        auth.role,
        "appointment.override_availability",
      ),
      request: requestMeta(req),
    };
  }
  const read = <T>(
    req: FastifyRequest,
    auth: PracticeAuthContext,
    fn: (c: DbClient, ctx: CommandContext) => Promise<T>,
  ): Promise<T> => {
    const ctx = context(req, auth);
    return inPracticeTransaction(pool, ctx, (c) => fn(c, ctx));
  };
  /**
   * An idempotent mutation. `material` is everything that makes the request
   * what it is (validated body and path ids); it is fingerprinted with the
   * operation so a reused key with anything different is refused.
   */
  async function mutate(
    req: FastifyRequest,
    reply: FastifyReply,
    auth: PracticeAuthContext,
    operation: string,
    material: unknown,
    ctx: CommandContext,
    handler: (c: DbClient) => Promise<{
      status: number;
      body: unknown;
      resourceType?: string;
      resourceId?: string;
    }>,
  ) {
    const raw = req.headers["idempotency-key"];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key)
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "an Idempotency-Key header is required for this operation",
      );
    const started = performance.now();
    const result = await inPracticeTransaction(pool, ctx, (c) =>
      withIdempotency(
        c,
        {
          tenantId: auth.tenantId,
          scopeId: auth.practiceId,
          key,
          operation,
          requestHash: requestHash({ operation, material }),
          actorId: auth.actor.id,
        },
        () => handler(c),
        storableRefusal,
      ),
    );
    const outcome =
      result.status < 400
        ? "ok"
        : String((result.body as { error?: string })?.error ?? "refused");
    metrics.inc("scheduling_commands_total", {
      operation,
      outcome,
      replayed: String(result.replayed),
    });
    if (!result.replayed)
      metrics.observe(
        "scheduling_command_seconds",
        (performance.now() - started) / 1000,
        { operation },
      );
    if (outcome === "SLOT_UNAVAILABLE")
      metrics.inc("slot_conflicts_total", { operation });
    return reply
      .header("idempotent-replayed", String(result.replayed))
      .code(result.status)
      .send(result.body);
  }
  return { authorize, context, read, mutate };
}
export type PracticeKit = ReturnType<typeof createPracticeKit>;
