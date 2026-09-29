import { randomUUID } from "node:crypto";
import type { DbClient } from "@access/db";
import { SchedulingError } from "../domain/errors.js";
import type { CommandContext } from "./context.js";
import { audit, emit } from "./effects.js";
import { patientDisplayName } from "./queries.js";
import { loadAppointmentType, type Scope } from "./repository.js";

/**
 * The practice's referral register: the administrative record that
 * authorises booking appointment types that require a referral. Booking
 * enforces it (see policy.ts): the referral must belong to the patient,
 * cover the type, be verified where the practice requires it, be valid on
 * the appointment date and have visits left. Referral letters are stored
 * encrypted in private storage (API); only their metadata lives here, and
 * nothing here holds clinical content.
 */
export const REFERRAL_REJECTION_REASONS = [
  "EXPIRED",
  "INCOMPLETE",
  "WRONG_PATIENT",
  "NOT_APPLICABLE",
  "OTHER",
] as const;
export type ReferralRejectionReason =
  (typeof REFERRAL_REJECTION_REASONS)[number];

export interface ReferralInput {
  patientId: string;
  referringPractitionerName: string;
  referringPracticeName?: string | null | undefined;
  referringPracticeNumber?: string | null | undefined;
  /** ISO dates (YYYY-MM-DD). */
  referralDate?: string | null | undefined;
  validUntil?: string | null | undefined;
  appointmentTypeId?: string | null | undefined;
  maxAppointments?: number | null | undefined;
}

export interface ReferralView {
  id: string;
  status: "RECEIVED" | "VERIFIED" | "REJECTED" | "CANCELLED";
  patient: { id: string; display_name: string; patient_number: string };
  referring_practitioner_name: string;
  referring_practice_name: string | null;
  referring_practice_number: string | null;
  referral_date: string | null;
  valid_until: string | null;
  appointment_type: { id: string; name: string } | null;
  max_appointments: number | null;
  appointments_used: number;
  source_channel: string;
  received_at: string;
  verified_at: string | null;
  verified_by: string | null;
  rejection_reason_code: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  document_count: number;
  version: number;
}
export interface ReferralDocumentView {
  id: string;
  document_type: "REFERRAL_LETTER" | "SUPPORTING_DOCUMENT";
  media_type: string;
  size_bytes: number;
  uploaded_by: string;
  created_at: string;
}

const VIEW = `SELECT r.id, r.status, r.patient_id, p.given_name, p.family_name, p.preferred_name, p.patient_number,
    r.referring_practitioner_name, r.referring_practice_name, r.referring_practice_number,
    r.referral_date::text AS referral_date, r.valid_until::text AS valid_until, r.appointment_type_id,
    t.name AS appointment_type_name, r.max_appointments, r.source_channel, r.received_at, r.verified_at,
    r.verified_by, r.rejection_reason_code, r.rejected_at, r.cancelled_at, r.version,
    (SELECT count(*)::int FROM scheduling.appointments a
      WHERE a.tenant_id=r.tenant_id AND a.practice_id=r.practice_id AND a.referral_id=r.id
        AND a.status NOT IN ('CANCELLED','EXPIRED','RESCHEDULED')
        AND (a.status <> 'HELD' OR a.hold_expires_at > now())) AS appointments_used,
    (SELECT count(*)::int FROM scheduling.referral_documents d
      WHERE d.tenant_id=r.tenant_id AND d.practice_id=r.practice_id AND d.referral_id=r.id
        AND d.deleted_at IS NULL) AS document_count
  FROM scheduling.patient_referrals r
  JOIN directory.patients p ON p.tenant_id=r.tenant_id AND p.practice_id=r.practice_id AND p.id=r.patient_id
  LEFT JOIN scheduling.appointment_types t
         ON t.tenant_id=r.tenant_id AND t.practice_id=r.practice_id AND t.id=r.appointment_type_id`;

