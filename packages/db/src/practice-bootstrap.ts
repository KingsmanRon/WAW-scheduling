import type pg from "pg";
import { recordAuditEvent } from "./platform.js";
import { tenantTx } from "./runtime.js";
import { seedTenant } from "./seed-lib.js";

/**
 * Operator provisioning of a practice (runs with the migration/owner
 * credential; runtime roles cannot create practices). Creates the
 * organisation if needed, the practice with its IANA time zone, and the
 * first PRACTICE_ADMIN membership for a Supabase Auth user. Idempotent.
 */
export interface PracticeBootstrap {
  tenantId: string;
  tenantName: string;
  practiceId: string;
  practiceName: string;
  timezone: string;
  admin?: { userId: string; displayName: string; email?: string | null };
}
export async function bootstrapPractice(
  owner: pg.Pool,
  input: PracticeBootstrap,
): Promise<void> {
  await seedTenant(owner, {
    id: input.tenantId,
    name: input.tenantName,
    destinationMode: "MANUAL",
  });
  await tenantTx(
    input.tenantId,
    async (c) => {
      const created = await c.query(
        `INSERT INTO directory.practices(tenant_id,id,name,timezone) VALUES($1,$2,$3,$4)
         ON CONFLICT (tenant_id,id) DO NOTHING RETURNING id`,
        [input.tenantId, input.practiceId, input.practiceName, input.timezone],
      );
      if (created.rowCount)
        await recordAuditEvent(c, {
          tenantId: input.tenantId,
          practiceId: input.practiceId,
          actor: { type: "OPERATOR", id: "operator:bootstrap" },
          action: "practice.created",
          resourceType: "practice",
          resourceId: input.practiceId,
          changes: {
            after: { name: input.practiceName, timezone: input.timezone },
          },
        });
      if (input.admin) {
        await c.query(
          `INSERT INTO directory.practice_memberships(tenant_id,practice_id,user_id,role,status,display_name,email,created_by,updated_by)
           VALUES($1,$2,$3,'PRACTICE_ADMIN','ACTIVE',$4,$5,'operator:bootstrap','operator:bootstrap')
           ON CONFLICT (tenant_id,practice_id,user_id) DO UPDATE
             SET role='PRACTICE_ADMIN', status='ACTIVE', updated_by='operator:bootstrap', version=directory.practice_memberships.version+1`,
          [
            input.tenantId,
            input.practiceId,
            input.admin.userId,
            input.admin.displayName,
            input.admin.email ?? null,
          ],
        );
        await recordAuditEvent(c, {
          tenantId: input.tenantId,
          practiceId: input.practiceId,
          actor: { type: "OPERATOR", id: "operator:bootstrap" },
          action: "membership.upserted",
          resourceType: "user",
          resourceId: input.admin.userId,
          changes: { after: { role: "PRACTICE_ADMIN", status: "ACTIVE" } },
        });
      }
    },
    owner,
    { actorRole: "PRACTICE_ADMIN", practiceId: input.practiceId },
  );
}
