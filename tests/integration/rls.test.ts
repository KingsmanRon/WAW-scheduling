import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tenantTx, userTx } from "../../packages/db/src/index.js";
import {
  apiPool,
  closePools,
  databaseEnabled,
  grantMembership,
  ingest,
  newTenant,
  ownerPool,
  testApi,
  workerPool,
  type TestApi,
} from "../support/harness.js";

const TENANT_TABLES = [
  "access_cases",
  "referrals",
  "artifacts",
  "commands",
  "evidence_events",
  "work_items",
  "executions",
  "outbox",
  "access_case_transitions",
  "access_interactions",
  "access_case_observations",
  "case_effort_events",
  "access_rule_sets",
  "organisation_memberships",
  "access_audit_log",
  "appointment_requests",
  "appointments",
  "appointment_slot_holds",
];

describe.runIf(databaseEnabled)(
  "tenant isolation and immutability in PostgreSQL",
  () => {
    let t: TestApi;
    let a: string;
    let b: string;
    beforeAll(async () => {
      t = await testApi();
      a = await newTenant();
      b = await newTenant();
      await ingest(t, a);
      await ingest(t, b, { fixture: "missing-insurance" });
      await grantMembership(a, randomUUID(), "ADMIN");
      await grantMembership(b, randomUUID(), "ADMIN");
    });
    afterAll(async () => {
      await t.close();
      await closePools();
    });

    it("every tenant table has forced RLS", async () => {
      const rows = await ownerPool().query(
        "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname = ANY($1)",
        [TENANT_TABLES],
      );
      expect(rows.rowCount).toBe(TENANT_TABLES.length);
      for (const r of rows.rows)
        expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([
          r.relname,
          true,
          true,
        ]);
    });

    it("fails closed without tenant context and isolates every table", async () => {
      for (const pool of [apiPool(), workerPool()]) {
        const c = await pool.connect();
        try {
          for (const table of TENANT_TABLES) {
            const readable = await c
              .query(`SELECT count(*)::int n FROM ${table}`)
              .then((r) => r.rows[0].n as number)
              .catch((e: Error) =>
                /permission denied/.test(e.message) ? 0 : Promise.reject(e),
              );
            expect(readable, `${table} without context`).toBe(0);
          }
        } finally {
          c.release();
        }
        for (const table of TENANT_TABLES) {
          const leaked = await tenantTx(
            b,
            (c) =>
              c.query(
                `SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`,
                [a],
              ),
            pool,
          )
            .then((r) => r.rows[0].n as number)
            .catch((e: Error) =>
              /permission denied/.test(e.message) ? 0 : Promise.reject(e),
            );
          expect(leaked, `${table} cross-tenant`).toBe(0);
        }
      }
      const own = await tenantTx(
        a,
        (c) => c.query("SELECT count(*)::int n FROM access_cases"),
        apiPool(),
      );
      expect(own.rows[0].n).toBe(1);
    });

    it("writes into another tenant are rejected", async () => {
      await expect(
        tenantTx(
          a,
          (c) =>
            c.query(
              "INSERT INTO access_cases(id,tenant_id,case_type,source_channel,current_state,opened_at) VALUES($1,$2,'REFERRAL','API','RECEIVED',now())",
              [randomUUID(), b],
            ),
          apiPool(),
        ),
      ).rejects.toThrow(/row-level security/);
      const updated = await tenantTx(
        a,
        (c) =>
          c.query(
            "UPDATE access_cases SET current_owner='ADMIN' WHERE tenant_id=$1",
            [b],
          ),
        apiPool(),
      );
      expect(updated.rowCount).toBe(0);
    });

    it("membership rows are visible to their own user or tenant, and writable only in an ADMIN context", async () => {
      const user = randomUUID();
      await grantMembership(a, user, "READ_ONLY");
      await grantMembership(b, user, "REFERRAL_COORDINATOR");
      const own = await userTx(
        user,
        (c) =>
          c.query(
            "SELECT tenant_id FROM organisation_memberships ORDER BY tenant_id",
          ),
        apiPool(),
      );
      expect(own.rows.map((r) => r.tenant_id).sort()).toEqual([a, b].sort());
      const stranger = await userTx(
        randomUUID(),
        (c) => c.query("SELECT count(*)::int n FROM organisation_memberships"),
        apiPool(),
      );
      expect(stranger.rows[0].n).toBe(0);
      await expect(
        tenantTx(
          a,
          (c) =>
            c.query(
              "INSERT INTO organisation_memberships(tenant_id,user_id,role,status,created_by,updated_by) VALUES($1,$2,'ADMIN','ACTIVE','x','x')",
              [a, randomUUID()],
            ),
          apiPool(),
          { actorRole: "REFERRAL_COORDINATOR" },
        ),
      ).rejects.toThrow(/row-level security/);
      await tenantTx(
        a,
        (c) =>
          c.query(
            "INSERT INTO organisation_memberships(tenant_id,user_id,role,status,created_by,updated_by) VALUES($1,$2,'READ_ONLY','ACTIVE','x','x')",
            [a, randomUUID()],
          ),
        apiPool(),
        { actorRole: "ADMIN" },
      );
    });

    it("rule sets are writable only in an ADMIN context", async () => {
      const row = { definition: "{}", hash: "a".repeat(64) };
      await expect(
        tenantTx(
          a,
          (c) =>
            c.query(
              "INSERT INTO access_rule_sets(tenant_id,version,status,created_by,definition,definition_hash) VALUES($1,99,'DRAFT','x',$2,$3)",
              [a, row.definition, row.hash],
            ),
          apiPool(),
          { actorRole: "PRACTICE_MANAGER" },
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("interactions, observations, effort, evidence, commands, history and audit are append-only", async () => {
      await ownerPool().query(
        "INSERT INTO access_audit_log(tenant_id,actor_type,actor_id,action,target_type,target_id,correlation_id) VALUES($1,'STAFF','t','probe','x','y',$1)",
        [a],
      );
      for (const table of [
        "access_interactions",
        "case_effort_events",
        "evidence_events",
        "commands",
        "access_case_transitions",
        "access_audit_log",
        "access_case_observations",
      ])
        await expect(
          ownerPool().query(`DELETE FROM ${table} WHERE tenant_id IN ($1,$2)`, [
            a,
            b,
          ]),
          table,
        ).rejects.toThrow(/append-only/);
      for (const table of [
        "evidence_events",
        "commands",
        "access_audit_log",
        "access_case_observations",
      ])
        await expect(
          ownerPool().query(`TRUNCATE ${table} CASCADE`),
          `truncate ${table}`,
        ).rejects.toThrow(/append-only/);
      await expect(
        ownerPool().query(
          "UPDATE access_interactions SET intent='OTHER' WHERE tenant_id=$1",
          [a],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        ownerPool().query(
          "UPDATE access_case_observations SET verification_level='OBSERVED' WHERE tenant_id=$1",
          [a],
        ),
      ).rejects.toThrow(/append-only/);
    });

    it("the database transition guard rejects bypass and rolls back side effects atomically", async () => {
      const caseId = (
        await ownerPool().query(
          "SELECT id FROM access_cases WHERE tenant_id=$1",
          [a],
        )
      ).rows[0].id;
      const c = await apiPool().connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [a]);
        await c.query(
          "INSERT INTO access_case_transitions(tenant_id,case_id,from_state,to_state,version,actor_type,actor_id,reason) VALUES($1,$2,'X','Y',99,'SYSTEM','t','probe')",
          [a, caseId],
        );
        await expect(
          c.query(
            "UPDATE access_cases SET current_state='BOOKED',version=version+1 WHERE id=$1",
            [caseId],
          ),
        ).rejects.toThrow(/invalid case transition/);
        await c.query("ROLLBACK");
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
      const probe = await ownerPool().query(
        "SELECT count(*)::int n FROM access_case_transitions WHERE reason='probe'",
      );
      expect(probe.rows[0].n).toBe(0);
      await expect(
        ownerPool().query(
          "UPDATE access_cases SET case_type='APPOINTMENT_REQUEST' WHERE id=$1",
          [caseId],
        ),
      ).rejects.toThrow(/immutable/);
    });
  },
);
