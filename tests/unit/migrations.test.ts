import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MIGRATIONS_DIRECTORY,
  discoverMigrations,
  executableSql,
} from "../../packages/db/src/migrations.js";

async function dir(files: Record<string, string>) {
  const d = await mkdtemp(join(tmpdir(), "mig-"));
  for (const [name, sql] of Object.entries(files))
    await writeFile(join(d, name), sql);
  return d;
}

describe("migration discovery", () => {
  it("orders the repository migrations and checksums them", async () => {
    const files = await discoverMigrations(DEFAULT_MIGRATIONS_DIRECTORY);
    expect(files.map((f) => f.version)).toEqual([
      "0001_access",
      "0002_staging_hardening",
      "0003_access_cases",
      "0004_interactions_outcomes_rules",
      "0005_workforce_identity_and_privileges",
      "0006_appointment_operations",
    ]);
    for (const f of files) expect(f.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
  it("detects duplicate version numbers and unexpected names", async () => {
    await expect(
      discoverMigrations(
        await dir({ "0001_a.sql": "SELECT 1;", "0001_b.sql": "SELECT 1;" }),
      ),
    ).rejects.toThrow(/duplicate migration number 0001/);
    await expect(
      discoverMigrations(await dir({ "1_a.sql": "SELECT 1;" })),
    ).rejects.toThrow(/unexpected migration file name/);
  });
  it("owns the transaction: strips the legacy wrapper and refuses other transaction control", () => {
    expect(executableSql("0001_x", "BEGIN;\nSELECT 1;\nCOMMIT;\n").trim()).toBe(
      "SELECT 1;",
    );
    expect(() =>
      executableSql("0009_x", "SELECT 1;\nCOMMIT;\nSELECT 2;"),
    ).toThrow(/transaction control/);
    // plpgsql blocks are not transaction control.
    expect(() =>
      executableSql("0009_y", "DO $$ BEGIN PERFORM 1; END $$;"),
    ).not.toThrow();
  });
});
