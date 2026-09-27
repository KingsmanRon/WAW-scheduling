import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type pg from "pg";

/**
 * Ledger-based migration runner. `schema_migrations` is the source of truth:
 * each unapplied migration runs in its own transaction together with its
 * ledger row, so a failed migration is never recorded as applied. Applied
 * migrations are checksummed and any later mutation of their file is refused.
 */
export interface MigrationFile {
  version: string;
  number: number;
  checksum: string;
  sql: string;
}
export class MigrationError extends Error {
  readonly code = "MIGRATION_ERROR";
}
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const LEGACY_BEGIN = /^\s*BEGIN\s*;/i;
const LEGACY_COMMIT = /COMMIT\s*;\s*$/i;
const TRANSACTION_CONTROL =
  /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;\s*$/im;

export function migrationChecksum(content: string): string {
  return createHash("sha256")
    .update(content.replace(/\r\n/g, "\n"))
    .digest("hex");
}

/**
 * Legacy migrations (0001, 0002) wrap themselves in BEGIN/COMMIT; the runner
 * owns the transaction, so that outer pair is removed. Any other top-level
 * transaction control is refused: it would break ledger atomicity.
 */
export function executableSql(version: string, content: string): string {
  let sql = content.replace(/\r\n/g, "\n");
  if (LEGACY_BEGIN.test(sql) && LEGACY_COMMIT.test(sql))
    sql = sql.replace(LEGACY_BEGIN, "").replace(LEGACY_COMMIT, "");
  if (TRANSACTION_CONTROL.test(sql))
    throw new MigrationError(
      `${version} contains top-level transaction control; the runner owns the transaction`,
    );
  return sql;
}

export async function discoverMigrations(
  directory: string,
): Promise<MigrationFile[]> {
  const entries = (await readdir(directory)).filter((f) => f.endsWith(".sql"));
  const files: MigrationFile[] = [];
  const byNumber = new Map<number, string>();
  for (const name of entries) {
    const match = FILE_PATTERN.exec(name);
    if (!match)
      throw new MigrationError(
        `unexpected migration file name ${name}; expected NNNN_name.sql`,
      );
    const number = Number(match[1]);
    const prior = byNumber.get(number);
    if (prior)
      throw new MigrationError(
        `duplicate migration number ${match[1]}: ${prior} and ${name}`,
      );
    byNumber.set(number, name);
    const content = await readFile(join(directory, name), "utf8");
    const version = name.replace(/\.sql$/, "");
    files.push({
      version,
      number,
      checksum: migrationChecksum(content),
      sql: executableSql(version, content),
    });
  }
  return files.sort((a, b) => a.number - b.number);
}

export const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../../supabase/migrations/", import.meta.url),
);

export interface MigrateResult {
  applied: string[];
  baselined: string[];
  alreadyApplied: string[];
}
export async function migrate(
  pool: pg.Pool,
  options: {
    directory?: string;
    /** Apply only up to and including this version (tests, staged rollout). */
    until?: string;
    log?: (message: string) => void;
  } = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const files = await discoverMigrations(
    options.directory ?? DEFAULT_MIGRATIONS_DIRECTORY,
  );
  const client = await pool.connect();
  const result: MigrateResult = {
    applied: [],
    baselined: [],
    alreadyApplied: [],
  };
  try {
    // One migrator at a time per database.
    await client.query(
      "SELECT pg_advisory_lock(hashtext('access:migrations'))",
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text;
       ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS execution_ms integer;`,
    );
    const ledger = new Map(
      (
        await client.query<{ version: string; checksum: string | null }>(
          "SELECT version,checksum FROM schema_migrations",
        )
      ).rows.map((r) => [r.version, r.checksum]),
    );
    const known = new Set(files.map((f) => f.version));
    for (const version of ledger.keys())
      if (!known.has(version))
        throw new MigrationError(
          `applied migration ${version} is missing from the migrations directory`,
        );
    const untilNumber = options.until
      ? files.find((f) => f.version === options.until)?.number
      : Number.POSITIVE_INFINITY;
    if (untilNumber === undefined)
      throw new MigrationError(`unknown migration ${options.until}`);
    let highestApplied = -1;
    for (const file of files) {
      if (!ledger.has(file.version)) continue;
      highestApplied = Math.max(highestApplied, file.number);
      const recorded = ledger.get(file.version);
      if (recorded === null || recorded === undefined) {
        // Recorded by the pre-ledger runner: adopt the current checksum once.
        await client.query(
          "UPDATE schema_migrations SET checksum=$1 WHERE version=$2 AND checksum IS NULL",
          [file.checksum, file.version],
        );
        result.baselined.push(file.version);
      } else if (recorded !== file.checksum)
        throw new MigrationError(
          `migration ${file.version} was modified after it was applied (checksum mismatch)`,
        );
      result.alreadyApplied.push(file.version);
    }
    for (const file of files) {
      if (ledger.has(file.version) || file.number > untilNumber) continue;
      if (file.number < highestApplied)
        throw new MigrationError(
          `migration ${file.version} is older than an applied migration; refusing out-of-order apply`,
        );
      const started = Date.now();
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '15s'");
        await client.query(file.sql);
        await client.query(
          `INSERT INTO schema_migrations(version,checksum,execution_ms) VALUES($1,$2,$3)
           ON CONFLICT (version) DO UPDATE SET checksum=excluded.checksum, execution_ms=excluded.execution_ms
           WHERE schema_migrations.checksum IS NULL`,
          [file.version, file.checksum, Date.now() - started],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new MigrationError(
          `migration ${file.version} failed and was rolled back: ${(error as Error).message}`,
        );
      }
      log(`migration ${file.version} applied`);
      result.applied.push(file.version);
    }
    return result;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('access:migrations'))")
      .catch(() => undefined);
    client.release();
  }
}
