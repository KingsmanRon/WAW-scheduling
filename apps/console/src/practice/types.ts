import type { PracticeRole } from "../session";

/** Shapes returned by the practice API (/v1/practices/:id/...). */

export type Permission =
  | "schedule.read"
  | "patient.read"
  | "patient.write"
  | "patient.duplicates.review"
  | "appointment.book"
  | "appointment.reschedule"
  | "appointment.cancel"
  | "appointment.check_in"
  | "appointment.progress"
  | "appointment.no_show"
  | "appointment.notes"
  | "appointment.override_availability"
  | "schedule.blocks.manage"
  | "schedule.exceptions.manage"
  | "schedule.hours.manage"
  | "configuration.manage"
  | "staff.manage"
  | "audit.read"
  | "waitlist.read"
  | "waitlist.manage"
  | "referral.read"
  | "referral.register"
  | "referral.verify"
  | "referral.document.read"
  | "conversation.manage"
  | "notification.read"
  | "notification.preferences.manage"
  | "integration.manage";

export const CHANNELS = [
  "PHONE",
  "WALK_IN",
  "WHATSAPP",
  "WEB",
  "INTERNAL",
  "REFERRAL",
  "OTHER",
] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABELS: Record<Channel, string> = {
  PHONE: "Phone",
  WALK_IN: "Walk-in",
  WHATSAPP: "WhatsApp",
  WEB: "Web",
  INTERNAL: "Internal",
  REFERRAL: "Referral",
  OTHER: "Other",
};

export interface PracticeSettings {
  id: string;
  name: string;
  timezone: string;
  status: string;
  contact_phone: string | null;
  contact_email: string | null;
  hold_ttl_seconds: number;
  default_slot_interval_minutes: number;
  reminder_24h_enabled: boolean;
  near_term_reminder_minutes: number | null;
  waitlist_offer_ttl_minutes: number;
  referral_verification_required: boolean;
  patient_change_cutoff_minutes: number;
  version: number;
}
export interface Location {
  id: string;
  name: string;
  timezone: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  phone: string | null;
  active: boolean;
  version: number;
}
export interface Practitioner {
  id: string;
  display_name: string;
  title: string | null;
  given_name: string | null;
  family_name: string;
  profession: string;
  registration_number: string | null;
  calendar_color: string | null;
  active: boolean;
  bookable_by_patients: boolean;
  version: number;
  location_ids: string[];
}
export interface AppointmentType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  slot_interval_minutes: number | null;
  requires_referral: boolean;
  new_patient_allowed: boolean;
  follow_up_only: boolean;
  min_notice_minutes: number;
  max_advance_days: number;
  patient_bookable: boolean;
  calendar_color: string | null;
  active: boolean;
  version: number;
  practitioner_ids: string[];
  location_ids: string[];
}
export interface PracticeContextData {
  practice: PracticeSettings;
  membership: {
    user_id: string;
    role: PracticeRole;
    display_name: string;
    practitioner_id: string | null;
    permissions: Permission[];
  };
  locations: Location[];
  practitioners: Practitioner[];
  appointment_types: AppointmentType[];
}

export type AppointmentStatus =
  | "HELD"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "RESCHEDULED"
  | "EXPIRED";
