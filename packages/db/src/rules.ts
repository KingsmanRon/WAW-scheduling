import {
  definitionHash,
  parseRuleDefinition,
  type RuleDefinition,
  type RuleSetRef,
} from "@access/rules";
import { AppError, conflict, notFound, type DbClient } from "./runtime.js";

interface RuleSetRow {
  id: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  definition: unknown;
  definition_hash: string;
  effective_from: Date | null;
  effective_to: Date | null;
  published_by: string | null;
  published_at: Date | null;
  created_by: string;
  created_at: Date;
}
const columns =
  "id,version,status,definition,definition_hash,effective_from,effective_to,published_by,published_at,created_by,created_at";

/** Re-parse and re-hash on load: a tampered definition is never evaluated. */
function toRef(row: RuleSetRow): RuleSetRef {
  const definition = parseRuleDefinition(row.definition);
  if (definitionHash(definition) !== row.definition_hash)
    throw new AppError(
      500,
      "RULE_SET_INTEGRITY",
      `rule set ${row.id} failed its integrity check`,
    );
  return {
    id: row.id,
    version: row.version,
    definition_hash: row.definition_hash,
    definition,
  };
}

/** The single ACTIVE version whose window covers `at`; retired never applies. */
export async function loadApplicableRuleSet(
  c: DbClient,
  tenantId: string,
  at: Date = new Date(),
): Promise<RuleSetRef | null> {
  const rows = await c.query<RuleSetRow>(
    `SELECT ${columns} FROM access_rule_sets
      WHERE tenant_id=$1 AND case_type='REFERRAL' AND status='ACTIVE'
        AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)`,
    [tenantId, at],
  );
  if ((rows.rowCount ?? 0) > 1)
    throw new AppError(
      500,
      "RULE_SET_AMBIGUOUS",
      "more than one applicable rule set",
    );
  return rows.rows[0] ? toRef(rows.rows[0]) : null;
}
/** A case's pinned version, whatever its current status. */
export async function loadRuleSet(
  c: DbClient,
  tenantId: string,
  id: string,
): Promise<RuleSetRef> {
  const rows = await c.query<RuleSetRow>(
    `SELECT ${columns} FROM access_rule_sets WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id],
  );
  if (!rows.rows[0]) throw notFound("rule set");
  return toRef(rows.rows[0]);
}
export async function listRuleSets(c: DbClient, tenantId: string) {
  const rows = await c.query<RuleSetRow>(
    `SELECT ${columns} FROM access_rule_sets WHERE tenant_id=$1 ORDER BY version DESC`,
    [tenantId],
  );
  return rows.rows;
}

export async function createRuleSetDraft(
  c: DbClient,
  input: { tenantId: string; definition: unknown; createdBy: string },
): Promise<{ id: string; version: number; definition_hash: string }> {
  const definition: RuleDefinition = parseRuleDefinition(input.definition);
  const hash = definitionHash(definition);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${input.tenantId}:rule-sets`,
  ]);
  const next = await c.query<{ version: number }>(
    "SELECT coalesce(max(version),0)+1 AS version FROM access_rule_sets WHERE tenant_id=$1 AND case_type='REFERRAL'",
    [input.tenantId],
  );
  const version = next.rows[0]!.version;
  const inserted = await c.query<{ id: string }>(
    `INSERT INTO access_rule_sets(tenant_id,version,status,created_by,definition,definition_hash)
     VALUES($1,$2,'DRAFT',$3,$4,$5) RETURNING id`,
    [input.tenantId, version, input.createdBy, definition, hash],
  );
  return { id: inserted.rows[0]!.id, version, definition_hash: hash };
}

/**
 * Publish a draft from `effectiveFrom`. The currently open ACTIVE version is
 * closed at that instant (never edited otherwise); a version scheduled to
 * start later than `effectiveFrom` is a conflict.
 */
export async function publishRuleSet(
  c: DbClient,
  input: {
    tenantId: string;
    id: string;
    effectiveFrom: Date;
    publishedBy: string;
  },
): Promise<{ id: string; version: number; retired: string[] }> {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${input.tenantId}:rule-sets`,
  ]);
  const target = await c.query<RuleSetRow>(
    `SELECT ${columns} FROM access_rule_sets WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [input.tenantId, input.id],
  );
  const row = target.rows[0];
  if (!row) throw notFound("rule set");
  if (row.status !== "DRAFT")
    throw conflict("RULE_SET_NOT_DRAFT", "only a draft can be published");
  toRef(row);
  const later = await c.query(
    "SELECT 1 FROM access_rule_sets WHERE tenant_id=$1 AND status='ACTIVE' AND effective_from >= $2",
    [input.tenantId, input.effectiveFrom],
  );
  if (later.rowCount)
    throw conflict(
      "RULE_SET_SCHEDULE_CONFLICT",
      "an active version starts at or after this effective time",
    );
  const closed = await c.query<{ id: string }>(
    `UPDATE access_rule_sets SET effective_to=$2
      WHERE tenant_id=$1 AND status='ACTIVE' AND effective_to IS NULL AND effective_from < $2 RETURNING id`,
    [input.tenantId, input.effectiveFrom],
  );
  await c.query(
    `UPDATE access_rule_sets SET status='ACTIVE',effective_from=$3,published_by=$4,published_at=now()
      WHERE tenant_id=$1 AND id=$2`,
    [input.tenantId, input.id, input.effectiveFrom, input.publishedBy],
  );
  return {
    id: input.id,
    version: row.version,
    retired: closed.rows.map((r) => r.id),
  };
}
export async function retireRuleSet(
  c: DbClient,
  input: { tenantId: string; id: string },
): Promise<void> {
  const updated = await c.query(
    `UPDATE access_rule_sets SET status='RETIRED',effective_to=coalesce(effective_to,greatest(now(),effective_from+interval '1 millisecond'))
      WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`,
    [input.tenantId, input.id],
  );
  if (!updated.rowCount)
    throw conflict(
      "RULE_SET_NOT_ACTIVE",
      "only an active rule set can be retired",
    );
}