function view(r: Record<string, unknown>): ReferralView {
  const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
  return {
    id: r.id as string,
    status: r.status as ReferralView["status"],
    patient: {
      id: r.patient_id as string,
      display_name: patientDisplayName({
        given_name: r.given_name as string,
        family_name: r.family_name as string,
        preferred_name: (r.preferred_name as string | null) ?? null,
      }),
      patient_number: r.patient_number as string,
    },
    referring_practitioner_name: r.referring_practitioner_name as string,
    referring_practice_name: (r.referring_practice_name as string) ?? null,
    referring_practice_number: (r.referring_practice_number as string) ?? null,
    referral_date: (r.referral_date as string) ?? null,
    valid_until: (r.valid_until as string) ?? null,
    appointment_type: r.appointment_type_id
      ? {
          id: r.appointment_type_id as string,
          name: r.appointment_type_name as string,
        }
      : null,
    max_appointments: (r.max_appointments as number) ?? null,
    appointments_used: r.appointments_used as number,
    source_channel: r.source_channel as string,
    received_at: iso(r.received_at)!,
    verified_at: iso(r.verified_at),
    verified_by: (r.verified_by as string) ?? null,
    rejection_reason_code: (r.rejection_reason_code as string) ?? null,
    rejected_at: iso(r.rejected_at),
    cancelled_at: iso(r.cancelled_at),
    document_count: r.document_count as number,
    version: r.version as number,
  };
}

async function assertActivePatient(c: DbClient, s: Scope, patientId: string) {
  const r = await c.query<{ status: string }>(
    "SELECT status FROM directory.patients WHERE tenant_id=$1 AND practice_id=$2 AND id=$3",
    [s.tenantId, s.practiceId, patientId],
  );
  if (!r.rows[0]) throw new SchedulingError("PATIENT_NOT_FOUND");
  if (r.rows[0].status !== "ACTIVE")
    throw new SchedulingError("PATIENT_INACTIVE");
}

/** Record a referral the practice received (status RECEIVED). */
export async function createReferral(
  c: DbClient,
  ctx: CommandContext,
  input: ReferralInput,
): Promise<string> {
  await assertActivePatient(c, ctx, input.patientId);
  if (input.appointmentTypeId)
    await loadAppointmentType(c, ctx, input.appointmentTypeId);
  if (
    input.referralDate &&
    input.validUntil &&
    input.validUntil < input.referralDate
  )
    throw new SchedulingError(
      "INVALID_PERIOD",
      "The referral must be valid until a date on or after it was issued.",
    );
  const id = randomUUID();
  await c.query(
    `INSERT INTO scheduling.patient_referrals(tenant_id,practice_id,id,patient_id,status,referring_practitioner_name,
        referring_practice_name,referring_practice_number,referral_date,valid_until,appointment_type_id,max_appointments,
        source_channel,created_by)
     VALUES($1,$2,$3,$4,'RECEIVED',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      input.patientId,
      input.referringPractitionerName.trim(),
      input.referringPracticeName?.trim() || null,
      input.referringPracticeNumber?.trim() || null,
      input.referralDate ?? null,
      input.validUntil ?? null,
      input.appointmentTypeId ?? null,
      input.maxAppointments ?? null,
      ctx.channel,
      ctx.actor.id,
    ],
  );
  await audit(c, ctx, {
    action: "referral.created",
    resourceType: "referral",
    resourceId: id,
    after: {
      patient_id: input.patientId,
      appointment_type_id: input.appointmentTypeId ?? null,
      valid_until: input.validUntil ?? null,
      max_appointments: input.maxAppointments ?? null,
    },
  });
  return id;
}

async function lockReferralRow(
  c: DbClient,
  ctx: CommandContext,
  id: string,
  expectedVersion: number | undefined,
) {
  const r = await c.query<{
    status: ReferralView["status"];
    version: number;
    patient_id: string;
    appointment_type_id: string | null;
    valid_until: string | null;
    max_appointments: number | null;
  }>(
    `SELECT status, version, patient_id, appointment_type_id, valid_until::text AS valid_until, max_appointments
       FROM scheduling.patient_referrals WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId, id],
  );
  const row = r.rows[0];
  if (!row) throw new SchedulingError("REFERRAL_NOT_FOUND");
  if (expectedVersion !== undefined && row.version !== expectedVersion)
    throw new SchedulingError("REFERRAL_CHANGED");
  return row;
}

/**
 * Staff confirm a received referral (optionally correcting what it covers).
 * Where the practice requires verification, only verified referrals
 * authorise bookings.
 */
