import type {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
} from "@access/contracts";
import {
  AppError,
  recordAuditEvent,
  type AuditActor,
  type AuditRequestMeta,
  type DbClient,
} from "@access/db";

/** Who is acting, for which practice (from the verified session). */
export interface NotificationAdminContext {
  tenantId: string;
  practiceId: string;
  actor: AuditActor;
  request?: AuditRequestMeta;
}

export interface PreferencesView {
  patient_id: string;
  whatsapp_opt_in: boolean;
  whatsapp_consent_source: string | null;
  whatsapp_consent_at: Date | null;
  email_opt_in: boolean;
  email_consent_source: string | null;
  email_consent_at: Date | null;
  reminders_enabled: boolean;
  preferred_channel: NotificationChannel | null;
  /** null until preferences have been recorded for the patient. */
  version: number | null;
  updated_at: Date | null;
}
const PREF_COLUMNS = `patient_id, whatsapp_opt_in, whatsapp_consent_source, whatsapp_consent_at, email_opt_in,
  email_consent_source, email_consent_at, reminders_enabled, preferred_channel, version, updated_at`;

async function assertPatient(
  c: DbClient,
  ctx: NotificationAdminContext,
  patientId: string,
): Promise<void> {
  const r = await c.query(
    "SELECT 1 FROM directory.patients WHERE tenant_id=$1 AND practice_id=$2 AND id=$3",
    [ctx.tenantId, ctx.practiceId, patientId],
  );
  if (!r.rowCount)
    throw new AppError(404, "PATIENT_NOT_FOUND", "patient not found");
}

export async function getNotificationPreferences(
  c: DbClient,
  ctx: NotificationAdminContext,
  patientId: string,
): Promise<PreferencesView> {
  await assertPatient(c, ctx, patientId);
  const r = await c.query<PreferencesView>(
    `SELECT ${PREF_COLUMNS} FROM messaging.notification_preferences
      WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3`,
    [ctx.tenantId, ctx.practiceId, patientId],
  );
  return (
    r.rows[0] ?? {
      patient_id: patientId,
      whatsapp_opt_in: false,
      whatsapp_consent_source: null,
      whatsapp_consent_at: null,
      email_opt_in: false,
      email_consent_source: null,
      email_consent_at: null,
      reminders_enabled: true,
      preferred_channel: null,
      version: null,
      updated_at: null,
    }
  );
}

/**
 * Record what the patient agreed to. Opting in stamps the consent source
 * (staff recorded) and time, keeping an earlier consent's record while it
 * stays in force; opting out clears it. The audit trail keeps every change.
 */
