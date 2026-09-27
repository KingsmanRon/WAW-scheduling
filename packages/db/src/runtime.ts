import pg from "pg";
import { readFileSync } from "node:fs";
import type { StaffRole } from "@access/contracts";

/** Error with an HTTP status and a stable, non-sensitive code. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const notFound = (what = "case") =>
  new AppError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (code: string, message: string) =>
  new AppError(409, code, message);

export interface PoolOptions {
  connectionString: string;
  ssl?: "require" | "disable" | undefined;
  caCertPath?: string | undefined;
  /** PEM content (e.g. from a secret store) instead of a file path. */
  caCert?: string | undefined;
  max?: number | undefined;
  applicationName?: string | undefined;
}
export function createPool(options: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? "access",
    ssl:
      options.ssl === "require"
        ? {
            rejectUnauthorized: true,
            ...(options.caCert
              ? { ca: options.caCert }
              : options.caCertPath
                ? { ca: readFileSync(options.caCertPath, "utf8") }
                : {}),
          }
        : undefined,
  });
}
export type DbClient = pg.PoolClient;

/**
 * Refuse to run as anything other than the expected least-privilege login.
 * Checked at startup of every non-local runtime.
 */
export async function verifyRuntimeIdentity(
  db: pg.Pool,
  expected: "access_request" | "access_worker",
): Promise<void> {
  const result = await db.query<{
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    member_of: number;
  }>(
    `SELECT current_user,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
            (SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid) AS member_of
       FROM pg_roles r WHERE r.rolname=current_user`,
  );
  const identity = result.rows[0];
  if (
    !identity ||
    identity.current_user !== expected ||
    identity.rolsuper ||
    identity.rolbypassrls ||
    identity.rolcreaterole ||
    identity.rolcreatedb ||
    identity.rolreplication ||
    identity.member_of > 0
  )
    throw new Error(`unsafe database identity; expected ${expected}`);
  const owns = await db.query(
    `SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
      WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND r.rolname=current_user LIMIT 1`,
  );
  if (owns.rowCount)
    throw new Error("runtime database identity owns application tables");
}

export interface RequestContext {
  userId?: string | undefined;
  actorRole?: StaffRole | null | undefined;
}
/**
 * Run `fn` in a transaction whose tenant (and, for staff requests, user and
 * role) context is transaction-local. Forced RLS returns nothing without it.
 */
export async function tenantTx<T>(
  tenantId: string,
  fn: (c: DbClient) => Promise<T>,
  db: pg.Pool,
  context: RequestContext = {},
): Promise<T> {
  if (!tenantId) throw new Error("tenant context required");
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true), set_config('app.actor_role',$3,true)",
      [tenantId, context.userId ?? "", context.actorRole ?? ""],
    );
    const value = await fn(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
/** Transaction scoped to a user only, used to resolve tenant membership. */
export async function userTx<T>(
  userId: string,
  fn: (c: DbClient) => Promise<T>,
  db: pg.Pool,
): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    const value = await fn(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
