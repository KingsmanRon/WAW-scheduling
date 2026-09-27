import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Pool } from "pg";
import {
  PRACTICE_ROLES,
  STAFF_ROLES,
  type PracticeRole,
  type StaffRole,
} from "@access/contracts";
import { AppError, tenantTx, userTx, type ActorRef } from "@access/db";
import type { AuthConfig } from "@access/config";
import type { SchedulingActor } from "@access/scheduling";

/**
 * Workforce authentication at the API edge. Identity comes from a signed
 * JWT (Supabase Auth); authorisation never does. Organisation roles come
 * from organisation_memberships, practice roles from practice_memberships,
 * both server-side on every request. A tenant header can only select among
 * the caller's own memberships, and a practice id in the path must match an
 * active membership of that practice.
 */
export interface AuthContext {
  tenantId: string;
  userId: string;
  role: StaffRole;
  mode: "jwt" | "synthetic";
  actor: ActorRef;
}
export interface PracticeAuthContext {
  tenantId: string;
  practiceId: string;
  userId: string;
  role: PracticeRole;
  displayName: string;
  /** The practitioner a DOCTOR/CLINICAL_STAFF login represents, if linked. */
  practitionerId: string | null;
  mode: "jwt" | "synthetic";
  actor: SchedulingActor;
}
export interface PracticeMembershipView {
  practice_id: string;
  tenant_id: string;
  name: string;
  timezone: string;
  role: PracticeRole;
  display_name: string;
  practitioner_id: string | null;
}
export type Headers = Record<string, string | string[] | undefined>;
export interface Authenticator {
  readonly mode: "jwt" | "synthetic";
  /** Organisation-level context (referral operations). */
  authenticate(headers: Headers): Promise<AuthContext>;
  /** Practice-level context for /v1/practices/:practiceId routes. */
  authenticatePractice(
    headers: Headers,
    practiceId: string,
  ): Promise<PracticeAuthContext>;
  /** The caller's active practice memberships. */
  listPractices(headers: Headers): Promise<PracticeMembershipView[]>;
}
const unauthorized = (message: string) =>
  new AppError(401, "UNAUTHENTICATED", message);
const forbidden = (code: string, message: string) =>
  new AppError(403, code, message);
const practiceForbidden = () =>
  forbidden(
    "PRACTICE_NOT_PERMITTED",
    "no active membership for the requested practice",
  );
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function header(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}
const MEMBERSHIP_SELECT = `SELECT m.practice_id, m.tenant_id, p.name, p.timezone, m.role, m.display_name, m.practitioner_id
  FROM directory.practice_memberships m
  JOIN directory.practices p ON p.tenant_id=m.tenant_id AND p.id=m.practice_id
 WHERE m.user_id=$1 AND m.status='ACTIVE' AND p.status='ACTIVE'`;

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
  /** Verify the bearer token; returns the workforce user id (JWT subject). */
  async identify(headers: Headers): Promise<string> {
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
    return sub;
  }
  async authenticate(headers: Headers): Promise<AuthContext> {
    const sub = await this.identify(headers);
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
  async authenticatePractice(
    headers: Headers,
    practiceId: string,
  ): Promise<PracticeAuthContext> {
    const sub = await this.identify(headers);
    if (!UUID.test(practiceId)) throw practiceForbidden();
    const row = await userTx(
      sub,
      (c) =>
        c.query<PracticeMembershipView>(
          `${MEMBERSHIP_SELECT} AND m.practice_id=$2`,
          [sub, practiceId],
        ),
      this.pool,
    );
    const m = row.rows[0];
    if (!m) throw practiceForbidden();
    return {
      tenantId: m.tenant_id,
      practiceId: m.practice_id,
      userId: sub,
      role: m.role,
      displayName: m.display_name,
      practitionerId: m.practitioner_id,
      mode: this.mode,
      actor: { type: "STAFF", id: `user:${sub}`, role: m.role },
    };
  }
  async listPractices(headers: Headers): Promise<PracticeMembershipView[]> {
    const sub = await this.identify(headers);
    const rows = await userTx(
      sub,
      (c) =>
        c.query<PracticeMembershipView>(
          `${MEMBERSHIP_SELECT} ORDER BY p.name`,
          [sub],
        ),
      this.pool,
    );
    return rows.rows;
  }
}

