import { readFile } from "node:fs/promises";
import { DEFAULT_RULE_DEFINITION, parseRuleDefinition } from "@access/rules";
import { createPool, tenantTx } from "./runtime.js";
import { seedTenant } from "./seed-lib.js";

/**
 * Operator bootstrap for a client organisation: creates the organisation,
 * publishes its first administrative rule set and grants the first ADMIN
 * membership. Runs with the migration credential, never at runtime.
 *
 *   TENANT_ID=<uuid> TENANT_NAME="Practice" ADMIN_USER_ID=<supabase user uuid> \
 *   RULES_FILE=./client-rules.json npm run tenant:bootstrap
 *
 * Without RULES_FILE the default rule set is used with MANUAL destination
 * (no automated connector is qualified for real data yet).
 */
const {
  MIGRATION_DATABASE_URL,
  TENANT_ID,
  TENANT_NAME,
  ADMIN_USER_ID,
  RULES_FILE,
} = process.env;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!MIGRATION_DATABASE_URL) throw new Error("MIGRATION_DATABASE_URL required");
if (!TENANT_ID || !uuid.test(TENANT_ID))
  throw new Error("TENANT_ID (uuid) required");
if (!TENANT_NAME) throw new Error("TENANT_NAME required");
if (!ADMIN_USER_ID || !uuid.test(ADMIN_USER_ID))
  throw new Error("ADMIN_USER_ID (Supabase Auth user uuid) required");
const definition = parseRuleDefinition(
  RULES_FILE
    ? JSON.parse(await readFile(RULES_FILE, "utf8"))
    : { ...DEFAULT_RULE_DEFINITION, destination: { mode: "MANUAL" } },
);
const pool = createPool({
  connectionString: MIGRATION_DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined,
  caCertPath: process.env.DATABASE_CA_CERT_PATH,
  caCert: process.env.DATABASE_CA_CERT,
  max: 2,
});
try {
  await seedTenant(pool, { id: TENANT_ID, name: TENANT_NAME, definition });
  await tenantTx(
    TENANT_ID,
    (c) =>
      c.query(
        `INSERT INTO organisation_memberships(tenant_id,user_id,role,status,created_by,updated_by)
         VALUES($1,$2,'ADMIN','ACTIVE','operator-bootstrap','operator-bootstrap')
         ON CONFLICT (tenant_id,user_id) DO UPDATE SET role='ADMIN',status='ACTIVE',updated_by='operator-bootstrap',updated_at=now()`,
        [TENANT_ID, ADMIN_USER_ID],
      ),
    pool,
    { actorRole: "ADMIN" },
  );
  console.log(
    JSON.stringify({
      tenant_id: TENANT_ID,
      admin_user_id: ADMIN_USER_ID,
      destination_mode: definition.destination.mode,
    }),
  );
} finally {
  await pool.end();
}
