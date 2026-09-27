import { randomUUID } from "node:crypto";
import type { DbClient } from "@access/db";
import {
  SchedulingError,
  audit,
  type CommandContext,
  type Scope,
} from "@access/scheduling";
import {
  IdentifierHasher,
  identifierHint,
  normalizeEmail,
  normalizeName,
  requirePhone,
  validateIdentifier,
  type IdentifierSystem,
} from "./normalize.js";

/**
 * Practice patient registry. A patient is found by normalised contact points
 * and identifiers; similar names never merge records. Potential duplicates
 * (same number, e-mail, or name and date of birth) are recorded for staff
 * review. Audit records name the fields that changed, not their values, so
 * the audit trail does not become a second copy of demographics.
 */

export type SourceChannel =
  | "PHONE"
  | "WALK_IN"
  | "WHATSAPP"
  | "WEB"
  | "INTERNAL"
  | "REFERRAL"
  | "OTHER"
  | "IMPORT";
export interface ContactInput {
  kind: "MOBILE" | "EMAIL" | "LANDLINE";
  value: string;
  isPrimary?: boolean | undefined;
  whatsappCapable?: boolean | undefined;
  /** How the contact point was verified, if it was. */
  verifiedVia?: "WHATSAPP_INBOUND" | "STAFF" | undefined;
}
export interface IdentifierInput {
  system: IdentifierSystem;
  issuer: string;
  value: string;
}
export interface PatientInput {
  givenName: string;
  familyName: string;
  preferredName?: string | null | undefined;
  dateOfBirth?: string | null | undefined;
  administrativeSex?:
    "FEMALE" | "MALE" | "OTHER" | "UNKNOWN" | null | undefined;
  preferredLanguage?: string | undefined;
  sourceChannel: SourceChannel;
  identityVerification?: "UNVERIFIED" | "STAFF_VERIFIED" | undefined;
  contacts?: ContactInput[] | undefined;
  identifiers?: IdentifierInput[] | undefined;
}

export interface PatientSummary {
  id: string;
  patient_number: string;
  display_name: string;
  given_name: string;
  family_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  status: string;
  identity_verification: string;
  primary_mobile: string | null;
  primary_email: string | null;
}
const SUMMARY_SELECT = `p.id,p.patient_number,p.given_name,p.family_name,p.preferred_name,p.date_of_birth::text,p.status,
  p.identity_verification,
  (SELECT c.value FROM directory.patient_contacts c WHERE c.tenant_id=p.tenant_id AND c.practice_id=p.practice_id
     AND c.patient_id=p.id AND c.kind='MOBILE' AND c.removed_at IS NULL ORDER BY c.is_primary DESC, c.created_at LIMIT 1) AS primary_mobile,
  (SELECT c.value FROM directory.patient_contacts c WHERE c.tenant_id=p.tenant_id AND c.practice_id=p.practice_id
     AND c.patient_id=p.id AND c.kind='EMAIL' AND c.removed_at IS NULL ORDER BY c.is_primary DESC, c.created_at LIMIT 1) AS primary_email`;
function summary(r: Record<string, unknown>): PatientSummary {
  const given = r.given_name as string;
  const preferred = (r.preferred_name as string | null) ?? null;
  return {
    id: r.id as string,
    patient_number: r.patient_number as string,
    display_name: `${preferred ?? given} ${r.family_name as string}`,
    given_name: given,
    family_name: r.family_name as string,
    preferred_name: preferred,
    date_of_birth: (r.date_of_birth as string | null) ?? null,
    status: r.status as string,
    identity_verification: r.identity_verification as string,
    primary_mobile: (r.primary_mobile as string | null) ?? null,
    primary_email: (r.primary_email as string | null) ?? null,
  };
}

