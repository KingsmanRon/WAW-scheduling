import { createHash } from "node:crypto";
import { canonicalJson, type ActorType, type Subject } from "@access/contracts";
import type { DbClient } from "./runtime.js";

/**
 * Per-case SHA-256 evidence chain. Version 1 rows were written before the
 * case aggregate existed and are keyed by referral; version 2 rows bind the
 * tenant, case, subject and actor. Both verify in one continuous chain.
 */

// Exact pre-v1.1 canonicalisation; kept verbatim so v1 rows still verify.
function legacyStable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(legacyStable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${legacyStable(object[k])}`)
    .join(",")}}`;
}
export function legacyEvidenceHash(input: {
  referralId: string;
  sequence: number;
  aggregateVersion: number;
  eventType: string;
  payload: unknown;
  previousHash: string;
  correlationId: string;
  createdAt: Date;
}): string {
  return createHash("sha256")
    .update(
      legacyStable({
        referral_id: input.referralId,
        sequence: input.sequence,
        aggregate_version: input.aggregateVersion,
        event_type: input.eventType,
        payload: input.payload,
        previous_hash: input.previousHash,
        correlation_id: input.correlationId,
        created_at: input.createdAt.toISOString(),
      }),
    )
    .digest("hex");
}

export interface EvidenceActor {
  type: ActorType;
  id: string;
}
export interface EvidenceInput {
  tenantId: string;
  caseId: string;
  subject: Subject;
  aggregateVersion: number;
  eventType: string;
  payload: object;
  correlationId: string;
  actor: EvidenceActor;
  createdAt?: Date;
}
export function evidenceHashV2(
  input: EvidenceInput & {
    sequence: number;
    previousHash: string;
    createdAt: Date;
  },
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        hash_version: 2,
        tenant_id: input.tenantId,
        case_id: input.caseId,
        subject_type: input.subject.type,
        subject_id: input.subject.id,
        sequence: input.sequence,
        aggregate_version: input.aggregateVersion,
        event_type: input.eventType,
        payload: input.payload,
        previous_hash: input.previousHash,
        correlation_id: input.correlationId,
        actor_type: input.actor.type,
        actor_id: input.actor.id,
        created_at: input.createdAt.toISOString(),
      }),
    )
    .digest("hex");
}

/** JSON round-trip so the hashed payload equals what jsonb stores. */
function normalise(payload: object): object {
  return JSON.parse(JSON.stringify(payload)) as object;
}

export async function appendEvidence(c: DbClient, input: EvidenceInput) {
  // Serialise appends per case so sequence and previous_hash never fork.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${input.tenantId}:case:${input.caseId}`,
  ]);
  const prior = await c.query<{ sequence: number; hash: string }>(
    "SELECT sequence,hash FROM evidence_events WHERE tenant_id=$1 AND case_id=$2 ORDER BY sequence DESC LIMIT 1",
    [input.tenantId, input.caseId],
  );
  const sequence = (prior.rows[0]?.sequence ?? 0) + 1;
  const previousHash = prior.rows[0]?.hash ?? "GENESIS";
  const createdAt = input.createdAt ?? new Date();
  const payload = normalise(input.payload);
  const hash = evidenceHashV2({
    ...input,
    payload,
    sequence,
    previousHash,
    createdAt,
  });
  await c.query(
    `INSERT INTO evidence_events(tenant_id,case_id,subject_type,subject_id,referral_id,sequence,aggregate_version,event_type,payload,previous_hash,hash,correlation_id,actor_type,actor_id,hash_version,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,2,$15)`,
    [
      input.tenantId,
      input.caseId,
      input.subject.type,
      input.subject.id,
      input.subject.type === "referral" ? input.subject.id : null,
      sequence,
      input.aggregateVersion,
      input.eventType,
      payload,
      previousHash,
      hash,
      input.correlationId,
      input.actor.type,
      input.actor.id,
      createdAt,
    ],
  );
  return { sequence, previousHash, hash };
}

export interface ChainVerification {
  valid: boolean;
  events: number;
  head: string;
  failure?: { sequence: number; reason: string };
}
export async function verifyEvidenceChain(
  c: DbClient,
  tenantId: string,
  caseId: string,
): Promise<ChainVerification> {
  const rows = await c.query<{
    sequence: number;
    aggregate_version: number;
    event_type: string;
    payload: object;
    previous_hash: string;
    hash: string;
    correlation_id: string;
    created_at: Date;
    hash_version: number;
    referral_id: string | null;
    subject_type: "referral" | "case";
    subject_id: string;
    actor_type: ActorType;
    actor_id: string;
  }>(
    `SELECT sequence,aggregate_version,event_type,payload,previous_hash,hash,correlation_id,created_at,
            hash_version,referral_id,subject_type,subject_id,actor_type,actor_id
       FROM evidence_events WHERE tenant_id=$1 AND case_id=$2 ORDER BY sequence`,
    [tenantId, caseId],
  );
  let previousHash = "GENESIS";
  let sequence = 1;
  for (const row of rows.rows) {
    if (row.sequence !== sequence)
      return fail(rows.rowCount ?? 0, previousHash, sequence, "sequence gap");
    if (row.previous_hash !== previousHash)
      return fail(rows.rowCount ?? 0, previousHash, sequence, "broken link");
    const createdAt = new Date(row.created_at);
    const expected =
      row.hash_version === 1
        ? legacyEvidenceHash({
            referralId: row.referral_id ?? "",
            sequence,
            aggregateVersion: row.aggregate_version,
            eventType: row.event_type,
            payload: row.payload,
            previousHash,
            correlationId: row.correlation_id,
            createdAt,
          })
        : evidenceHashV2({
            tenantId,
            caseId,
            subject: { type: row.subject_type, id: row.subject_id },
            sequence,
            aggregateVersion: row.aggregate_version,
            eventType: row.event_type,
            payload: row.payload,
            previousHash,
            correlationId: row.correlation_id,
            actor: { type: row.actor_type, id: row.actor_id },
            createdAt,
          });
    if (row.hash !== expected)
      return fail(rows.rowCount ?? 0, previousHash, sequence, "hash mismatch");
    previousHash = row.hash;
    sequence++;
  }
  return { valid: true, events: rows.rowCount ?? 0, head: previousHash };
}
function fail(
  events: number,
  head: string,
  sequence: number,
  reason: string,
): ChainVerification {
  return { valid: false, events, head, failure: { sequence, reason } };
}
