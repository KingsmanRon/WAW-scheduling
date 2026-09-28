import pg from "pg";
import { migrate } from "./migrations.js";
import { verifySchemaSecurity } from "./schema-security.js";
import { simulateSupabase } from "./supabase-simulation.js";

/**
 * Migration validation from a clean environment (CI and pre-release):
 *
 *   VALIDATION_DATABASE_URL=postgres://owner:pw@host:5432/postgres npm run db:validate
 *
 * Creates a throwaway database (by default standing in for a Supabase
 * project: its browser roles, their default grants in `public` and the
 * Realtime publication, so the Supabase-only branches run), applies
 * every migration, applies them again to prove the runner is a no-op on an
 * up-to-date schema, verifies the security invariants of every application
 * table, and drops the database. Never touches an existing database.
 */
const adminUrl = process.env.VALIDATION_DATABASE_URL;
if (!adminUrl) throw new Error("VALIDATION_DATABASE_URL required");
const supabase = process.env.VALIDATION_SUPABASE_ROLES !== "false";
const name = `access_validate_${Date.now()}_${process.pid}`;
const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
const target = new URL(adminUrl);
target.pathname = `/${name}`;
let failed = false;
try {
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: target.toString(), max: 2 });
  try {
    if (supabase) await simulateSupabase(pool);
    const first = await migrate(pool, { log: (m) => console.log(m) });
    const second = await migrate(pool);
    if (second.applied.length)
      throw new Error(
        `second run applied ${second.applied.join(",")}; migrations must be recorded exactly once`,
      );
    const problems = await verifySchemaSecurity(pool);
    if (problems.length)
      throw new Error(
        `schema security violations:\n - ${problems.join("\n - ")}`,
      );
    console.log(
      JSON.stringify({
        database: name,
        applied: first.applied.length,
        supabase_roles_simulated: supabase,
        result: "valid",
      }),
    );
  } finally {
    await pool.end();
  }
} catch (error) {
  failed = true;
  console.error((error as Error).message);
} finally {
  await admin
    .query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    .catch(() => undefined);
  await admin.end();
}
if (failed) process.exit(1);
