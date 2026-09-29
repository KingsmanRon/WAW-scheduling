import { createPool } from "./runtime.js";
import { seedSynthetic } from "./seed-lib.js";

// Synthetic fixtures only. Runs as the migration owner.
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL required");
if ((process.env.ACCESS_DATA_MODE ?? "SYNTHETIC") !== "SYNTHETIC")
  throw new Error("synthetic seed refused outside ACCESS_DATA_MODE=SYNTHETIC");
const pool = createPool({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined,
  caCertPath: process.env.DATABASE_CA_CERT_PATH,
  caCert: process.env.DATABASE_CA_CERT,
});
await seedSynthetic(pool);
console.log("synthetic fixtures seeded");
await pool.end();