interface NormalizedContact {
  kind: "MOBILE" | "EMAIL" | "LANDLINE";
  value: string;
  isPrimary: boolean;
  whatsappCapable: boolean;
  verifiedVia: "WHATSAPP_INBOUND" | "STAFF" | null;
}
function normalizeContact(input: ContactInput): NormalizedContact {
  if (input.kind === "EMAIL") {
    const email = normalizeEmail(input.value);
    if (!email) throw new SchedulingError("CONTACT_INVALID");
    return {
      kind: "EMAIL",
      value: email,
      isPrimary: input.isPrimary ?? false,
      whatsappCapable: false,
      verifiedVia: input.verifiedVia ?? null,
    };
  }
  const phone = requirePhone(input.value);
  const kind = input.kind === "LANDLINE" ? "LANDLINE" : phone.kind;
  return {
    kind,
    value: phone.e164,
    isPrimary: input.isPrimary ?? false,
    whatsappCapable: kind === "MOBILE" && (input.whatsappCapable ?? true),
    verifiedVia: input.verifiedVia ?? null,
  };
}

async function nextPatientNumber(c: DbClient, s: Scope): Promise<string> {
  const row = await c.query<{ value: string }>(
    `INSERT INTO directory.practice_counters(tenant_id,practice_id,counter,value) VALUES($1,$2,'patient_number',1)
     ON CONFLICT (tenant_id,practice_id,counter) DO UPDATE SET value=directory.practice_counters.value+1
     RETURNING value::text`,
    [s.tenantId, s.practiceId],
  );
  return `P${row.rows[0]!.value.padStart(6, "0")}`;
}

async function insertContact(
  c: DbClient,
  ctx: CommandContext,
  patientId: string,
  contact: NormalizedContact,
): Promise<string> {
  const id = randomUUID();
  if (contact.isPrimary)
    await c.query(
      `UPDATE directory.patient_contacts SET is_primary=false
        WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 AND kind=$4 AND is_primary AND removed_at IS NULL`,
      [ctx.tenantId, ctx.practiceId, patientId, contact.kind],
    );
  const inserted = await c.query(
    `INSERT INTO directory.patient_contacts(tenant_id,practice_id,id,patient_id,kind,value,is_primary,whatsapp_capable,
        verified_at,verification_method,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9::text IS NULL THEN NULL ELSE now() END,$9,$10)
     ON CONFLICT (tenant_id,practice_id,patient_id,kind,value) WHERE removed_at IS NULL DO NOTHING
     RETURNING id`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      patientId,
      contact.kind,
      contact.value,
      contact.isPrimary,
      contact.whatsappCapable,
      contact.verifiedVia,
      ctx.actor.id,
    ],
  );
  return inserted.rows[0]?.id ?? id;
}

