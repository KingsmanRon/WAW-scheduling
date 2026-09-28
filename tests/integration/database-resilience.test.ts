import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createPool } from "../../packages/db/src/index.js";
import { closePools, databaseEnabled, ownerPool } from "../support/harness.js";

describe.runIf(databaseEnabled)("database connection loss", () => {
  afterAll(closePools);

  it("survives an idle connection being dropped and reconnects on the next query", async () => {
    const name = `access-drop-${randomUUID().slice(0, 8)}`;
    const lost: Error[] = [];
    const pool = createPool({
      connectionString: process.env.TEST_DATABASE_URL!,
      applicationName: name,
      onIdleError: (e) => lost.push(e),
    });
    try {
      await pool.query("SELECT 1");
      // What a database restart or a pooler's idle timeout does.
      await ownerPool().query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
        [name],
      );
      await expect.poll(() => lost.length).toBeGreaterThan(0);
      expect((await pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally {
      await pool.end();
    }
  });
});
