import { DateTime } from "luxon";
import type { NotificationType } from "@access/contracts";

/**
 * What each notification says. WhatsApp business-initiated messages must use
 * templates approved by Meta; the names and bodies below are the platform's
 * defaults (register them as UTILITY templates, or map a connection to other
 * approved names in its config). E-mail carries the same content as text.
 *
 * Content is administrative only: first name, practice, time, practitioner
 * and location. Never clinical details, reasons for visit or identifiers.
 */
export interface MessageFacts {
  practiceName: string;
  patientFirstName: string;
  /** Appointment (or offered slot) start in the location's time zone. */
  when: string;
  practitionerName: string;
  locationName: string;
  /** Waitlist offers: when the offer lapses, local time. */
  offerExpires?: string;
  /** Waitlist offers: the offer the reply buttons act on. */
  offerId?: string;
}

interface CatalogueEntry {
  /** Default approved WhatsApp template name. */
  template: string;
  /** The body to register with Meta; {{n}} are the positional parameters. */
  templateBody: string;
  params(f: MessageFacts): string[];
  /** Quick-reply button titles registered with the template, if any. */
  buttons?: readonly string[];
  buttonPayloads?(f: MessageFacts): string[];
  subject(f: MessageFacts): string;
  text(f: MessageFacts): string;
}

const standard = (f: MessageFacts) => [
  f.patientFirstName,
  f.practiceName,
  f.when,
  f.practitionerName,
  f.locationName,
];
const footer = (f: MessageFacts) =>
  `\n\nThis message was sent by ${f.practiceName} about your appointment. Please do not reply to this e-mail; contact the practice directly if you need help.`;

export const NOTIFICATION_CATALOGUE: Record<NotificationType, CatalogueEntry> =
  {
    APPOINTMENT_CONFIRMATION: {
      template: "appointment_confirmation",
      templateBody:
        "Hi {{1}}, your appointment at {{2}} is confirmed for {{3}} with {{4}} at {{5}}. To change it, reply to this message or call the practice.",
      params: standard,
      subject: (f) => `Appointment confirmed - ${f.practiceName}`,
      text: (f) =>
        `Hi ${f.patientFirstName},\n\nYour appointment at ${f.practiceName} is confirmed for ${f.when} with ${f.practitionerName} at ${f.locationName}.` +
        footer(f),
    },
    APPOINTMENT_RESCHEDULED: {
      template: "appointment_rescheduled",
      templateBody:
        "Hi {{1}}, your appointment at {{2}} has moved to {{3}} with {{4}} at {{5}}. To change it, reply to this message or call the practice.",
      params: standard,
      subject: (f) => `Appointment moved - ${f.practiceName}`,
      text: (f) =>
        `Hi ${f.patientFirstName},\n\nYour appointment at ${f.practiceName} has moved to ${f.when} with ${f.practitionerName} at ${f.locationName}.` +
        footer(f),
    },
    APPOINTMENT_CANCELLED: {
      template: "appointment_cancelled",
      templateBody:
        "Hi {{1}}, your appointment at {{2}} on {{3}} has been cancelled. Reply to this message or call the practice if you would like a new appointment.",
      params: (f) => [f.patientFirstName, f.practiceName, f.when],
      subject: (f) => `Appointment cancelled - ${f.practiceName}`,
      text: (f) =>
        `Hi ${f.patientFirstName},\n\nYour appointment at ${f.practiceName} on ${f.when} has been cancelled. Contact the practice if you would like a new appointment.` +
        footer(f),
    },
    APPOINTMENT_REMINDER_24H: {
      template: "appointment_reminder_24h",
      templateBody:
        "Hi {{1}}, a reminder of your appointment at {{2}} on {{3}} with {{4}} at {{5}}. Reply to this message if you need to change it.",
      params: standard,
      subject: (f) => `Appointment reminder - ${f.practiceName}`,
      text: (f) =>
        `Hi ${f.patientFirstName},\n\nA reminder of your appointment at ${f.practiceName} on ${f.when} with ${f.practitionerName} at ${f.locationName}.` +
        footer(f),
    },
    APPOINTMENT_REMINDER_NEAR_TERM: {
      template: "appointment_reminder_soon",
      templateBody:
        "Hi {{1}}, your appointment at {{2}} is at {{3}} with {{4}} at {{5}}. We look forward to seeing you.",
      params: standard,
      subject: (f) => `Your appointment is coming up - ${f.practiceName}`,
      text: (f) =>
        `Hi ${f.patientFirstName},\n\nYour appointment at ${f.practiceName} is at ${f.when} with ${f.practitionerName} at ${f.locationName}.` +
        footer(f),
    },
    WAITLIST_OFFER: {
      template: "waitlist_offer",
      templateBody:
        "Hi {{1}}, an appointment has become available at {{2}}: {{3}} with {{4}} at {{5}}. Tap Book it before {{6}} to take it. If we do not hear from you, it will be offered to someone else.",
      params: (f) => [...standard(f), f.offerExpires ?? "-"],
      buttons: ["Book it", "No thanks"],
      buttonPayloads: (f) => [
        `OFFER:${f.offerId ?? ""}:ACCEPT`,
        `OFFER:${f.offerId ?? ""}:DECLINE`,
      ],
      subject: (f) => `An earlier appointment is available - ${f.practiceName}`,
      text: (f) =>
        `Hi ${f.patientFirstName},\n\nAn appointment has become available at ${f.practiceName}: ${f.when} with ${f.practitionerName} at ${f.locationName}. Contact the practice before ${f.offerExpires ?? "it lapses"} if you would like it.` +
        footer(f),
    },
  };

/** "Tuesday 14 October 2026 at 09:30" in the given zone. */
export function formatWhen(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone })
    .setLocale("en-ZA")
    .toFormat("cccc d LLLL yyyy 'at' HH:mm");
}
/** "09:30" (same day) or "Tue 14 Oct, 09:30". */
export function formatDeadline(
  instant: Date,
  timezone: string,
  now: Date,
): string {
  const at = DateTime.fromJSDate(instant, { zone: timezone }).setLocale(
    "en-ZA",
  );
  const today = DateTime.fromJSDate(now, { zone: timezone });
  return at.hasSame(today, "day")
    ? at.toFormat("HH:mm")
    : at.toFormat("ccc d LLL, HH:mm");
}
