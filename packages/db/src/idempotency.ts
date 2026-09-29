import { AppError, type DbClient } from "./runtime.js";

/**
 * Idempotency for externally reachable mutations (the `Idempotency-Key`
 * header). The key row is written inside the same transaction as the
 * mutation it protects:
 *
 * - a first request inserts the key (PENDING), runs the mutation, and stores
 *   the response on the same row before commit (COMPLETED);
 * - a concurrent retry with the same key blocks on the primary key until the
 *   first attempt commits, then replays the stored response; if the first
 *   attempt rolled back, the retry simply runs;
 * - a reused key with a different operation or request fingerprint fails
 *   deterministically with IDEMPOTENCY_KEY_REUSED;
 * - deterministic domain refusals (e.g. SLOT_UNAVAILABLE) are stored too:
 *   the mutation's effects are rolled back to a savepoint and the refusal is
 *   committed, so a retry returns the same answer instead of racing again.
 *   Unexpected errors roll back everything and store nothing.
 * - expired keys (default 24 h) may be reused; the worker purges them.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

export class IdempotencyKeyReusedError extends AppError {
  constructor() {
    super(
      422,
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key was already used for a different request",
    );
  }
}

export interface IdempotencyRequest {
  tenantId: string;
  /** The practice for practice-scoped operations, else the tenant. */
  scopeId: string;
  key: string;
  operation: string;
  /** requestHash() of the operation, target and body. */
  requestHash: string;
  actorId: string;
  ttlSeconds?: number;
}
export interface HandlerResult<T> {
  status: number;
  body: T;
  resourceType?: string;
  resourceId?: string;
}
export interface IdempotentResponse {
  status: number;
  body: unknown;
  replayed: boolean;
}

interface KeyRow {
  operation: string;
  request_hash: string;
  state: "PENDING" | "COMPLETED";
  response_status: number | null;
  response_body: unknown;
}

/**
 * Run `handler` at most once per key. `storeError` maps a thrown error to a
 * storable client response (deterministic 4xx refusal) or returns null to
 * propagate it (the transaction then rolls back, key included).
 */
export async function withIdempotency<T>(
  c: DbClient,
  req: IdempotencyRequest,
  handler: () => Promise<HandlerResult<T>>,
  storeError: (e: unknown) => { status: number; body: unknown } | null,
): Promise<IdempotentResponse> {
  if (!IDEMPOTENCY_KEY_PATTERN.test(req.key))
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key must be 8-200 characters of A-Z a-z 0-9 . _ : -",
    );
  const ttl = req.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  const claimed = await c.query(
    `INSERT INTO platform.idempotency_keys
       (tenant_id,scope_id,idempotency_key,operation,request_hash,actor_id,state,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,'PENDING',now()+make_interval(secs=>$7))
     ON CONFLICT (tenant_id,scope_id,idempotency_key) DO UPDATE
       SET operation=EXCLUDED.operation, request_hash=EXCLUDED.request_hash, actor_id=EXCLUDED.actor_id,
           state='PENDING', response_status=NULL, response_body=NULL, resource_type=NULL, resource_id=NULL,
           created_at=now(), completed_at=NULL, expires_at=EXCLUDED.expires_at
       WHERE platform.idempotency_keys.expires_at <= now()
     RETURNING 1`,
    [
      req.tenantId,
      req.scopeId,
      req.key,
      req.operation,
      req.requestHash,
      req.actorId,
      ttl,
    ],
  );
  if (!claimed.rowCount) {
    const prior = await c.query<KeyRow>(
      `SELECT operation,request_hash,state,response_status,response_body FROM platform.idempotency_keys
        WHERE tenant_id=$1 AND scope_id=$2 AND idempotency_key=$3`,
      [req.tenantId, req.scopeId, req.key],
    );
    const row = prior.rows[0];
    if (!row || row.state !== "COMPLETED")
      throw new AppError(
        409,
        "IDEMPOTENCY_IN_PROGRESS",
        "a request with this Idempotency-Key is still in progress",
      );
    if (row.operation !== req.operation || row.request_hash !== req.requestHash)
      throw new IdempotencyKeyReusedError();
    return {
      status: row.response_status!,
      body: row.response_body,
      replayed: true,
    };
  }
  await c.query("SAVEPOINT idempotent_mutation");
  let result: HandlerResult<T> | undefined;
  let refusal: { status: number; body: unknown } | null = null;
  try {
    result = await handler();
    await c.query("RELEASE SAVEPOINT idempotent_mutation");
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT idempotent_mutation");
    refusal = storeError(e);
    if (!refusal) throw e;
  }
  const response = result
    ? { status: result.status, body: result.body as unknown }
    : refusal!;
  await c.query(
    `UPDATE platform.idempotency_keys
        SET state='COMPLETED', response_status=$4, response_body=$5, resource_type=$6, resource_id=$7, completed_at=now()
      WHERE tenant_id=$1 AND scope_id=$2 AND idempotency_key=$3`,
    [
      req.tenantId,
      req.scopeId,
      req.key,
      response.status,
      JSON.stringify(response.body ?? null),
      result?.resourceType ?? null,
      result?.resourceId ?? null,
    ],
  );
  return { ...response, replayed: false };
}
