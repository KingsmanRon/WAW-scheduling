import pg from "pg";
import { migrate, seedSynthetic } from "../../packages/db/src/index.js";

/**
 * Real PostgreSQL for integration behaviour. In CI a missing database is a
 * failure, never a silent skip.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    if (process.env.CI || process.env.REQUIRE_DATABASE_TESTS === "true")
      throw new Error(
        "TEST_DATABASE_URL is required: PostgreSQL integration suites must not skip in CI",
      );
    console.warn(
      "TEST_DATABASE_URL unset: PostgreSQL suites are skipped locally",
    );
    return;
  }
  // This setup drops the public schema: refuse anything but a test database.
  const database = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/test/i.test(database) && process.env.ACCESS_ALLOW_TEST_RESET !== "true")
    throw new Error(
      `refusing to reset database "${database}": TEST_DATABASE_URL must name a test database`,
    );
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query(
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;",
    );
    await migrate(pool);
    await pool.query(
      "ALTER ROLE access_request LOGIN PASSWORD 'integration-api'; ALTER ROLE access_worker LOGIN PASSWORD 'integration-worker';",
    );
    await seedSynthetic(pool);
  } finally {
    await pool.end();
  }
}
