import { randomUUID } from "node:crypto";
import type {
  BookingChannel,
  NotificationChannel,
  NotificationType,
} from "@access/contracts";
import type { DbClient } from "@access/db";
import { whatsAppConnectionConfigSchema } from "@access/integrations";
import { NOTIFICATION_CATALOGUE } from "./catalogue.js";
import {
  selectRecipient,
  type ChannelSetup,
  type Contact,
  type Preferences,
  type SkipReason,
} from "./selection.js";

/**
 * Notification planning: turns appointment facts into delivery rows. Runs in
 * the worker's outbox transaction, so a plan is written exactly once per
 * event (dedup keys make re-planning a no-op). Nothing here sends; the
 * dispatcher does, and re-checks everything just before it does.
 */
export interface PlanScope {
  tenantId: string;
  practiceId: string;
  /** The outbox event that caused this plan. */
  sourceEventId: string | null;
}
export interface PlanEnvironment {
  emailConfigured: boolean;
  allowList: ReadonlySet<string> | null;
  now: () => Date;
}
export type CancelReason =
  | "APPOINTMENT_CANCELLED"
  | "APPOINTMENT_RESCHEDULED"
  | "APPOINTMENT_CLOSED"
  | "OFFER_CLOSED";

/** Messages about a change are pointless this close to the start. */
const MIN_LEAD_MS = 15 * 60_000;
/** A reminder is planned only if it would go out at least this far ahead. */
const PLAN_MARGIN_MS = 5 * 60_000;

interface AppointmentRow {
  id: string;
  status: string;
  starts_at: Date;
  patient_id: string;
  reminder_24h_enabled: boolean;
  near_term_reminder_minutes: number | null;
  patient_status: string;
}

async function loadAppointment(
  c: DbClient,
  s: PlanScope,
  appointmentId: string,
): Promise<AppointmentRow | undefined> {
  const r = await c.query<AppointmentRow>(
    `SELECT a.id, a.status, a.starts_at, a.patient_id,
            p.reminder_24h_enabled, p.near_term_reminder_minutes, pt.status AS patient_status
       FROM scheduling.appointments a
       JOIN directory.practices p ON p.tenant_id=a.tenant_id AND p.id=a.practice_id
       JOIN directory.patients pt ON pt.tenant_id=a.tenant_id AND pt.practice_id=a.practice_id AND pt.id=a.patient_id
      WHERE a.tenant_id=$1 AND a.practice_id=$2 AND a.id=$3`,
    [s.tenantId, s.practiceId, appointmentId],
  );
  return r.rows[0];
}

export interface RecipientData {
  preferences: Preferences | null;
  contacts: Contact[];
  whatsapp: {
    id: string;
    config: unknown;
    secret_ref: string | null;
  } | null;
}
export async function loadRecipientData(
  c: DbClient,
  s: Pick<PlanScope, "tenantId" | "practiceId">,
  patientId: string,
): Promise<RecipientData> {
  const prefs = await c.query<Preferences>(
    `SELECT whatsapp_opt_in, email_opt_in, reminders_enabled, preferred_channel
       FROM messaging.notification_preferences WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3`,
    [s.tenantId, s.practiceId, patientId],
  );
  const contacts = await c.query<Contact>(
    `SELECT id, kind, value, is_primary, whatsapp_capable FROM directory.patient_contacts
      WHERE tenant_id=$1 AND practice_id=$2 AND patient_id=$3 AND removed_at IS NULL
      ORDER BY is_primary DESC, created_at, id`,
    [s.tenantId, s.practiceId, patientId],
  );
  const connection = await c.query<{
    id: string;
    config: unknown;
    secret_ref: string | null;
  }>(
    `SELECT id, config, secret_ref FROM integration.connections
      WHERE tenant_id=$1 AND practice_id=$2 AND provider='WHATSAPP_CLOUD' AND status='ACTIVE'`,
    [s.tenantId, s.practiceId],
  );
  return {
    preferences: prefs.rows[0] ?? null,
    contacts: contacts.rows,
    whatsapp: connection.rows[0] ?? null,
  };
}

