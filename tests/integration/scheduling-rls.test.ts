import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { tenantTx, verifySchemaSecurity } from "../../packages/db/src/index.js";
import { bookAppointment } from "../../packages/scheduling/src/index.js";
import {
  apiPool,
  closePools,
  databaseEnabled,
  ownerPool,
  workerPool,
} from "../support/harness.js";
import {
  newPatient,
  newPractice,
  run,
  slot,
  staffCtx,
  type TestPractice,
} from "../support/scheduling.js";

const SCHEMAS = [
  "platform",
  "directory",
  "scheduling",
  "messaging",
  "integration",
];
/** Tables whose practice is not in a practice_id column. */
const PRACTICE_COLUMN: Record<string, string> = {
  "directory.practices": "id",
  "platform.idempotency_keys": "scope_id",
};

describe.runIf(databaseEnabled)(
  "row-level security of the scheduling platform",
  () => {
    let a: TestPractice;
    let b: TestPractice;
    let tables: string[];
    beforeAll(async () => {
      a = await newPractice();
      b = await newPractice();
      for (const p of [a, b]) {
        const patient = await newPatient(p);
        const ctx = staffCtx(p);
        await run(ctx, (c) =>
          bookAppointment(c, ctx, {
            patientId: patient,
            appointmentTypeId: p.typeId,
            practitionerId: p.practitionerIds[0],
            locationId: p.locationId,
            start: slot(2, "09:00"),
          }),
        );
      }
      tables = (
        await ownerPool().query<{ name: string }>(
          `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relkind='r' ORDER BY 1`,
          [SCHEMAS],
        )
      ).rows.map((r) => r.name);
    });
    afterAll(closePools);

    it("passes the structural security checks (forced RLS, least privilege, no browser access)", async () => {
      expect(await verifySchemaSecurity(ownerPool())).toEqual([]);
      expect(tables.length).toBeGreaterThan(35);
    });

    const count = async (
      pool: pg.Pool,
      table: string,
      scope: { tenantId?: string; practiceId?: string },
      where = "",
      params: unknown[] = [],
    ): Promise<number> => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "SELECT set_config('app.tenant_id',$1,true), set_config('app.practice_id',$2,true)",
          [scope.tenantId ?? "", scope.practiceId ?? ""],
        );
        return await c
          .query(`SELECT count(*)::int n FROM ${table} ${where}`, params)
          .then((x) => x.rows[0].n as number)
          .catch((e: Error) =>
            /permission denied/.test(e.message) ? -1 : Promise.reject(e),
          );
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    };

    it("fails closed without tenant context for the API and worker logins", async () => {
      for (const pool of [apiPool(), workerPool()])
        for (const table of tables) {
          if (table === "integration.channel_routes") continue;
          const n = await count(pool, table, {});
          expect(n <= 0, `${table} readable without context`).toBe(true);
        }
    });

    it("never shows one organisation's rows to another", async () => {
      for (const pool of [apiPool(), workerPool()])
        for (const table of tables) {
          if (table === "integration.channel_routes") continue;
          const n = await count(
            pool,
            table,
            { tenantId: b.tenantId, practiceId: b.practiceId },
            "WHERE tenant_id=$1",
            [a.tenantId],
          );
          expect(n <= 0, `${table} leaks across tenants`).toBe(true);
        }
    });

    it("binds the API login to one practice even inside its own organisation", async () => {
      const sibling = await (async () => {
        // A second practice of organisation A.
        const id = randomUUID();
        await ownerPool().query(
          "INSERT INTO directory.practices(tenant_id,id,name,timezone) VALUES($1,$2,'Sibling practice','Africa/Johannesburg')",
          [a.tenantId, id],
        );
        return id;
      })();
      const own = await count(apiPool(), "scheduling.appointments", {
        tenantId: a.tenantId,
        practiceId: a.practiceId,
      });
      expect(own).toBe(1);
      for (const table of tables) {
        if (
          [
            "integration.channel_routes",
            "scheduling.schedule_signals",
          ].includes(table)
        )
          continue;
        const n = await count(
          apiPool(),
          table,
          {
            tenantId: a.tenantId,
            practiceId: sibling,
          },
          `WHERE ${PRACTICE_COLUMN[table] ?? "practice_id"}=$1`,
          [a.practiceId],
        );
        expect(n <= 0, `${table} visible from a sibling practice`).toBe(true);
      }
      // The worker is organisation-scoped: it sees the practice's rows.
      expect(
        await count(workerPool(), "scheduling.appointments", {
          tenantId: a.tenantId,
        }),
      ).toBe(1);
    });

    it("lets the worker read everything its jobs need within one organisation", async () => {
      // Notification planning, delivery, integrations and sweeps read these
      // under tenant context; a permission error here stops the worker.
      for (const table of [
        "directory.practices",
        "directory.practice_locations",
        "directory.patients",
        "directory.patient_contacts",
        "directory.patient_identifiers",
        "scheduling.practitioners",
        "scheduling.appointment_types",
        "scheduling.appointments",
        "scheduling.slot_holds",
        "scheduling.waitlist_entries",
        "scheduling.waitlist_offers",
        "messaging.notification_preferences",
        "messaging.notification_deliveries",
        "messaging.channel_conversations",
        "messaging.channel_messages",
        "integration.connections",
        "integration.events",
        "platform.outbox_events",
      ]) {
        const n = await count(workerPool(), table, { tenantId: a.tenantId });
        expect(n, `${table} unreadable by the worker`).toBeGreaterThanOrEqual(
          0,
        );
      }
      expect(
        await count(workerPool(), "directory.practices", {
          tenantId: a.tenantId,
        }),
      ).toBeGreaterThanOrEqual(1);
      // ...and never the workforce directory.
      expect(
        await count(workerPool(), "directory.practice_memberships", {
          tenantId: a.tenantId,
        }),
      ).toBe(-1);
    });

    it("refuses writes into another practice or organisation", async () => {
      await expect(
        tenantTx(
          a.tenantId,
          (c) =>
            c.query(
              `INSERT INTO scheduling.schedule_blocks(tenant_id,practice_id,id,practitioner_id,reason_code,starts_at,ends_at,created_by)
             VALUES($1,$2,$3,$4,'ADMIN',now(),now()+interval '1 hour','x')`,
              [b.tenantId, b.practiceId, randomUUID(), b.practitionerIds[0]],
            ),
          apiPool(),
          { practiceId: a.practiceId },
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        tenantTx(
          a.tenantId,
          (c) =>
            c.query(
              `INSERT INTO platform.audit_events(tenant_id,practice_id,actor_type,actor_id,action,resource_type,resource_id)
             VALUES($1,$2,'STAFF','user:x','forged.action','appointment','x')`,
              [a.tenantId, b.practiceId],
            ),
          apiPool(),
          { practiceId: a.practiceId },
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("gives the Supabase browser role nothing but its own practices' change signals", async () => {
      const member = randomUUID();
      await ownerPool().query(
        `INSERT INTO directory.practice_memberships(tenant_id,practice_id,user_id,role,status,display_name,created_by,updated_by)
       VALUES($1,$2,$3,'RECEPTIONIST','ACTIVE','Browser user','test','test')`,
        [a.tenantId, a.practiceId, member],
      );
      const asBrowser = async (role: "authenticated" | "anon", sql: string) => {
        const c = await ownerPool().connect();
        try {
          await c.query("BEGIN");
          await c.query(`SET LOCAL ROLE ${role}`);
          await c.query("SELECT set_config('request.jwt.claims',$1,true)", [
            JSON.stringify({ sub: member, role }),
          ]);
          return await c
            .query(sql)
            .then((r) => r.rows)
            .catch((e: Error) => e.message);
        } finally {
          await c.query("ROLLBACK").catch(() => undefined);
          c.release();
        }
      };
      const signals = await asBrowser(
        "authenticated",
        "SELECT practice_id FROM scheduling.schedule_signals",
      );
      expect(Array.isArray(signals)).toBe(true);
      expect(
        new Set(
          (signals as { practice_id: string }[]).map((s) => s.practice_id),
        ),
      ).toEqual(new Set([a.practiceId]));
      for (const sql of [
        "SELECT * FROM scheduling.appointments",
        "SELECT * FROM directory.patients",
        "UPDATE scheduling.schedule_signals SET seq=0",
        "INSERT INTO scheduling.appointments(tenant_id) VALUES(gen_random_uuid())",
      ])
        expect(await asBrowser("authenticated", sql)).toMatch(
          /permission denied/,
        );
      expect(
        await asBrowser("anon", "SELECT * FROM scheduling.schedule_signals"),
      ).toMatch(/permission denied/);
      const publication = await ownerPool().query(
        "SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname='supabase_realtime'",
      );
      expect(publication.rows).toEqual([
        { schemaname: "scheduling", tablename: "schedule_signals" },
      ]);
    });
  },
);
