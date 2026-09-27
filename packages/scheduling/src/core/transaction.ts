import type pg from "pg";
import { practiceTx, type DbClient } from "@access/db";
import { schedulingErrorFromDatabase, type CommandContext } from "./context.js";

/** The authenticated user id behind a staff actor ("user:<uuid>"). */
export function actorUserId(ctx: Pick<CommandContext, "actor">): string {
  return ctx.actor.id.startsWith("user:") ? ctx.actor.id.slice(5) : "";
}

/**
 * Run scheduling work in one practice-scoped transaction (RLS bound to the
 * tenant, practice, user and role), retrying deadlocks, and surfacing
 * database invariant violations as domain errors (e.g. an exclusion
 * violation as SLOT_UNAVAILABLE).
 */
export async function inPracticeTransaction<T>(
  pool: pg.Pool,
  ctx: Pick<CommandContext, "tenantId" | "practiceId" | "actor">,
  fn: (c: DbClient) => Promise<T>,
): Promise<T> {
  try {
    return await practiceTx(
      {
        tenantId: ctx.tenantId,
        practiceId: ctx.practiceId,
        userId: actorUserId(ctx),
        actorRole: ctx.actor.role,
      },
      fn,
      pool,
    );
  } catch (e) {
    throw schedulingErrorFromDatabase(e) ?? e;
  }
}
