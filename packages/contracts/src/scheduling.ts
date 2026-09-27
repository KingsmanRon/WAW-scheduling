/**
 * Scheduling platform vocabulary. Every enum mirrors a PostgreSQL CHECK
 * constraint in supabase/migrations 0007-0010; change both together through a
 * new migration.
 */

/**
 * How a booking reached the practice. Channels are sources, never separate
 * appointment books: all of them go through the one Scheduling Core.
 */
export const BOOKING_CHANNELS = [
  "PHONE",
  "WALK_IN",
  "WHATSAPP",
  "WEB",
  "INTERNAL",
  "REFERRAL",
  "OTHER",
] as const;
export type BookingChannel = (typeof BOOKING_CHANNELS)[number];

/** Practice-level application roles (directory.practice_memberships.role). */
export const PRACTICE_ROLES = [
  "PRACTICE_ADMIN",
  "DOCTOR",
  "RECEPTIONIST",
  "CLINICAL_STAFF",
  "READ_ONLY",
] as const;
export type PracticeRole = (typeof PRACTICE_ROLES)[number];

/** Who performed a scheduling action. */
export const SCHEDULING_ACTOR_TYPES = ["STAFF", "PATIENT", "SYSTEM"] as const;
export type SchedulingActorType = (typeof SCHEDULING_ACTOR_TYPES)[number];

export const CANCELLATION_REASON_CODES = [
  "PATIENT_REQUEST",
  "PRACTICE_REQUEST",
  "PRACTITIONER_UNAVAILABLE",
  "DUPLICATE_BOOKING",
  "OTHER",
] as const;
export type CancellationReasonCode =
  | (typeof CANCELLATION_REASON_CODES)[number]
  | "HOLD_RELEASED"
  | "WAITLIST_OFFER_DECLINED";

export const HOLD_PURPOSES = [
  "BOOKING",
  "RESCHEDULE",
  "WAITLIST_OFFER",
] as const;
export type HoldPurpose = (typeof HOLD_PURPOSES)[number];

export const EXCEPTION_REASON_CODES = [
  "LEAVE",
  "SICK_LEAVE",
  "TRAINING",
  "PUBLIC_HOLIDAY",
  "PRACTICE_CLOSED",
  "EXTRA_SESSION",
  "OTHER",
] as const;
export const BLOCK_REASON_CODES = [
  "ADMIN",
  "MEETING",
  "BREAK",
  "PERSONAL",
  "EMERGENCY",
  "OTHER",
] as const;
export const PROFESSIONS = [
  "DOCTOR",
  "NURSE",
  "ALLIED_HEALTH",
  "OTHER",
] as const;

/** Domain events written to platform.outbox_events. */
export const OUTBOX_EVENT_TYPES = [
  "APPOINTMENT_CONFIRMED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
  "PATIENT_CHECKED_IN",
  "APPOINTMENT_STARTED",
  "APPOINTMENT_COMPLETED",
  "APPOINTMENT_NO_SHOW",
  "HOLD_EXPIRED",
  "HOLD_RELEASED",
  "WAITLIST_SLOT_AVAILABLE",
  "WAITLIST_OFFER_DECLINED",
  "WAITLIST_OFFER_EXPIRED",
  "CHANNEL_MESSAGE_RECEIVED",
  "REFERRAL_VERIFIED",
] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export const NOTIFICATION_TYPES = [
  "APPOINTMENT_CONFIRMATION",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
  "APPOINTMENT_REMINDER_24H",
  "APPOINTMENT_REMINDER_NEAR_TERM",
  "WAITLIST_OFFER",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const NOTIFICATION_CHANNELS = ["WHATSAPP", "EMAIL"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NOTIFICATION_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