async function insertIdentifier(
  c: DbClient,
  ctx: CommandContext,
  patientId: string,
  input: IdentifierInput,
  hasher: IdentifierHasher,
): Promise<void> {
  const issuer = input.issuer.toUpperCase();
  const canonical = validateIdentifier(input.system, issuer, input.value);
  const digest = hasher.digest(input.system, issuer, canonical);
  const existing = await c.query<{ patient_id: string }>(
    `SELECT patient_id FROM directory.patient_identifiers
      WHERE tenant_id=$1 AND practice_id=$2 AND system=$3 AND issuer=$4 AND value_hash=$5 AND removed_at IS NULL`,
    [ctx.tenantId, ctx.practiceId, input.system, issuer, digest],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].patient_id === patientId) return;
    throw new SchedulingError("PATIENT_IDENTIFIER_EXISTS", undefined, {
      patient_id: existing.rows[0].patient_id,
    });
  }
  await c.query(
    `INSERT INTO directory.patient_identifiers(tenant_id,practice_id,id,patient_id,system,issuer,value_hash,hash_key_id,value,value_hint,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      randomUUID(),
      patientId,
      input.system,
      issuer,
      digest,
      hasher.keyId,
      input.system === "EXTERNAL" ? canonical : null,
      identifierHint(input.system, canonical),
      ctx.actor.id,
    ],
  );
}

/** Record potential duplicates of a patient (never merges anything). */
async function detectDuplicates(
  c: DbClient,
  ctx: CommandContext,
  patientId: string,
): Promise<{ patient_id: string; reasons: string[] }[]> {
  const rows = await c.query<{ candidate: string; reasons: string[] }>(
    `WITH me AS (
       SELECT p.* FROM directory.patients p WHERE p.tenant_id=$1 AND p.practice_id=$2 AND p.id=$3),
     contact_matches AS (
       SELECT other.patient_id AS candidate, CASE mine.kind WHEN 'EMAIL' THEN 'EMAIL' ELSE 'MOBILE' END AS reason
         FROM directory.patient_contacts mine
         JOIN directory.patient_contacts other ON other.tenant_id=mine.tenant_id AND other.practice_id=mine.practice_id
              AND other.kind=mine.kind AND other.value=mine.value AND other.patient_id<>mine.patient_id AND other.removed_at IS NULL
        WHERE mine.tenant_id=$1 AND mine.practice_id=$2 AND mine.patient_id=$3 AND mine.removed_at IS NULL
          AND mine.kind IN ('MOBILE','EMAIL')),
     name_matches AS (
       SELECT o.id AS candidate, 'NAME_AND_DATE_OF_BIRTH' AS reason
         FROM directory.patients o, me
        WHERE o.tenant_id=$1 AND o.practice_id=$2 AND o.id<>me.id AND me.date_of_birth IS NOT NULL
          AND o.date_of_birth=me.date_of_birth AND o.family_name_key=me.family_name_key AND o.given_name_key=me.given_name_key)
     SELECT candidate, array_agg(DISTINCT reason ORDER BY reason) AS reasons
       FROM (SELECT * FROM contact_matches UNION ALL SELECT * FROM name_matches) m
      GROUP BY candidate`,
    [ctx.tenantId, ctx.practiceId, patientId],
  );
  for (const r of rows.rows)
    await c.query(
      `INSERT INTO directory.patient_duplicate_candidates(tenant_id,practice_id,id,patient_id,candidate_patient_id,reasons)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,practice_id,LEAST(patient_id,candidate_patient_id),GREATEST(patient_id,candidate_patient_id))
       DO NOTHING`,
      [
        ctx.tenantId,
        ctx.practiceId,
        randomUUID(),
        patientId,
        r.candidate,
        r.reasons,
      ],
    );
  return rows.rows.map((r) => ({
    patient_id: r.candidate,
    reasons: r.reasons,
  }));
}

export async function createPatient(
  c: DbClient,
  ctx: CommandContext,
  input: PatientInput,
  hasher: IdentifierHasher,
): Promise<{
  patient: PatientSummary;
  possible_duplicates: { patient_id: string; reasons: string[] }[];
}> {
  const givenName = normalizeName(input.givenName);
  const familyName = normalizeName(input.familyName);
  if (!givenName || !familyName) throw new SchedulingError("PATIENT_INVALID");
  const contacts = (input.contacts ?? []).map(normalizeContact);
  const id = randomUUID();
  const patientNumber = await nextPatientNumber(c, ctx);
  await c.query(
    `INSERT INTO directory.patients(tenant_id,practice_id,id,patient_number,given_name,family_name,preferred_name,date_of_birth,
        administrative_sex,preferred_language,identity_verification,source_channel,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      patientNumber,
      givenName,
      familyName,
      input.preferredName ? normalizeName(input.preferredName) : null,
      input.dateOfBirth ?? null,
      input.administrativeSex ?? null,
      input.preferredLanguage ?? "en",
      input.identityVerification ?? "UNVERIFIED",
      input.sourceChannel,
      ctx.actor.id,
    ],
  );
  const seenKinds = new Set<string>();
  for (const contact of contacts) {
    // The first contact of each kind is primary unless stated otherwise.
    const primary = contact.isPrimary || !seenKinds.has(contact.kind);
    seenKinds.add(contact.kind);
    await insertContact(c, ctx, id, { ...contact, isPrimary: primary });
  }
  for (const identifier of input.identifiers ?? [])
    await insertIdentifier(c, ctx, id, identifier, hasher);
  const duplicates = await detectDuplicates(c, ctx, id);
  await audit(c, ctx, {
    action: "patient.created",
    resourceType: "patient",
    resourceId: id,
    after: {
      patient_number: patientNumber,
      source_channel: input.sourceChannel,
      fields: Object.keys(input).filter(
        (k) => input[k as keyof PatientInput] !== undefined,
      ),
      possible_duplicates: duplicates.length,
    },
  });
  return {
    patient: await getPatientSummary(c, ctx, id),
    possible_duplicates: duplicates,
  };
}