export async function verifyReferral(
  c: DbClient,
  ctx: CommandContext,
  id: string,
  input: {
    expectedVersion?: number | undefined;
    validUntil?: string | null | undefined;
    appointmentTypeId?: string | null | undefined;
    maxAppointments?: number | null | undefined;
  },
): Promise<void> {
  const before = await lockReferralRow(c, ctx, id, input.expectedVersion);
  if (before.status !== "RECEIVED")
    throw new SchedulingError("REFERRAL_TRANSITION_INVALID");
  if (input.appointmentTypeId)
    await loadAppointmentType(c, ctx, input.appointmentTypeId);
  const after = {
    valid_until:
      input.validUntil !== undefined ? input.validUntil : before.valid_until,
    appointment_type_id:
      input.appointmentTypeId !== undefined
        ? input.appointmentTypeId
        : before.appointment_type_id,
    max_appointments:
      input.maxAppointments !== undefined
        ? input.maxAppointments
        : before.max_appointments,
  };
  await c.query(
    `UPDATE scheduling.patient_referrals
        SET status='VERIFIED', verified_at=now(), verified_by=$4, valid_until=$5, appointment_type_id=$6,
            max_appointments=$7, version=version+1, updated_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      ctx.actor.id,
      after.valid_until,
      after.appointment_type_id,
      after.max_appointments,
    ],
  );
  await emit(
    c,
    ctx,
    "REFERRAL_VERIFIED",
    { type: "referral", id },
    { referral_id: id, patient_id: before.patient_id, ...after },
  );
  await audit(c, ctx, {
    action: "referral.verified",
    resourceType: "referral",
    resourceId: id,
    before: {
      status: before.status,
      valid_until: before.valid_until,
      appointment_type_id: before.appointment_type_id,
      max_appointments: before.max_appointments,
    },
    after: { status: "VERIFIED", ...after },
  });
}

export async function rejectReferral(
  c: DbClient,
  ctx: CommandContext,
  id: string,
  input: {
    reasonCode: ReferralRejectionReason;
    expectedVersion?: number | undefined;
  },
): Promise<void> {
  const before = await lockReferralRow(c, ctx, id, input.expectedVersion);
  if (before.status !== "RECEIVED")
    throw new SchedulingError("REFERRAL_TRANSITION_INVALID");
  await c.query(
    `UPDATE scheduling.patient_referrals
        SET status='REJECTED', rejected_at=now(), rejected_by=$4, rejection_reason_code=$5, version=version+1,
            updated_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, id, ctx.actor.id, input.reasonCode],
  );
  await audit(c, ctx, {
    action: "referral.rejected",
    resourceType: "referral",
    resourceId: id,
    before: { status: before.status },
    after: { status: "REJECTED", reason_code: input.reasonCode },
  });
}

/**
 * Withdraw a referral (recorded in error, or no longer applicable). It no
 * longer authorises new bookings; existing appointments are left for staff
 * to review.
 */