export async function setNotificationPreferences(
  c: DbClient,
  ctx: NotificationAdminContext,
  patientId: string,
  input: {
    whatsappOptIn: boolean;
    emailOptIn: boolean;
    remindersEnabled: boolean;
    preferredChannel: NotificationChannel | null;
    expectedVersion?: number | undefined;
  },
): Promise<PreferencesView> {
  await assertPatient(c, ctx, patientId);
  if (
    (input.preferredChannel === "WHATSAPP" && !input.whatsappOptIn) ||
    (input.preferredChannel === "EMAIL" && !input.emailOptIn)
  )
    throw new AppError(
      422,
      "PREFERRED_CHANNEL_NOT_CONSENTED",
      "the preferred channel must be one the patient opted in to",
    );
  const existing = await c.query<PreferencesView>(
    `SELECT ${PREF_COLUMNS} FROM messaging.notification_preferences
      WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId, patientId],
  );
  const before = existing.rows[0];
  if ((before?.version ?? null) !== (input.expectedVersion ?? null))
    throw new AppError(
      409,
      "VERSION_CONFLICT",
      "the preferences changed since they were read; reload them",
    );
  const consent = (
    optIn: boolean,
    was: boolean | undefined,
    source: string | null | undefined,
    at: Date | null | undefined,
  ) =>
    optIn
      ? was
        ? { source: source ?? "STAFF_RECORDED", at: at ?? new Date() }
        : { source: "STAFF_RECORDED", at: new Date() }
      : { source: null, at: null };
  const wa = consent(
    input.whatsappOptIn,
    before?.whatsapp_opt_in,
    before?.whatsapp_consent_source,
    before?.whatsapp_consent_at,
  );
  const em = consent(
    input.emailOptIn,
    before?.email_opt_in,
    before?.email_consent_source,
    before?.email_consent_at,
  );
  const values = [
    ctx.tenantId,
    ctx.practiceId,
    patientId,
    input.whatsappOptIn,
    wa.source,
    wa.at,
    input.emailOptIn,
    em.source,
    em.at,
    input.remindersEnabled,
    input.preferredChannel,
    ctx.actor.id,
  ];
  const r = before
    ? await c.query<PreferencesView>(
        `UPDATE messaging.notification_preferences
            SET whatsapp_opt_in=$4, whatsapp_consent_source=$5, whatsapp_consent_at=$6, email_opt_in=$7,
                email_consent_source=$8, email_consent_at=$9, reminders_enabled=$10, preferred_channel=$11,
                updated_by=$12, version=version+1
          WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 RETURNING ${PREF_COLUMNS}`,
        values,
      )
    : await c.query<PreferencesView>(
        `INSERT INTO messaging.notification_preferences(tenant_id, practice_id, patient_id, whatsapp_opt_in,
            whatsapp_consent_source, whatsapp_consent_at, email_opt_in, email_consent_source, email_consent_at,
            reminders_enabled, preferred_channel, updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${PREF_COLUMNS}`,
        values,
      );
  const after = r.rows[0]!;
  const summary = (p: PreferencesView | undefined) =>
    p
      ? {
          whatsapp_opt_in: p.whatsapp_opt_in,
          email_opt_in: p.email_opt_in,
          reminders_enabled: p.reminders_enabled,
          preferred_channel: p.preferred_channel,
        }
      : null;
  await recordAuditEvent(c, {
    tenantId: ctx.tenantId,
    practiceId: ctx.practiceId,
    actor: ctx.actor,
    action: "notification_preferences.updated",
    resourceType: "patient",
    resourceId: patientId,
    channel: "INTERNAL",
    changes: { before: summary(before), after: summary(after) },
    ...(ctx.request ? { request: ctx.request } : {}),
  });
  return after;
}

export interface DeliveryView {
  id: string;
  notification_type: NotificationType;
  channel: NotificationChannel;
  status: NotificationStatus;
  patient_id: string;
  appointment_id: string | null;
  waitlist_offer_id: string | null;
  /** Masked: enough for staff to recognise the number or address. */
  recipient: string | null;
  scheduled_for: Date;
  attempt_count: number;
  next_attempt_at: Date | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  failed_at: Date | null;
  cancelled_at: Date | null;
  skip_reason: string | null;
  cancel_reason: string | null;
  last_error_code: string | null;
  created_at: Date;
}

/** "+27 •••• •• 4567" / "j•••@example.com" */
export function maskAddress(address: string | null): string | null {
  if (!address) return null;
  if (address.includes("@")) {
    const [local, domain] = address.split("@");
    return `${local!.slice(0, 1)}•••@${domain}`;
  }
  return `${address.slice(0, 3)} •••• ${address.slice(-4)}`;
}

export async function listDeliveries(
  c: DbClient,
  ctx: NotificationAdminContext,
  q: {
    statuses?: NotificationStatus[];
    type?: NotificationType;
    patientId?: string;
    appointmentId?: string;
    before?: Date;
    limit: number;
  },
): Promise<DeliveryView[]> {
  const r = await c.query<DeliveryView & { recipient_address: string | null }>(
    `SELECT id, notification_type, channel, status, patient_id, appointment_id, waitlist_offer_id, recipient_address,
            scheduled_for, attempt_count, CASE WHEN status IN ('PENDING','PROCESSING') THEN next_attempt_at END AS next_attempt_at,
            sent_at, delivered_at, read_at, failed_at, cancelled_at, skip_reason, cancel_reason, last_error_code, created_at
       FROM messaging.notification_deliveries
      WHERE tenant_id=$1 AND practice_id=$2
        AND ($3::text[] IS NULL OR status = ANY($3)) AND ($4::text IS NULL OR notification_type=$4)
        AND ($5::uuid IS NULL OR patient_id=$5) AND ($6::uuid IS NULL OR appointment_id=$6)
        AND ($7::timestamptz IS NULL OR created_at < $7)
      ORDER BY created_at DESC, id DESC LIMIT $8`,
    [
      ctx.tenantId,
      ctx.practiceId,
      q.statuses?.length ? q.statuses : null,
      q.type ?? null,
      q.patientId ?? null,
      q.appointmentId ?? null,
      q.before ?? null,
      q.limit,
    ],
  );
  return r.rows.map(({ recipient_address, ...row }) => ({
    ...row,
    recipient: maskAddress(recipient_address),
  }));
}

/**
 * Consent given or withdrawn by the patient in their own WhatsApp
 * conversation (e.g. "yes please" to reminders, or STOP). Opting out also
 * drops WhatsApp as the preferred channel. Audited like staff changes.
 */
export async function recordWhatsAppConsent(
  c: DbClient,
  ctx: NotificationAdminContext,
  patientId: string,
  optIn: boolean,
): Promise<boolean> {
  const existing = await c.query<PreferencesView>(
    `SELECT ${PREF_COLUMNS} FROM messaging.notification_preferences
      WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 FOR UPDATE`,
    [ctx.tenantId, ctx.practiceId, patientId],
  );
  const before = existing.rows[0];
  if (before && before.whatsapp_opt_in === optIn) return false;
  if (!before && !optIn) return false;
  if (before)
    await c.query(
      `UPDATE messaging.notification_preferences
          SET whatsapp_opt_in=$4, whatsapp_consent_source=$5, whatsapp_consent_at=$6,
              preferred_channel=CASE WHEN NOT $4 AND preferred_channel='WHATSAPP' THEN NULL ELSE preferred_channel END,
              updated_by=$7, version=version+1
        WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3`,
      [
        ctx.tenantId,
        ctx.practiceId,
        patientId,
        optIn,
        optIn ? "PATIENT_WHATSAPP" : null,
        optIn ? new Date() : null,
        ctx.actor.id,
      ],
    );
  else
    await c.query(
      `INSERT INTO messaging.notification_preferences(tenant_id, practice_id, patient_id, whatsapp_opt_in,
          whatsapp_consent_source, whatsapp_consent_at, updated_by)
       VALUES($1,$2,$3,true,'PATIENT_WHATSAPP',now(),$4)`,
      [ctx.tenantId, ctx.practiceId, patientId, ctx.actor.id],
    );
  await recordAuditEvent(c, {
    tenantId: ctx.tenantId,
    practiceId: ctx.practiceId,
    actor: ctx.actor,
    action: "notification_preferences.updated",
    resourceType: "patient",
    resourceId: patientId,
    channel: "WHATSAPP",
    changes: {
      before: before ? { whatsapp_opt_in: before.whatsapp_opt_in } : null,
      after: { whatsapp_opt_in: optIn },
    },
  });
  return true;
}