export async function getPatientSummary(
  c: DbClient,
  s: Scope,
  id: string,
): Promise<PatientSummary> {
  const row = await c.query(
    `SELECT ${SUMMARY_SELECT} FROM directory.patients p WHERE p.tenant_id=$1 AND p.practice_id=$2 AND p.id=$3`,
    [s.tenantId, s.practiceId, id],
  );
  if (!row.rows[0]) throw new SchedulingError("PATIENT_NOT_FOUND");
  return summary(row.rows[0]);
}

export async function getPatientDetail(c: DbClient, s: Scope, id: string) {
  const base = await c.query(
    `SELECT ${SUMMARY_SELECT},p.administrative_sex,p.preferred_language,p.source_channel,p.version,p.created_at,p.updated_at
       FROM directory.patients p WHERE p.tenant_id=$1 AND p.practice_id=$2 AND p.id=$3`,
    [s.tenantId, s.practiceId, id],
  );
  if (!base.rows[0]) throw new SchedulingError("PATIENT_NOT_FOUND");
  const contacts = await c.query(
    `SELECT id,kind,value,is_primary,whatsapp_capable,verified_at,verification_method,created_at
       FROM directory.patient_contacts WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 AND removed_at IS NULL
      ORDER BY kind, is_primary DESC, created_at`,
    [s.tenantId, s.practiceId, id],
  );
  const identifiers = await c.query(
    `SELECT id,system,issuer,value,value_hint,created_at FROM directory.patient_identifiers
      WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 AND removed_at IS NULL ORDER BY system, created_at`,
    [s.tenantId, s.practiceId, id],
  );
  const duplicates = await c.query(
    `SELECT id, CASE WHEN patient_id=$3 THEN candidate_patient_id ELSE patient_id END AS other_patient_id, reasons, detected_at
       FROM directory.patient_duplicate_candidates
      WHERE tenant_id=$1 AND practice_id=$2 AND status='OPEN' AND (patient_id=$3 OR candidate_patient_id=$3)`,
    [s.tenantId, s.practiceId, id],
  );
  const r = base.rows[0];
  return {
    ...summary(r),
    administrative_sex: r.administrative_sex,
    preferred_language: r.preferred_language,
    source_channel: r.source_channel,
    version: r.version,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    contacts: contacts.rows,
    identifiers: identifiers.rows.map((i) => ({
      id: i.id,
      system: i.system,
      issuer: i.issuer,
      // National ID and passport numbers are never returned, only a hint.
      value: i.system === "EXTERNAL" ? i.value : null,
      hint: i.value_hint,
      created_at: i.created_at,
    })),
    possible_duplicates: duplicates.rows,
  };
}

export interface PatientSearch {
  text?: string | undefined;
  mobile?: string | undefined;
  email?: string | undefined;
  patientNumber?: string | undefined;
  nationalId?: string | undefined;
  passport?: { issuer: string; value: string } | undefined;
  dateOfBirth?: string | undefined;
  includeArchived?: boolean | undefined;
  limit: number;
  /** Keyset cursor from the previous page. */
  cursor?: string | undefined;
}
/**
 * Exact search on normalised identifiers, or name-prefix search
 * ("smi", "john smi", "smith, jo") ordered by family then given name,
 * keyset-paginated. Never scans or returns the whole registry.
 */