export async function cancelReferral(
  c: DbClient,
  ctx: CommandContext,
  id: string,
  input: { expectedVersion?: number | undefined },
): Promise<void> {
  const before = await lockReferralRow(c, ctx, id, input.expectedVersion);
  if (before.status !== "RECEIVED" && before.status !== "VERIFIED")
    throw new SchedulingError("REFERRAL_TRANSITION_INVALID");
  await c.query(
    `UPDATE scheduling.patient_referrals
        SET status='CANCELLED', cancelled_at=now(), cancelled_by=$4, version=version+1, updated_at=now()
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, id, ctx.actor.id],
  );
  await audit(c, ctx, {
    action: "referral.cancelled",
    resourceType: "referral",
    resourceId: id,
    before: { status: before.status },
    after: { status: "CANCELLED" },
  });
}

export async function listReferrals(
  c: DbClient,
  s: Scope,
  q: {
    patientId?: string | undefined;
    status?: ReferralView["status"] | undefined;
    limit: number;
  },
): Promise<ReferralView[]> {
  const r = await c.query(
    `${VIEW}
      WHERE r.tenant_id=$1 AND r.practice_id=$2 AND ($3::uuid IS NULL OR r.patient_id=$3)
        AND ($4::text IS NULL OR r.status=$4)
      ORDER BY r.received_at DESC, r.id DESC LIMIT $5`,
    [s.tenantId, s.practiceId, q.patientId ?? null, q.status ?? null, q.limit],
  );
  return r.rows.map(view);
}

export async function getReferral(
  c: DbClient,
  s: Scope,
  id: string,
): Promise<ReferralView & { documents: ReferralDocumentView[] }> {
  const r = await c.query(
    `${VIEW} WHERE r.tenant_id=$1 AND r.practice_id=$2 AND r.id=$3`,
    [s.tenantId, s.practiceId, id],
  );
  if (!r.rows[0]) throw new SchedulingError("REFERRAL_NOT_FOUND");
  const docs = await c.query<
    Omit<ReferralDocumentView, "created_at"> & { created_at: Date }
  >(
    `SELECT id, document_type, media_type, size_bytes::int AS size_bytes, uploaded_by, created_at
       FROM scheduling.referral_documents
      WHERE tenant_id=$1 AND practice_id=$2 AND referral_id=$3 AND deleted_at IS NULL
      ORDER BY created_at, id`,
    [s.tenantId, s.practiceId, id],
  );
  return {
    ...view(r.rows[0]),
    documents: docs.rows.map((d) => ({
      ...d,
      created_at: d.created_at.toISOString(),
    })),
  };
}

export interface StoredReferralDocument {
  documentType: ReferralDocumentView["document_type"];
  mediaType: string;
  sizeBytes: number;
  digestSha256: string;
  storageBackend: "local-encrypted" | "supabase-storage";
  objectKey: string;
  encryptionKeyId: string;
  scanner: string;
  scannedAt: Date;
  retentionUntil: Date;
}
/**
 * Record an uploaded referral document (already scanned clean and stored
 * encrypted by the caller). The same content uploaded again for the same
 * referral returns the existing document: `created` is false and the caller
 * removes the duplicate object.
 */
export async function recordReferralDocument(
  c: DbClient,
  ctx: CommandContext,
  referralId: string,
  doc: StoredReferralDocument,
): Promise<{ id: string; created: boolean }> {
  const referral = await c.query<{ status: string }>(
    `SELECT status FROM scheduling.patient_referrals
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId, referralId],
  );
  if (!referral.rows[0]) throw new SchedulingError("REFERRAL_NOT_FOUND");
  if (!["RECEIVED", "VERIFIED"].includes(referral.rows[0].status))
    throw new SchedulingError("REFERRAL_TRANSITION_INVALID");
  const existing = await c.query<{ id: string }>(
    `SELECT id FROM scheduling.referral_documents
      WHERE tenant_id=$1 AND practice_id=$2 AND referral_id=$3 AND digest_sha256=$4`,
    [ctx.tenantId, ctx.practiceId, referralId, doc.digestSha256],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  const id = randomUUID();
  await c.query(
    `INSERT INTO scheduling.referral_documents(tenant_id,practice_id,id,referral_id,document_type,media_type,size_bytes,
        digest_sha256,storage_backend,object_key,encryption_key_id,scanner,scanned_at,uploaded_by,retention_until)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      ctx.tenantId,
      ctx.practiceId,
      id,
      referralId,
      doc.documentType,
      doc.mediaType,
      doc.sizeBytes,
      doc.digestSha256,
      doc.storageBackend,
      doc.objectKey,
      doc.encryptionKeyId,
      doc.scanner,
      doc.scannedAt,
      ctx.actor.id,
      doc.retentionUntil,
    ],
  );
  await audit(c, ctx, {
    action: "referral_document.uploaded",
    resourceType: "referral_document",
    resourceId: id,
    after: {
      referral_id: referralId,
      document_type: doc.documentType,
      media_type: doc.mediaType,
      size_bytes: doc.sizeBytes,
      scanner: doc.scanner,
    },
  });
  return { id, created: true };
}

export interface ReferralDocumentRow {
  id: string;
  referralId: string;
  mediaType: string;
  sizeBytes: number;
  digestSha256: string;
  storageBackend: string;
  objectKey: string;
}
export async function getReferralDocument(
  c: DbClient,
  s: Scope,
  documentId: string,
  referralId?: string,
): Promise<ReferralDocumentRow> {
  const r = await c.query(
    `SELECT id, referral_id, media_type, size_bytes::int AS size_bytes, digest_sha256, storage_backend, object_key
       FROM scheduling.referral_documents
      WHERE tenant_id=$1 AND practice_id=$2 AND id=$3 AND ($4::uuid IS NULL OR referral_id=$4)
        AND deleted_at IS NULL`,
    [s.tenantId, s.practiceId, documentId, referralId ?? null],
  );
  const d = r.rows[0];
  if (!d) throw new SchedulingError("DOCUMENT_NOT_FOUND");
  return {
    id: d.id,
    referralId: d.referral_id,
    mediaType: d.media_type,
    sizeBytes: d.size_bytes,
    digestSha256: d.digest_sha256,
    storageBackend: d.storage_backend,
    objectKey: d.object_key,
  };
}