/** Template name and language for a type on a connection (or defaults). */
export function templateFor(
  type: NotificationType,
  connectionConfig: unknown,
): { name: string; language: string } {
  const parsed = whatsAppConnectionConfigSchema.safeParse(connectionConfig);
  const config = parsed.success ? parsed.data : null;
  const override = config?.templates[type];
  return {
    name: override?.name ?? NOTIFICATION_CATALOGUE[type].template,
    language: override?.language ?? config?.default_language ?? "en",
  };
}

export interface PlannedMessage {
  type: NotificationType;
  scheduledFor: Date;
  dedupKey: string;
  appointmentId?: string;
  appointmentStartsAt?: Date;
  waitlistOfferId?: string;
  /** Decided before selection (e.g. confirmed in conversation). */
  skip?: SkipReason;
}

/**
 * Insert one delivery for a planned message: PENDING with a recipient, or
 * SKIPPED with the reason no message will go out. Idempotent on dedup key.
 */
export async function planDelivery(
  c: DbClient,
  s: PlanScope,
  env: PlanEnvironment,
  patientId: string,
  data: RecipientData,
  m: PlannedMessage,
  patientArchived = false,
): Promise<boolean> {
  const setup: ChannelSetup = {
    whatsappConnectionId: data.whatsapp?.id ?? null,
    emailConfigured: env.emailConfigured,
    allowList: env.allowList,
  };
  const selection = selectRecipient(
    m.type,
    data.preferences,
    data.contacts,
    setup,
  );
  const skip: SkipReason | null =
    m.skip ??
    (patientArchived ? "PATIENT_ARCHIVED" : null) ??
    (selection.ok ? null : selection.reason);
  const channel: NotificationChannel = selection.ok
    ? selection.recipient.channel
    : selection.channel;
  const recipient = selection.ok && !skip ? selection.recipient : null;
  const template = templateFor(m.type, data.whatsapp?.config);
  const inserted = await c.query(
    `INSERT INTO messaging.notification_deliveries(
        tenant_id, practice_id, id, notification_type, channel, provider, patient_id, appointment_id,
        waitlist_offer_id, recipient_contact_id, recipient_address, connection_id, template_name,
        template_language, status, scheduled_for, appointment_starts_at, next_attempt_at, skip_reason,
        dedup_key, source_event_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$16,$18,$19,$20)
     ON CONFLICT (tenant_id, practice_id, dedup_key) DO NOTHING`,
    [
      s.tenantId,
      s.practiceId,
      randomUUID(),
      m.type,
      channel,
      channel === "WHATSAPP" ? "WHATSAPP_CLOUD" : "SMTP",
      patientId,
      m.appointmentId ?? null,
      m.waitlistOfferId ?? null,
      recipient?.contactId ?? null,
      recipient?.address ?? null,
      recipient?.connectionId ?? null,
      template.name,
      template.language,
      skip ? "SKIPPED" : "PENDING",
      m.scheduledFor,
      m.appointmentStartsAt ?? null,
      skip,
      m.dedupKey,
      s.sourceEventId,
    ],
  );
  return (inserted.rowCount ?? 0) > 0;
}

/**
 * A confirmed appointment (new, rescheduled into, or taken from the
 * waitlist): its confirmation or "moved" message and its reminders.
 */