export async function searchPatients(
  c: DbClient,
  s: Scope,
  q: PatientSearch,
  hasher: IdentifierHasher,
): Promise<{ items: PatientSummary[]; next: string | null }> {
  const where: string[] = ["p.tenant_id=$1", "p.practice_id=$2"];
  const params: unknown[] = [s.tenantId, s.practiceId];
  const add = (sql: string, ...values: unknown[]) => {
    let out = sql;
    for (const v of values) {
      params.push(v);
      out = out.replace("?", `$${params.length}`);
    }
    where.push(out);
  };
  if (!q.includeArchived) where.push("p.status='ACTIVE'");
  let exact = false;
  if (q.mobile) {
    const phone = requirePhone(q.mobile);
    exact = true;
    add(
      `EXISTS (SELECT 1 FROM directory.patient_contacts c WHERE c.tenant_id=p.tenant_id AND c.practice_id=p.practice_id
        AND c.patient_id=p.id AND c.kind IN ('MOBILE','LANDLINE') AND c.value=? AND c.removed_at IS NULL)`,
      phone.e164,
    );
  }
  if (q.email) {
    const email = normalizeEmail(q.email);
    if (!email) throw new SchedulingError("CONTACT_INVALID");
    exact = true;
    add(
      `EXISTS (SELECT 1 FROM directory.patient_contacts c WHERE c.tenant_id=p.tenant_id AND c.practice_id=p.practice_id
        AND c.patient_id=p.id AND c.kind='EMAIL' AND c.value=? AND c.removed_at IS NULL)`,
      email,
    );
  }
  if (q.patientNumber) {
    exact = true;
    add("p.patient_number=?", q.patientNumber.trim().toUpperCase());
  }
  const identifierSearch = q.nationalId
    ? { system: "NATIONAL_ID" as const, issuer: "ZA", value: q.nationalId }
    : q.passport
      ? {
          system: "PASSPORT" as const,
          issuer: q.passport.issuer.toUpperCase(),
          value: q.passport.value,
        }
      : null;
  if (identifierSearch) {
    const canonical = validateIdentifier(
      identifierSearch.system,
      identifierSearch.issuer,
      identifierSearch.value,
    );
    exact = true;
    add(
      `EXISTS (SELECT 1 FROM directory.patient_identifiers i WHERE i.tenant_id=p.tenant_id AND i.practice_id=p.practice_id
        AND i.patient_id=p.id AND i.system=? AND i.issuer=? AND i.value_hash=? AND i.removed_at IS NULL)`,
      identifierSearch.system,
      identifierSearch.issuer,
      hasher.digest(
        identifierSearch.system,
        identifierSearch.issuer,
        canonical,
      ),
    );
  }
  if (q.dateOfBirth) add("p.date_of_birth=?::date", q.dateOfBirth);
  if (q.text) {
    const tokens = normalizeName(q.text.replace(",", " "))
      .toLowerCase()
      .split(" ")
      .filter(Boolean)
      .slice(0, 3)
      .map((t) => t.replace(/[%_\\]/g, ""));
    if (tokens.length === 1)
      add(
        "(p.family_name_key LIKE ? OR p.given_name_key LIKE ?)",
        `${tokens[0]}%`,
        `${tokens[0]}%`,
      );
    else if (tokens.length >= 2)
      add(
        "((p.given_name_key LIKE ? AND p.family_name_key LIKE ?) OR (p.family_name_key LIKE ? AND p.given_name_key LIKE ?))",
        `${tokens[0]}%`,
        `${tokens[tokens.length - 1]}%`,
        `${tokens[0]}%`,
        `${tokens[tokens.length - 1]}%`,
      );
  } else if (!exact && !q.dateOfBirth)
    throw new SchedulingError("SEARCH_CRITERIA_REQUIRED");
  if (q.cursor) {
    const [family, given, id] = Buffer.from(q.cursor, "base64url")
      .toString("utf8")
      .split("\u0000");
    add(
      "(p.family_name_key,p.given_name_key,p.id) > (?,?,?::uuid)",
      family,
      given,
      id,
    );
  }
  params.push(q.limit + 1);
  const rows = await c.query(
    `SELECT ${SUMMARY_SELECT}, p.family_name_key, p.given_name_key FROM directory.patients p
      WHERE ${where.join(" AND ")}
      ORDER BY p.family_name_key, p.given_name_key, p.id LIMIT $${params.length}`,
    params,
  );
  const page = rows.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(summary),
    next:
      rows.rows.length > q.limit && last
        ? Buffer.from(
            `${last.family_name_key}\u0000${last.given_name_key}\u0000${last.id}`,
          ).toString("base64url")
        : null,
  };
}

