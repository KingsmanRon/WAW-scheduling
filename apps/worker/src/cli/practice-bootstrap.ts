import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { bootstrapPractice, createPool } from "@access/db";

/**
 * Operator command: create a practice (and its organisation if new) with its
 * IANA time zone and first PRACTICE_ADMIN, a Supabase Auth user. Everything
 * else (locations, practitioners, hours, types, staff) the administrator
 * sets up in the console. Idempotent; runs with the owner credential.
 *
 *   MIGRATION_DATABASE_URL=... npm run practice:bootstrap -- \
 *     --tenant <org uuid> --tenant-name "Rosebank Health" \
 *     --name "Rosebank Family Practice" --timezone Africa/Johannesburg \
 *     --admin-user <supabase auth user uuid> --admin-name "Dr N. Admin" \
 *     [--admin-email admin@example.org] [--practice <uuid>]
 *
 * In the image: node apps/worker/dist/cli/practice-bootstrap.js ...
 */
const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    "tenant-name": { type: "string" },
    practice: { type: "string" },
    name: { type: "string" },
    timezone: { type: "string" },
    "admin-user": { type: "string" },
    "admin-name": { type: "string" },
    "admin-email": { type: "string" },
  },
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refuse = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(64);
};
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) refuse("MIGRATION_DATABASE_URL is required (operator credential)");
for (const required of [
  "tenant",
  "tenant-name",
  "name",
  "timezone",
  "admin-user",
  "admin-name",
] as const)
  if (!values[required]) refuse(`--${required} is required`);
if (!uuid.test(values.tenant!)) refuse("--tenant must be a uuid");
if (!uuid.test(values["admin-user"]!))
  refuse("--admin-user must be the Supabase Auth user's uuid");
if (values.practice && !uuid.test(values.practice))
  refuse("--practice must be a uuid");
if (!Intl.supportedValuesOf("timeZone").includes(values.timezone!))
  refuse(`--timezone must be an IANA time zone (e.g. Africa/Johannesburg)`);

const practiceId = values.practice ?? randomUUID();
const pool = createPool({
  connectionString: url!,
  ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined,
  caCertPath: process.env.DATABASE_CA_CERT_PATH,
  caCert: process.env.DATABASE_CA_CERT,
  max: 1,
  applicationName: "access-operator",
});
try {
  await bootstrapPractice(pool, {
    tenantId: values.tenant!,
    tenantName: values["tenant-name"]!,
    practiceId,
    practiceName: values.name!,
    timezone: values.timezone!,
    admin: {
      userId: values["admin-user"]!,
      displayName: values["admin-name"]!,
      email: values["admin-email"] ?? null,
    },
  });
  process.stdout.write(
    `${JSON.stringify({
      tenant_id: values.tenant,
      practice_id: practiceId,
      timezone: values.timezone,
      admin_user_id: values["admin-user"],
    })}\n`,
  );
} finally {
  await pool.end();
}