/**
 * Development/test bridge: the caller asserts tenant and role in headers.
 * Configuration refuses it in client-pilot, production and REAL data mode.
 */
export class SyntheticAuthenticator implements Authenticator {
  readonly mode = "synthetic" as const;
  constructor(private pool?: Pool) {}
  private tenant(headers: Headers): string {
    const tenantId =
      header(headers, "x-tenant-id") ?? header(headers, "x-access-tenant");
    if (!tenantId || !UUID.test(tenantId))
      throw new AppError(
        400,
        "TENANT_CONTEXT_REQUIRED",
        "x-tenant-id required in synthetic mode",
      );
    return tenantId;
  }
  private user(headers: Headers): string {
    return (
      (header(headers, "x-access-user") ?? "synthetic-staff")
        .replace(/[^a-z0-9_.-]/gi, "")
        .slice(0, 64) || "synthetic-staff"
    );
  }
  private practiceRole(headers: Headers): PracticeRole {
    const role = header(headers, "x-practice-role") ?? "RECEPTIONIST";
    if (!(PRACTICE_ROLES as readonly string[]).includes(role))
      throw new AppError(400, "ROLE_INVALID", "unknown practice role");
    return role as PracticeRole;
  }
  async authenticate(headers: Headers): Promise<AuthContext> {
    const tenantId = this.tenant(headers);
    const roleHeader =
      header(headers, "x-access-role") ?? "REFERRAL_COORDINATOR";
    if (!(STAFF_ROLES as readonly string[]).includes(roleHeader))
      throw new AppError(400, "ROLE_INVALID", "unknown role");
    const user = this.user(headers);
    const role = roleHeader as StaffRole;
    return {
      tenantId,
      userId: `synthetic:${user}`,
      role,
      mode: this.mode,
      actor: { type: "STAFF", id: `synthetic:${user}`, role },
    };
  }
  async authenticatePractice(
    headers: Headers,
    practiceId: string,
  ): Promise<PracticeAuthContext> {
    const tenantId = this.tenant(headers);
    const role = this.practiceRole(headers);
    const user = this.user(headers);
    if (!UUID.test(practiceId) || !this.pool) throw practiceForbidden();
    // The asserted tenant must really own the practice.
    const practice = await tenantTx(
      tenantId,
      (c) =>
        c.query(
          "SELECT 1 FROM directory.practices WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
          [tenantId, practiceId],
        ),
      this.pool,
      { practiceId },
    );
    if (!practice.rowCount) throw practiceForbidden();
    return {
      tenantId,
      practiceId,
      userId: `synthetic:${user}`,
      role,
      displayName: `Synthetic ${user}`,
      practitionerId: null,
      mode: this.mode,
      actor: { type: "STAFF", id: `synthetic:${user}`, role },
    };
  }
  async listPractices(headers: Headers): Promise<PracticeMembershipView[]> {
    if (!this.pool) return [];
    const tenantId = this.tenant(headers);
    const role = this.practiceRole(headers);
    const rows = await tenantTx(
      tenantId,
      (c) =>
        c.query<{ id: string; name: string; timezone: string }>(
          "SELECT id,name,timezone FROM directory.practices WHERE tenant_id=$1 AND status='ACTIVE' ORDER BY name",
          [tenantId],
        ),
      this.pool,
    );
    return rows.rows.map((p) => ({
      practice_id: p.id,
      tenant_id: tenantId,
      name: p.name,
      timezone: p.timezone,
      role,
      display_name: `Synthetic ${this.user(headers)}`,
      practitioner_id: null,
    }));
  }
}