/** Patients reachable at a phone number (e.g. a WhatsApp sender). */
export async function patientsByPhone(
  c: DbClient,
  s: Scope,
  e164: string,
): Promise<PatientSummary[]> {
  const rows = await c.query(
    `SELECT ${SUMMARY_SELECT} FROM directory.patients p
      WHERE p.tenant_id=$1 AND p.practice_id=$2 AND p.status='ACTIVE'
        AND EXISTS (SELECT 1 FROM directory.patient_contacts c WHERE c.tenant_id=p.tenant_id AND c.practice_id=p.practice_id
                     AND c.patient_id=p.id AND c.kind='MOBILE' AND c.value=$3 AND c.removed_at IS NULL)
      ORDER BY p.created_at, p.id LIMIT 10`,
    [s.tenantId, s.practiceId, e164],
  );
  return rows.rows.map(summary);
}

export interface PatientPatch {
  givenName?: string | undefined;
  familyName?: string | undefined;
  preferredName?: string | null | undefined;
  dateOfBirth?: string | null | undefined;
  administrativeSex?:
    "FEMALE" | "MALE" | "OTHER" | "UNKNOWN" | null | undefined;
  preferredLanguage?: string | undefined;
  identityVerification?: "UNVERIFIED" | "STAFF_VERIFIED" | undefined;
  status?: "ACTIVE" | "ARCHIVED" | undefined;
}
const PATIENT_COLUMNS: Record<keyof PatientPatch, string> = {
  givenName: "given_name",
  familyName: "family_name",
  preferredName: "preferred_name",
  dateOfBirth: "date_of_birth",
  administrativeSex: "administrative_sex",
  preferredLanguage: "preferred_language",
  identityVerification: "identity_verification",
  status: "status",
};
export async function updatePatient(
  c: DbClient,
  ctx: CommandContext,
  id: string,
  patch: PatientPatch,
  expectedVersion?: number,
): Promise<PatientSummary> {
  const current = await c.query<{ version: number }>(
    "SELECT version FROM directory.patients WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 FOR UPDATE",
    [ctx.tenantId, ctx.practiceId, id],
  );
  if (!current.rows[0]) throw new SchedulingError("PATIENT_NOT_FOUND");
  if (
    expectedVersion !== undefined &&
    current.rows[0].version !== expectedVersion
  )
    throw new SchedulingError("VERSION_CONFLICT");
  const sets: string[] = [];
  const values: unknown[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(PATIENT_COLUMNS) as (keyof PatientPatch)[]) {
    let value = patch[key];
    if (value === undefined) continue;
    if (
      (key === "givenName" ||
        key === "familyName" ||
        key === "preferredName") &&
      value
    )
      value = normalizeName(value);
    values.push(value);
    sets.push(`${PATIENT_COLUMNS[key]}=$${values.length + 3}`);
    changed.push(PATIENT_COLUMNS[key]);
  }
  if (sets.length) {
    await c.query(
      `UPDATE directory.patients SET ${sets.join(",")}, version=version+1 WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
      [ctx.tenantId, ctx.practiceId, id, ...values],
    );
    await audit(c, ctx, {
      action: "patient.updated",
      resourceType: "patient",
      resourceId: id,
      after: { fields: changed },
    });
    if (
      changed.some((f) =>
        ["given_name", "family_name", "date_of_birth"].includes(f),
      )
    )
      await detectDuplicates(c, ctx, id);
  }
  return getPatientSummary(c, ctx, id);
}

export async function addPatientContact(
  c: DbClient,
  ctx: CommandContext,
  patientId: string,
  input: ContactInput,
): Promise<string> {
  await getPatientSummary(c, ctx, patientId);
  const id = await insertContact(c, ctx, patientId, normalizeContact(input));
  await audit(c, ctx, {
    action: "patient.contact_added",
    resourceType: "patient",
    resourceId: patientId,
    after: { contact_id: id, kind: input.kind },
  });
  await detectDuplicates(c, ctx, patientId);
  return id;
}

export async function removePatientContact(
  c: DbClient,
  ctx: CommandContext,
  patientId: string,
  contactId: string,
): Promise<void> {
  const removed = await c.query(
    `UPDATE directory.patient_contacts SET removed_at=now(), removed_by=$5, is_primary=false
      WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 AND id=$4 AND removed_at IS NULL RETURNING kind`,
    [ctx.tenantId, ctx.practiceId, patientId, contactId, ctx.actor.id],
  );
  if (!removed.rows[0]) throw new SchedulingError("CONTACT_NOT_FOUND");
  await audit(c, ctx, {
    action: "patient.contact_removed",
    resourceType: "patient",
    resourceId: patientId,
    before: { contact_id: contactId, kind: removed.rows[0].kind },
  });
}

export async function addPatientIdentifier(
  c: DbClient,
  ctx: CommandContext,
  patientId: string,
  input: IdentifierInput,
  hasher: IdentifierHasher,
): Promise<void> {
  await getPatientSummary(c, ctx, patientId);
  await insertIdentifier(c, ctx, patientId, input, hasher);
  await audit(c, ctx, {
    action: "patient.identifier_added",
    resourceType: "patient",
    resourceId: patientId,
    after: { system: input.system, issuer: input.issuer.toUpperCase() },
  });
}

export async function listDuplicateCandidates(
  c: DbClient,
  s: Scope,
  q: { status: "OPEN" | "DISMISSED" | "CONFIRMED"; limit: number },
) {
  const rows = await c.query(
    `SELECT d.id,d.reasons,d.status,d.detected_at,d.reviewed_by,d.reviewed_at,
            a.id AS a_id,a.patient_number AS a_number,a.given_name AS a_given,a.family_name AS a_family,a.date_of_birth::text AS a_dob,
            b.id AS b_id,b.patient_number AS b_number,b.given_name AS b_given,b.family_name AS b_family,b.date_of_birth::text AS b_dob
       FROM directory.patient_duplicate_candidates d
       JOIN directory.patients a ON a.tenant_id=d.tenant_id AND a.practice_id=d.practice_id AND a.id=d.patient_id
       JOIN directory.patients b ON b.tenant_id=d.tenant_id AND b.practice_id=d.practice_id AND b.id=d.candidate_patient_id
      WHERE d.tenant_id=$1 AND d.practice_id=$2 AND d.status=$3
      ORDER BY d.detected_at DESC, d.id LIMIT $4`,
    [s.tenantId, s.practiceId, q.status, q.limit],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    reasons: r.reasons,
    status: r.status,
    detected_at: r.detected_at,
    reviewed_by: r.reviewed_by,
    reviewed_at: r.reviewed_at,
    patients: [
      {
        id: r.a_id,
        patient_number: r.a_number,
        display_name: `${r.a_given} ${r.a_family}`,
        date_of_birth: r.a_dob,
      },
      {
        id: r.b_id,
        patient_number: r.b_number,
        display_name: `${r.b_given} ${r.b_family}`,
        date_of_birth: r.b_dob,
      },
    ],
  }));
}

/** Staff decision on a potential duplicate. Records are never merged here. */
export async function reviewDuplicate(
  c: DbClient,
  ctx: CommandContext,
  id: string,
  decision: "DISMISSED" | "CONFIRMED",
): Promise<void> {
  const updated = await c.query(
    `UPDATE directory.patient_duplicate_candidates SET status=$4, reviewed_by=$5, reviewed_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND status='OPEN' RETURNING patient_id,candidate_patient_id`,
    [ctx.tenantId, ctx.practiceId, id, decision, ctx.actor.id],
  );
  if (!updated.rows[0]) throw new SchedulingError("DUPLICATE_REVIEW_NOT_FOUND");
  await audit(c, ctx, {
    action: "patient.duplicate_reviewed",
    resourceType: "patient_duplicate",
    resourceId: id,
    after: {
      decision,
      patients: [
        updated.rows[0].patient_id,
        updated.rows[0].candidate_patient_id,
      ],
    },
  });
}
