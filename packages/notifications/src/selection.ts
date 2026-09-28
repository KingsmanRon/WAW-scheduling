import type { NotificationChannel, NotificationType } from "@access/contracts";

export const SKIP_REASONS = [
  "NO_CONSENT",
  "NO_CONTACT",
  "CHANNEL_NOT_CONFIGURED",
  "REMINDERS_DISABLED",
  "APPOINTMENT_CHANGED",
  "TOO_LATE",
  "PATIENT_ARCHIVED",
  "RECIPIENT_NOT_ALLOWED",
  "CONFIRMED_IN_CONVERSATION",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface Preferences {
  whatsapp_opt_in: boolean;
  email_opt_in: boolean;
  reminders_enabled: boolean;
  preferred_channel: NotificationChannel | null;
}
export interface Contact {
  id: string;
  kind: "MOBILE" | "EMAIL" | "LANDLINE";
  value: string;
  is_primary: boolean;
  whatsapp_capable: boolean;
}
export interface ChannelSetup {
  /** The practice's active WhatsApp connection, if any. */
  whatsappConnectionId: string | null;
  /** Platform SMTP configured. */
  emailConfigured: boolean;
  /**
   * Synthetic-data environments: only these addresses (E.164 numbers,
   * e-mail addresses) may be messaged. null: no restriction.
   */
  allowList: ReadonlySet<string> | null;
}
export interface Recipient {
  channel: NotificationChannel;
  provider: "WHATSAPP_CLOUD" | "SMTP";
  contactId: string;
  address: string;
  connectionId: string | null;
}
export type Selection =
  | { ok: true; recipient: Recipient }
  | { ok: false; channel: NotificationChannel; reason: SkipReason };

export const REMINDER_TYPES: readonly NotificationType[] = [
  "APPOINTMENT_REMINDER_24H",
  "APPOINTMENT_REMINDER_NEAR_TERM",
];

/** Best WhatsApp number: flagged WhatsApp-capable first, then primary mobile. */
function whatsappContact(contacts: readonly Contact[]): Contact | undefined {
  const mobiles = contacts.filter((c) => c.kind === "MOBILE");
  return (
    mobiles.find((c) => c.whatsapp_capable && c.is_primary) ??
    mobiles.find((c) => c.whatsapp_capable) ??
    mobiles.find((c) => c.is_primary) ??
    mobiles[0]
  );
}
function emailContact(contacts: readonly Contact[]): Contact | undefined {
  const emails = contacts.filter((c) => c.kind === "EMAIL");
  return emails.find((c) => c.is_primary) ?? emails[0];
}

/**
 * Whether one channel can carry a message to this patient now: consent for
 * that channel, an address, the channel configured, and (in synthetic
 * environments) an allow-listed address. Used when planning and again just
 * before sending, so an opt-out or a removed number is honoured.
 */
export function resolveChannel(
  channel: NotificationChannel,
  type: NotificationType,
  preferences: Preferences | null,
  contacts: readonly Contact[],
  setup: ChannelSetup,
): Selection {
  const refuse = (reason: SkipReason): Selection => ({
    ok: false,
    channel,
    reason,
  });
  if (!preferences) return refuse("NO_CONSENT");
  if (REMINDER_TYPES.includes(type) && !preferences.reminders_enabled)
    return refuse("REMINDERS_DISABLED");
  if (channel === "WHATSAPP") {
    if (!preferences.whatsapp_opt_in) return refuse("NO_CONSENT");
    const contact = whatsappContact(contacts);
    if (!contact) return refuse("NO_CONTACT");
    if (!setup.whatsappConnectionId) return refuse("CHANNEL_NOT_CONFIGURED");
    if (setup.allowList && !setup.allowList.has(contact.value))
      return refuse("RECIPIENT_NOT_ALLOWED");
    return {
      ok: true,
      recipient: {
        channel,
        provider: "WHATSAPP_CLOUD",
        contactId: contact.id,
        address: contact.value,
        connectionId: setup.whatsappConnectionId,
      },
    };
  }
  if (!preferences.email_opt_in) return refuse("NO_CONSENT");
  const contact = emailContact(contacts);
  if (!contact) return refuse("NO_CONTACT");
  if (!setup.emailConfigured) return refuse("CHANNEL_NOT_CONFIGURED");
  if (setup.allowList && !setup.allowList.has(contact.value))
    return refuse("RECIPIENT_NOT_ALLOWED");
  return {
    ok: true,
    recipient: {
      channel,
      provider: "SMTP",
      contactId: contact.id,
      address: contact.value,
      connectionId: null,
    },
  };
}

/**
 * Choose the channel for a new message: the patient's preferred channel
 * first, then WhatsApp, then e-mail. When none can carry it, the most
 * informative reason from the preferred (or first consented) channel is
 * kept, so staff see why a patient was not notified.
 */
export function selectRecipient(
  type: NotificationType,
  preferences: Preferences | null,
  contacts: readonly Contact[],
  setup: ChannelSetup,
): Selection {
  const order: NotificationChannel[] =
    preferences?.preferred_channel === "EMAIL"
      ? ["EMAIL", "WHATSAPP"]
      : ["WHATSAPP", "EMAIL"];
  let first: Selection | null = null;
  for (const channel of order) {
    const s = resolveChannel(channel, type, preferences, contacts, setup);
    if (s.ok) return s;
    // A channel the patient never consented to explains nothing.
    if (!first || (first.ok === false && first.reason === "NO_CONSENT"))
      first = s;
  }
  return first!;
}
