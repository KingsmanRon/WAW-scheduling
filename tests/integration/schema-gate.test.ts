import { afterAll, describe, expect, it } from "vitest";
import {
  latestMigrationVersion,
  schemaGate,
} from "../../packages/db/src/index.js";
import {
  apiPool,
  closePools,
  databaseEnabled,
  ownerPool,
  testApi,
  workerPool,
} from "../support/harness.js";

/**
 * A release must not go live on an older schema: the API reports not ready
 * (so Railway keeps the previous deployment serving) and the worker does no
 * work until the database has the newest migration the build ships with.
 */
describe.runIf(databaseEnabled)("readiness follows the schema", () => {
  afterAll(closePools);

  it("keeps the API not ready until the database has the build's newest migration", async () => {
    const behind = await testApi({
      schemaCurrent: schemaGate(apiPool(), "9999_not_yet_applied"),
    });
    const current = await testApi({
      schemaCurrent: schemaGate(apiPool(), await latestMigrationVersion()),
    });
    try {
      const refused = await behind.app.inject({ method: "GET", url: "/ready" });
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toEqual({
        status: "not_ready",
        reason: "schema_behind",
      });
      const ready = await current.app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
    } finally {
      await behind.close();
      await current.close();
    }
  });

  it("lets both runtime logins read the ledger and remembers a current schema", async () => {
    const latest = await latestMigrationVersion();
    expect(await schemaGate(apiPool(), latest)()).toBe(true);
    expect(await schemaGate(workerPool(), latest)()).toBe(true);

    const version = `9998_gate_${Date.now()}`;
    const gate = schemaGate(workerPool(), version);
    expect(await gate()).toBe(false);
    await ownerPool().query(
      "INSERT INTO schema_migrations(version, checksum) VALUES ($1, 'test')",
      [version],
    );
    try {
      expect(await gate()).toBe(true);
    } finally {
      await ownerPool().query(
        "DELETE FROM schema_migrations WHERE version = $1",
        [version],
      );
    }
    expect(await gate()).toBe(true);
  });
});
