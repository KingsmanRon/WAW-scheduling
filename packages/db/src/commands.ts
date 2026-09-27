import { createHash } from "node:crypto";
import {
  canonicalJson,
  type ActorType,
  type CommandType,
  type StaffRole,
  type Subject,
} from "@access/contracts";
import { AppError, type DbClient } from "./runtime.js";

/** Fingerprint of the material request content bound to a command_id. */
export function requestHash(material: unknown): string {
  return createHash("sha256").update(canonicalJson(material)).digest("hex");
}

export class IdempotencyConflictError extends AppError {
  constructor() {
    super(
      409,
      "IDEMPOTENCY_CONFLICT",
      "command_id was already used for a materially different request",
    );
  }
}

export interface CommandEnvelope {
  tenantId: string;
  commandId: string;
  type: CommandType;
  requestHash: string;
  actor: { type: ActorType; id: string; role: StaffRole | null };
  caseId?: string | null;
  subject?: Subject | null;
}
export type Replayed<T> = T & { deduplicated: boolean };

interface StoredCommand {
  result_json: Record<string, unknown>;
  request_hash: string | null;
  command_type: string;
}
export async function findCommand(
  c: DbClient,
  tenantId: string,
  commandId: string,
): Promise<StoredCommand | undefined> {
  const prior = await c.query<StoredCommand>(
    "SELECT result_json,request_hash,command_type FROM commands WHERE tenant_id=$1 AND command_id=$2",
    [tenantId, commandId],
  );
  return prior.rows[0];
}
/** Replay rule shared by the pre-check and the transactional check. */
export function replay<T>(
  stored: StoredCommand,
  envelope: Pick<CommandEnvelope, "requestHash" | "type">,
): Replayed<T> {
  // Legacy (pre-v1.1) commands carry no fingerprint and replay their result.
  if (
    stored.command_type !== "legacy.v1" &&
    (stored.command_type !== envelope.type ||
      stored.request_hash !== envelope.requestHash)
  )
    throw new IdempotencyConflictError();
  return { ...(stored.result_json as T), deduplicated: true };
}

/**
 * Execute a command at most once. Duplicate command_ids replay the original
 * business result without running the handler, so no state, work item,
 * interaction, evidence, execution or artifact is created twice; a reused
 * command_id with a different request fingerprint is a conflict.
 */
export async function executeCommand<T extends object>(
  c: DbClient,
  envelope: CommandEnvelope,
  handler: () => Promise<T>,
): Promise<Replayed<T>> {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${envelope.tenantId}:command:${envelope.commandId}`,
  ]);
  const stored = await findCommand(c, envelope.tenantId, envelope.commandId);
  if (stored) return replay<T>(stored, envelope);
  const result = await handler();
  const resultCase = (result as { case_id?: unknown }).case_id;
  const caseId =
    envelope.caseId ?? (typeof resultCase === "string" ? resultCase : null);
  await c.query(
    `INSERT INTO commands(tenant_id,command_id,referral_id,case_id,subject_type,subject_id,command_type,request_hash,actor_type,actor_id,actor_role,result_json)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      envelope.tenantId,
      envelope.commandId,
      envelope.subject?.type === "referral" ? envelope.subject.id : null,
      caseId,
      envelope.subject?.type ?? null,
      envelope.subject?.id ?? null,
      envelope.type,
      envelope.requestHash,
      envelope.actor.type,
      envelope.actor.id,
      envelope.actor.role,
      result,
    ],
  );
  return { ...result, deduplicated: false };
}
