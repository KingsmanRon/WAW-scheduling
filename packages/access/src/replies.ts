import { DateTime } from "luxon";

/**
 * What the assistant says. Plain, administrative English; it never gives
 * clinical advice, never asks about symptoms, and always offers a person.
 */
export type OutboundMessage =
  | { kind: "text"; body: string }
  | {
      kind: "buttons";
      body: string;
      buttons: { id: string; title: string }[];
    }
  | {
      kind: "list";
      body: string;
      button: string;
      section: string;
      rows: { id: string; title: string; description?: string }[];
    };

export const text = (body: string): OutboundMessage => ({ kind: "text", body });

export function menu(practiceName: string, intro?: string): OutboundMessage {
  return {
    kind: "buttons",
    body:
      intro ??
      `Hi! This is the ${practiceName} booking assistant. What would you like to do?`,
    buttons: [
      { id: "M:BOOK", title: "Book appointment" },
      { id: "M:LIST", title: "My appointments" },
      { id: "M:STAFF", title: "Talk to reception" },
    ],
  };
}

export function emergency(practicePhone: string | null): OutboundMessage {
  return text(
    "If this is a medical emergency, call 10177 or 112 now, or go to your nearest emergency unit.\n\n" +
      "This WhatsApp line is only for appointments and cannot give medical advice. " +
      `A member of our team has been alerted and will reply here${practicePhone ? `, or call us on ${practicePhone}` : ""}.`,
  );
}

export function handoff(practicePhone: string | null): OutboundMessage {
  return text(
    "A member of our reception team will reply here as soon as they can during office hours." +
      (practicePhone ? ` You can also call us on ${practicePhone}.` : ""),
  );
}

export const UNSUPPORTED = text(
  "Sorry, I can only read text messages here. Please type your message, or reply MENU for options.",
);
export const OPTED_OUT = text(
  "Done - you will no longer receive reminders or updates from us on WhatsApp. You can still message us here to book. Reply SUBSCRIBE to turn reminders back on.",
);
export const OPTED_IN = text(
  "Thank you - we will send your appointment confirmations and reminders here.",
);
export const EXPIRED_OPTION = "That option is no longer available.";

/** "Tue 14 Oct, 09:30" (fits a 24-character list title). */
export function slotTitle(start: Date, timezone: string): string {
  return DateTime.fromJSDate(start, { zone: timezone })
    .setLocale("en-ZA")
    .toFormat("ccc d LLL, HH:mm");
}
/** "Tuesday 14 October at 09:30". */
export function longWhen(start: Date, timezone: string): string {
  return DateTime.fromJSDate(start, { zone: timezone })
    .setLocale("en-ZA")
    .toFormat("cccc d LLLL 'at' HH:mm");
}