export async function planAppointmentMessages(
  c: DbClient,
  s: PlanScope,
  env: PlanEnvironment,
  appointmentId: string,
  kind: "CONFIRMED" | "RESCHEDULED",
  /** The channel the booking or move was made through. */
  changedVia: BookingChannel | null,
  /** false: reminders only (reconciliation of missed plans). */
  firstMessage = true,
): Promise<number> {
  const a = await loadAppointment(c, s, appointmentId);
  // Already moved on (cancelled, rescheduled): a later event plans for it.
  if (!a || a.status !== "CONFIRMED") return 0;
  const now = env.now();
  const start = new Date(a.starts_at);
  const data = await loadRecipientData(c, s, a.patient_id);
  const archived = a.patient_status === "ARCHIVED";
  const first: NotificationType =
    kind === "RESCHEDULED"
      ? "APPOINTMENT_RESCHEDULED"
      : "APPOINTMENT_CONFIRMATION";
  const messages: PlannedMessage[] = [];
  if (firstMessage)
    messages.push({
      type: first,
      scheduledFor: now,
      dedupKey: `${first}:${a.id}`,
      appointmentId: a.id,
      appointmentStartsAt: start,
      // The conversation already confirmed a change made in it.
      ...(changedVia === "WHATSAPP"
        ? { skip: "CONFIRMED_IN_CONVERSATION" as const }
        : +start - +now < MIN_LEAD_MS
          ? { skip: "TOO_LATE" as const }
          : {}),
    });
  const day = new Date(+start - 24 * 3600_000);
  if (a.reminder_24h_enabled && +day - +now > PLAN_MARGIN_MS)
    messages.push({
      type: "APPOINTMENT_REMINDER_24H",
      scheduledFor: day,
      dedupKey: `APPOINTMENT_REMINDER_24H:${a.id}:${start.toISOString()}`,
      appointmentId: a.id,
      appointmentStartsAt: start,
    });
  if (a.near_term_reminder_minutes) {
    const soon = new Date(+start - a.near_term_reminder_minutes * 60_000);
    if (+soon - +now > PLAN_MARGIN_MS)
      messages.push({
        type: "APPOINTMENT_REMINDER_NEAR_TERM",
        scheduledFor: soon,
        dedupKey: `APPOINTMENT_REMINDER_NEAR_TERM:${a.id}:${start.toISOString()}:${a.near_term_reminder_minutes}`,
        appointmentId: a.id,
        appointmentStartsAt: start,
      });
  }
  let planned = 0;
  for (const m of messages)
    if (await planDelivery(c, s, env, a.patient_id, data, m, archived))
      planned++;
  return planned;
}

/** Withdraw every not-yet-sent message about an appointment. */
export async function cancelPendingDeliveries(
  c: DbClient,
  s: Pick<PlanScope, "tenantId" | "practiceId">,
  appointmentId: string,
  reason: CancelReason,
): Promise<number> {
  const r = await c.query(
    `UPDATE messaging.notification_deliveries
        SET status='CANCELLED', cancelled_at=now(), cancel_reason=$4, lease_until=NULL, version=version+1
      WHERE tenant_id=$1 AND practice_id=$2 AND appointment_id=$3 AND status='PENDING'`,
    [s.tenantId, s.practiceId, appointmentId, reason],
  );
  return r.rowCount ?? 0;
}

/**
 * A cancelled appointment: withdraw its reminders and tell the patient,
 * unless it was cancelled inside their WhatsApp conversation (already
 * confirmed there) or its time has passed.
 */
export async function planCancellationNotice(
  c: DbClient,
  s: PlanScope,
  env: PlanEnvironment,
  appointmentId: string,
  cancelledVia: BookingChannel | null,
): Promise<number> {
  await cancelPendingDeliveries(c, s, appointmentId, "APPOINTMENT_CANCELLED");
  const a = await loadAppointment(c, s, appointmentId);
  if (!a || a.status !== "CANCELLED") return 0;
  const now = env.now();
  const start = new Date(a.starts_at);
  if (+start <= +now) return 0;
  const data = await loadRecipientData(c, s, a.patient_id);
  const planned = await planDelivery(
    c,
    s,
    env,
    a.patient_id,
    data,
    {
      type: "APPOINTMENT_CANCELLED",
      scheduledFor: now,
      dedupKey: `APPOINTMENT_CANCELLED:${a.id}`,
      appointmentId: a.id,
      appointmentStartsAt: start,
      ...(cancelledVia === "WHATSAPP"
        ? { skip: "CONFIRMED_IN_CONVERSATION" as const }
        : {}),
    },
    a.patient_status === "ARCHIVED",
  );
  return planned ? 1 : 0;
}
