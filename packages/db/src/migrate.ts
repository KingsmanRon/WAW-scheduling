import { createPool } from "./runtime.js";
import { migrate } from "./migrations.js";

// Operator/migration job only. API and worker never receive this URL.
const url =
  process.env.MIGRATION_DATABASE_URL ??
  (["development", "test"].includes(process.env.NODE_ENV ?? "")
    ? process.env.DATABASE_URL
    : undefined);
if (!url) throw new Error("MIGRATION_DATABASE_URL required");
const pool = createPool({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined,
  caCertPath: process.env.DATABASE_CA_CERT_PATH,
  caCert: process.env.DATABASE_CA_CERT,
  max: 1,
  applicationName: "access-migrate",
});
try {
  const result = await migrate(pool, { log: (m) => console.log(m) });
  console.log(
    JSON.stringify({
      applied: result.applied,
      baselined: result.baselined,
      already_applied: result.alreadyApplied.length,
    }),
  );
} finally {
  await pool.end();
}
