import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Pool } from "pg";
import { STAFF_ROLES, type StaffRole } from "@access/contracts";
import { AppError, userTx, type ActorRef } from "@access/db";
import type { AuthConfig } from "@access/config";

/**
 * Workforce authentication at the API edge. Identity comes from a signed
 * JWT (Supabase Auth); tenant and role come from the organisation membership
 * table, never from a browser-supplied header. A tenant header can only
 * select among the caller's own verified memberships.
 */
export interface AuthContext {
  tenantId: string;
  userId: string;
  role: StaffRole;
  mode: "jwt" | "synthetic";
  actor: ActorRef;
}
export type Headers = Record<string, string | string[] | undefined>;
export interface Authenticator {
  readonly mode: "jwt" | "synthetic";
  authenticate(headers: Headers): Promise<AuthContext>;
}
const unauthorized = (message: string) =>
  new AppError(401, "UNAUTHENTICATED", message);
const forbidden = (code: string, message: string) =>
  new AppError(403, code, message);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function header(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export class JwtAuthenticator implements Authenticator {
  readonly mode = "jwt" as const;
  private key: Uint8Array | JWTVerifyGetKey;
  private algorithms: string[];
  constructor(
    private config: AuthConfig,
    private pool: Pool,
  ) {
    if (config.jwksUrl) {
      this.key = createRemoteJWKSet(new URL(config.jwksUrl), {
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      });
      this.algorithms = ["ES256", "RS256", "EdDSA"];
    } else if (config.hsSecret) {
      this.key = new TextEncoder().encode(config.hsSecret);
      this.algorithms = ["HS256"];
    } else throw new Error("JWT verification key not configured");
    if (!config.issuer || !config.audience)
      throw new Error("JWT issuer and audience are required");
  }
  async authenticate(headers: Headers): Promise<AuthContext> {
    const authorization = header(headers, "authorization");
    const token = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(
      authorization ?? "",
    )?.[1];
    if (!token) throw unauthorized("bearer token required");
    let sub: string;
    try {
      const { payload } = await jwtVerify(token, this.key as Uint8Array, {
        issuer: this.config.issuer!,
        audience: this.config.audience!,
        algorithms: this.algorithms,
        clockTolerance: 30,
        requiredClaims: ["sub", "exp", "iat"],
      });
      sub = String(payload.sub);
    } catch {
      throw unauthorized("invalid or expired token");
    }
    if (!UUID.test(sub))
      throw unauthorized("token subject is not a workforce user");
    const memberships = await userTx(
      sub,
      (c) =>
        c.query<{ tenant_id: string; role: StaffRole }>(
          "SELECT tenant_id,role FROM organisation_memberships WHERE user_id=$1 AND status='ACTIVE' ORDER BY tenant_id",
          [sub],
        ),
      this.pool,
    );
    const requested =
      header(headers, "x-access-tenant") ?? header(headers, "x-tenant-id");
    let membership: { tenant_id: string; role: StaffRole } | undefined;
    if (requested) {
      membership = memberships.rows.find((m) => m.tenant_id === requested);
      if (!membership)
        throw forbidden(
          "TENANT_NOT_PERMITTED",
          "no active membership for the requested organisation",
        );
    } else if (memberships.rows.length === 1) membership = memberships.rows[0];
    else if (memberships.rows.length === 0)
      throw forbidden("NO_MEMBERSHIP", "no active organisation membership");
    else
      throw new AppError(
        400,
        "TENANT_SELECTION_REQUIRED",
        "select an organisation with x-access-tenant",
      );
    return {
      tenantId: membership!.tenant_id,
      userId: sub,
      role: membership!.role,
      mode: this.mode,
      actor: { type: "STAFF", id: `user:${sub}`, role: membership!.role },
    };
  }
}

/**
 * Development/test bridge: the caller asserts tenant and role in headers.
 * Configuration refuses it in client-pilot, production and REAL data mode.
 */
export class SyntheticAuthenticator implements Authenticator {
  readonly mode = "synthetic" as const;
  async authenticate(headers: Headers): Promise<AuthContext> {
    const tenantId =
      header(headers, "x-tenant-id") ?? header(headers, "x-access-tenant");
    if (!tenantId || !UUID.test(tenantId))
      throw new AppError(
        400,
        "TENANT_CONTEXT_REQUIRED",
        "x-tenant-id required in synthetic mode",
      );
    const roleHeader =
      header(headers, "x-access-role") ?? "REFERRAL_COORDINATOR";
    if (!(STAFF_ROLES as readonly string[]).includes(roleHeader))
      throw new AppError(400, "ROLE_INVALID", "unknown role");
    const user =
      (header(headers, "x-access-user") ?? "synthetic-staff")
        .replace(/[^a-z0-9_.-]/gi, "")
        .slice(0, 64) || "synthetic-staff";
    const role = roleHeader as StaffRole;
    return {
      tenantId,
      userId: `synthetic:${user}`,
      role,
      mode: this.mode,
      actor: { type: "STAFF", id: `synthetic:${user}`, role },
    };
  }
}
