import type pg from "pg";

/** Every schema that holds application data. */
export const APPLICATION_SCHEMAS = [
  "public",
  "platform",
  "directory",
  "scheduling",
  "messaging",
  "integration",
] as const;

/** Tables that intentionally carry no row-level security. */
const RLS_EXEMPT = new Set([
  // Tenant catalogue and the migration ledger: no tenant rows to isolate.
  "public.organisations",
  "public.schema_migrations",
]);
/**
 * RLS enabled but not forced: written only by owner-privileged code
 * (SECURITY DEFINER trigger / operator provisioning), read by narrow policies.
 */
const RLS_NOT_FORCED = new Set([
  "scheduling.schedule_signals",
  "integration.channel_routes",
]);
/** Practice-scoped tables whose API access is not bound to one practice. */
const PRACTICE_SCOPE_EXEMPT = new Set([
  "scheduling.schedule_signals",
  "integration.channel_routes",
]);
/** The only DELETE privileges runtime roles hold: retention purges. */
const DELETE_ALLOWED = new Set([
  "access_worker.platform.idempotency_keys",
  "access_worker.integration.webhook_receipts",
]);
/** What Supabase browser roles may touch (Realtime view signals only). */
const BROWSER_ALLOWED = new Set([
  "authenticated.directory.practice_memberships:SELECT",
  "authenticated.scheduling.schedule_signals:SELECT",
]);
const SECURITY_DEFINER_ALLOWED = new Set(["scheduling.touch_schedule_signal"]);

/**
 * Structural security invariants of the schema, checked by the migration
 * validator (CI) and the integration suite. Returns a list of violations.
 */
export async function verifySchemaSecurity(db: pg.Pool): Promise<string[]> {
  const problems: string[] = [];
  const schemas = [...APPLICATION_SCHEMAS];
  const tables = await db.query<{
    name: string;
    rls: boolean;
    forced: boolean;
    has_practice: boolean;
    owner: string;
  }>(
    `SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'practice_id' AND NOT a.attisdropped) AS has_practice,
            pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p')`,
    [schemas],
  );
  const restrictive = new Set(
    (
      await db.query<{ name: string }>(
        `SELECT schemaname || '.' || tablename AS name FROM pg_policies
          WHERE schemaname = ANY($1) AND permissive = 'RESTRICTIVE' AND 'access_request' = ANY(roles)`,
        [schemas],
      )
    ).rows.map((r) => r.name),
  );
  for (const t of tables.rows) {
    if (RLS_EXEMPT.has(t.name)) continue;
    if (!t.rls) problems.push(`${t.name}: row-level security is not enabled`);
    else if (!t.forced && !RLS_NOT_FORCED.has(t.name))
      problems.push(`${t.name}: row-level security is not forced`);
    if (["access_request", "access_worker"].includes(t.owner))
      problems.push(`${t.name}: owned by runtime role ${t.owner}`);
    if (
      t.has_practice &&
      t.name.split(".")[0] !== "public" &&
      !PRACTICE_SCOPE_EXEMPT.has(t.name) &&
      !restrictive.has(t.name)
    )
      problems.push(
        `${t.name}: no restrictive practice policy for the API role`,
      );
  }
  const privileges = await db.query<{
    role: string;
    name: string;
    privilege: string;
  }>(
    `SELECT r.rolname AS role, n.nspname || '.' || c.relname AS name, p.privilege
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN pg_roles r
       CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p(privilege)
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p')
        AND r.rolname IN ('access_request','access_worker','anon','authenticated','service_role')
        AND has_table_privilege(r.oid, c.oid, p.privilege)`,
    [schemas],
  );
  const newSchemas = new Set<string>(schemas.filter((s) => s !== "public"));
  for (const p of privileges.rows) {
    const runtime = p.role === "access_request" || p.role === "access_worker";
    if (runtime) {
      if (p.privilege === "TRUNCATE")
        problems.push(`${p.role} may TRUNCATE ${p.name}`);
      if (
        p.privilege === "DELETE" &&
        !DELETE_ALLOWED.has(`${p.role}.${p.name}`)
      )
        problems.push(`${p.role} may DELETE ${p.name}`);
      if (p.privilege === "REFERENCES" || p.privilege === "TRIGGER")
        problems.push(`${p.role} holds ${p.privilege} on ${p.name}`);
    } else if (
      newSchemas.has(p.name.split(".")[0]!) &&
      !BROWSER_ALLOWED.has(`${p.role}.${p.name}:${p.privilege}`)
    )
      problems.push(`browser role ${p.role} holds ${p.privilege} on ${p.name}`);
  }
  const definers = await db.query<{ name: string; config: string[] | null }>(
    `SELECT n.nspname || '.' || p.proname AS name, p.proconfig AS config
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($1) AND p.prosecdef`,
    [schemas],
  );
  for (const d of definers.rows) {
    if (!SECURITY_DEFINER_ALLOWED.has(d.name))
      problems.push(`${d.name} is SECURITY DEFINER`);
    if (!(d.config ?? []).some((c) => c.startsWith("search_path=")))
      problems.push(
        `${d.name} is SECURITY DEFINER without a fixed search_path`,
      );
  }
  return problems;
}