export interface Appointment {
  id: string;
  status: AppointmentStatus;
  version: number;
  starts_at: string;
  ends_at: string;
  timezone: string;
  duration_minutes: number;
  patient: {
    id: string;
    display_name: string;
    given_name: string;
    patient_number: string;
  };
  practitioner: { id: string; display_name: string };
  location: { id: string; name: string };
  appointment_type: {
    id: string;
    code: string;
    name: string;
    calendar_color: string | null;
  };
  source_channel: Channel;
  booked_by: { actor_type: string; actor_id: string; role: string | null };
  referral_id: string | null;
  waitlist_entry_id: string | null;
  hold: {
    id: string;
    status: string;
    expires_at: string;
    purpose: string;
    owner_channel: string;
  } | null;
  rescheduled_from_id: string | null;
  rescheduled_to_id: string | null;
  notes: string | null;
  override_availability: boolean;
  confirmed_at: string | null;
  checked_in_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  no_show_at: string | null;
  cancelled_at: string | null;
  cancellation_reason_code: string | null;
  cancellation_note: string | null;
  created_at: string;
}
export interface AppointmentEvent {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string;
  actor_type: string;
  actor_id: string;
  actor_role: string | null;
  channel: string | null;
  reason_code: string | null;
  details: Record<string, unknown>;
  occurred_at: string;
}
export interface Period {
  id: string;
  practitioner_id: string;
  location_id: string | null;
  reason_code: string;
  starts_at: string;
  ends_at: string;
  note: string | null;
  kind?: "UNAVAILABLE" | "AVAILABLE";
}
export interface CalendarData {
  from: string;
  to: string;
  practitioners: {
    id: string;
    display_name: string;
    calendar_color: string | null;
    location_ids: string[];
  }[];
  working_windows: {
    practitioner_id: string;
    location_id: string;
    start: string;
    end: string;
  }[];
  blocks: Period[];
  exceptions: Period[];
  appointments: Appointment[];
  truncated: boolean;
}
export interface Slot {
  practitioner_id: string;
  practitioner_name: string;
  location_id: string;
  location_name: string;
  start: string;
  end: string;
  timezone: string;
}
export interface Hold {
  id: string;
  status: string;
  purpose: string;
  expires_at: string;
  appointment: Appointment;
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
export interface PatientDetail extends PatientSummary {
  administrative_sex: string | null;
  preferred_language: string | null;
  source_channel: string;
  version: number;
  contacts: {
    id: string;
    kind: "MOBILE" | "EMAIL" | "LANDLINE";
    value: string;
    is_primary: boolean;
    whatsapp_capable: boolean;
    verified_at: string | null;
    verification_method: string | null;
  }[];
  identifiers: {
    id: string;
    system: string;
    issuer: string;
    value: string | null;
    hint: string | null;
  }[];
  possible_duplicates: {
    id: string;
    other_patient_id: string;
    reasons: string[];
  }[];
}
export interface NotificationPreferences {
  patient_id: string;
  whatsapp_opt_in: boolean;
  whatsapp_consent_source: string | null;
  whatsapp_consent_at: string | null;
  email_opt_in: boolean;
  email_consent_source: string | null;
  email_consent_at: string | null;
  reminders_enabled: boolean;
  preferred_channel: "WHATSAPP" | "EMAIL" | null;
  /** null until preferences have been recorded. */
  version: number | null;
  updated_at: string | null;
}
export interface Delivery {
  id: string;
  notification_type: string;
  channel: string;
  status: string;
  patient_id: string;
  appointment_id: string | null;
  waitlist_offer_id: string | null;
  /** Masked by the API. */
  recipient: string | null;
  scheduled_for: string;
  attempt_count: number;
  next_attempt_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  skip_reason: string | null;
  cancel_reason: string | null;
  last_error_code: string | null;
  created_at: string;
}
export interface WaitlistEntry {
  id: string;
  status: "ACTIVE" | "OFFERED" | "BOOKED" | "CANCELLED" | "EXPIRED";
  patient: { id: string; display_name: string; patient_number: string };
  appointment_type: { id: string; name: string };
  practitioner: { id: string; display_name: string } | null;
  location: { id: string; name: string } | null;
  earliest_date: string;
  latest_date: string;
  preferred_weekdays: number[];
  preferred_start_minute: number | null;
  preferred_end_minute: number | null;
  priority: number;
  referral_id: string | null;
  source_channel: string;
  booked_appointment_id: string | null;
  pending_offer: {
    id: string;
    starts_at: string;
    expires_at: string;
    practitioner_id: string;
    location_id: string;
  } | null;
  created_at: string;
  closed_at: string | null;
  version: number;
  offers?: {
    id: string;
    status: string;
    starts_at: string;
    expires_at: string;
    offered_at: string;
    responded_at: string | null;
    response_channel: string | null;
  }[];
}
export interface Referral {
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
  rejection_reason_code: string | null;
  document_count: number;
  version: number;
  documents?: {
    id: string;
    document_type: string;
    media_type: string;
    size_bytes: number;
    uploaded_by: string;
    created_at: string;
  }[];
}
export interface ConversationSummary {
  id: string;
  channel: string;
  participant_address: string;
  patient: { id: string; display_name: string; patient_number: string } | null;
  status: "ACTIVE" | "NEEDS_STAFF" | "CLOSED";
  needs_staff_reason: string | null;
  state: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  within_service_window: boolean;
  version: number;
  updated_at: string;
}
export interface ConversationMessage {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  message_type: string;
  body: string | null;
  options: unknown;
  status: string;
  sent_by: string | null;
  created_at: string;
  redacted: boolean;
}
export interface AuditEvent {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  channel: string | null;
  changes: Record<string, unknown>;
  reason: string | null;
}
export interface AvailabilityRule {
  id: string;
  practitioner_id: string;
  location_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
  valid_from: string;
  valid_until: string | null;
}
