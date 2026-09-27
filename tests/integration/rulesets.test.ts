import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  closePools,
  databaseEnabled,
  ingest,
  ingestBody,
  newTenant,
  ownerPool,
  ruleDefinition,
  staff,
  testApi,
  type TestApi,
} from "../support/harness.js";

describe.runIf(databaseEnabled)("versioned administrative rule sets", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await testApi();
  });
  afterAll(async () => {
    await t.close();
    await closePools();
  });
  const admin = (tenant: string) => staff(tenant, "ADMIN", "admin");
  const create = (tenant: string, definition: unknown, role = "ADMIN") =>
    t.app.inject({
      method: "POST",
      url: "/v1/rule-sets",
      headers: staff(tenant, role, "admin"),
      payload: { command_id: randomUUID(), definition },
    });
  const publish = (tenant: string, id: string, effective_from?: string) =>
    t.app.inject({
      method: "POST",
      url: `/v1/rule-sets/${id}/publish`,
      headers: admin(tenant),
      payload: {
        command_id: randomUUID(),
        ...(effective_from ? { effective_from } : {}),
      },
    });

  it("only administrators write rule sets; invalid and clinical definitions are refused", async () => {
    const tenant = await newTenant();
    expect(
      (await create(tenant, ruleDefinition({}), "PRACTICE_MANAGER")).statusCode,
    ).toBe(403);
    const clinical = await create(
      tenant,
      ruleDefinition({
        services: [
          {
            code: "TRIAGE_A",
            label: "Triage category A",
            destination_queue: "q",
          },
        ],
      }),
    );
    expect(clinical.statusCode).toBe(422);
    expect(clinical.json().error).toBe("RULE_SET_INVALID");
    expect(
      (await create(tenant, { schema_version: "access-rules.v1" })).statusCode,
    ).toBe(422);
  });

  it("a change is a new version; scheduled versions take effect at their time; audit is recorded", async () => {
    const tenant = await newTenant();
    const later = new Date(Date.now() + 3600_000).toISOString();
    const draft = (
      await create(tenant, ruleDefinition({ destination: { mode: "MANUAL" } }))
    ).json();
    expect(draft.version).toBe(2);
    expect((await publish(tenant, draft.id, later)).statusCode).toBe(200);
    // Before the effective time the previous version still applies.
    const r = await ingest(t, tenant);
    expect(r.state).toBe("DESTINATION_PENDING");
    const sets = (
      await t.app.inject({
        method: "GET",
        url: "/v1/rule-sets",
        headers: staff(tenant, "READ_ONLY"),
      })
    ).json();
    expect(
      sets.map((s: { version: number; status: string }) => [
        s.version,
        s.status,
      ]),
    ).toEqual([
      [2, "ACTIVE"],
      [1, "ACTIVE"],
    ]);
    expect(new Date(sets[1].effective_to).toISOString()).toBe(later);
    const earlier = (await create(tenant, ruleDefinition({}))).json();
    const conflict = await publish(
      tenant,
      earlier.id,
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(conflict.json().error).toBe("RULE_SET_SCHEDULE_CONFLICT");
    const audit = await ownerPool().query(
      "SELECT action FROM access_audit_log WHERE tenant_id=$1 ORDER BY id",
      [tenant],
    );
    expect(audit.rows.map((a) => a.action)).toEqual([
      "rule_set.create",
      "rule_set.publish",
      "rule_set.create",
    ]);
  });

  it("the database guarantees one applicable active version and immutable published versions", async () => {
    const tenant = await newTenant();
    const current = (
      await ownerPool().query(
        "SELECT id,definition,definition_hash FROM access_rule_sets WHERE tenant_id=$1",
        [tenant],
      )
    ).rows[0];
    await expect(
      ownerPool().query(
        "INSERT INTO access_rule_sets(tenant_id,version,status,effective_from,published_by,published_at,created_by,definition,definition_hash) VALUES($1,9,'ACTIVE',now(),'x',now(),'x',$2,$3)",
        [tenant, current.definition, current.definition_hash],
      ),
    ).rejects.toThrow(/rule_set_single_active/);
    await expect(
      ownerPool().query(
        "UPDATE access_rule_sets SET definition_hash=repeat('b',64) WHERE id=$1",
        [current.id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      ownerPool().query("DELETE FROM access_rule_sets WHERE id=$1", [
        current.id,
      ]),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      ownerPool().query(
        "UPDATE access_rule_sets SET status='DRAFT' WHERE id=$1",
        [current.id],
      ),
    ).rejects.toThrow(/invalid rule set status/);
    const draft = (await create(tenant, ruleDefinition({}))).json();
    await ownerPool().query("DELETE FROM access_rule_sets WHERE id=$1", [
      draft.id,
    ]);
  });

  it("a tampered stored definition is never evaluated", async () => {
    const tenant = await newTenant();
    const c = await ownerPool().connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(
        "UPDATE access_rule_sets SET definition = jsonb_set(definition,'{required_documents}','[]') WHERE tenant_id=$1",
        [tenant],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/referrals",
      headers: staff(tenant),
      payload: ingestBody(),
    });
    expect(res.statusCode).toBe(500);
    expect(
      (
        await ownerPool().query(
          "SELECT count(*)::int n FROM access_cases WHERE tenant_id=$1",
          [tenant],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
