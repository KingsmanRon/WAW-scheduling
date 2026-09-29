import type pg from "pg";
import {
  DEFAULT_RULE_DEFINITION,
  type RuleDefinitionInput,
} from "@access/rules";
import { createRuleSetDraft, publishRuleSet } from "./rules.js";
import { tenantTx } from "./runtime.js";

export const SYNTHETIC_TENANTS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Synthetic Orthopaedics",
    destinationMode: "CONNECTOR" as const,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Synthetic Cardiology",
    destinationMode: "MANUAL" as const,
  },
];

/**
 * Create an organisation and publish its first rule set (the default rule
 * set, optionally overridden). Idempotent. Must run as the migration owner:
 * runtime roles cannot create organisations.
 */
export async function seedTenant(
  owner: pg.Pool,
  tenant: {
    id: string;
    name: string;
    destinationMode?: "CONNECTOR" | "MANUAL";
    definition?: RuleDefinitionInput;
  },
): Promise<void> {
  await owner.query(
    "INSERT INTO organisations(id,name) VALUES($1,$2) ON CONFLICT (id) DO NOTHING",
    [tenant.id, tenant.name],
  );
  await tenantTx(
    tenant.id,
    async (c) => {
      const existing = await c.query(
        "SELECT 1 FROM access_rule_sets WHERE tenant_id=$1 LIMIT 1",
        [tenant.id],
      );
      if (existing.rowCount) return;
      const definition = tenant.definition ?? {
        ...DEFAULT_RULE_DEFINITION,
        destination: { mode: tenant.destinationMode ?? "CONNECTOR" },
      };
      const draft = await createRuleSetDraft(c, {
        tenantId: tenant.id,
        definition,
        createdBy: "seed",
      });
      await publishRuleSet(c, {
        tenantId: tenant.id,
        id: draft.id,
        effectiveFrom: new Date("2020-01-01T00:00:00Z"),
        publishedBy: "seed",
      });
    },
    owner,
    { actorRole: "ADMIN", userId: "" },
  );
}

export async function seedSynthetic(owner: pg.Pool): Promise<void> {
  for (const tenant of SYNTHETIC_TENANTS) await seedTenant(owner, tenant);
}
