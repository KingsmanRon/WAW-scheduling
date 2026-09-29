import { DateTime } from "luxon";

/**
 * The front page's sample practice. Every name, time and request here is
 * fictional, and the page says so on its face. Nothing is precomputed: the
 * times the page shows are derived from these arrays by the Scheduling
 * Core's own availability rules (see book.ts).
 */
export const ZONE = "Africa/Johannesburg";
export const LOCATION = { id: "loc-main", name: "Main rooms" };
export const PRACTICE_NAME = "Jacaranda Family Practice";

export type PractitionerId = "p-nkosi" | "p-smit" | "p-molefe";
export interface Practitioner {
  id: PractitionerId;
  name: string;
}
export const PRACTITIONERS: Practitioner[] = [
  { id: "p-nkosi", name: "Dr Lindiwe Nkosi" },
  { id: "p-smit", name: "Dr Johan Smit" },
  { id: "p-molefe", name: "Sr Grace Molefe" },
];
export const practitioner = (id: string): Practitioner =>
  PRACTITIONERS.find((p) => p.id === id)!;

export type TypeId = "consult" | "chronic" | "bp";
export interface AppointmentType {
  id: TypeId;
  name: string;
  minutes: number;
  practitioners: PractitionerId[];
}
export const TYPES: AppointmentType[] = [
  {
    id: "consult",
    name: "General consultation",
    minutes: 15,
    practitioners: ["p-nkosi", "p-smit"],
  },
  {
    id: "chronic",
    name: "Chronic medication review",
    minutes: 30,
    practitioners: ["p-nkosi", "p-smit"],
  },
  {
    id: "bp",
    name: "Blood pressure check",
    minutes: 15,
    practitioners: ["p-molefe"],
  },
];
export const type = (id: TypeId): AppointmentType =>
  TYPES.find((t) => t.id === id)!;

/** Weekly hours, Monday to Friday: doctors break for lunch, the sister works mornings. */
export const HOURS: {
  practitioner: PractitionerId;
  from: string;
  to: string;
}[] = [
  { practitioner: "p-nkosi", from: "08:00", to: "13:00" },
  { practitioner: "p-nkosi", from: "14:00", to: "17:00" },
  { practitioner: "p-smit", from: "08:00", to: "13:00" },
  { practitioner: "p-smit", from: "14:00", to: "17:00" },
  { practitioner: "p-molefe", from: "08:00", to: "13:00" },
];

export type Channel =
  "PHONE" | "WALK_IN" | "WHATSAPP" | "REFERRAL" | "WAITLIST";
export const CHANNEL_LABEL: Record<Channel, string> = {
  PHONE: "Phone",
  WALK_IN: "Desk",
  WHATSAPP: "WhatsApp",
  REFERRAL: "Referral",
  WAITLIST: "Waitlist",
};

export type Status =
  | "HELD"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW";

/** One appointment as sample data: a local time on the scenario's day or the next working day. */
export interface SampleAppointment {
  patient: string;
  number: string;
  type: TypeId;
  practitioner: PractitionerId;
  day: "today" | "next";
  at: string;
  status: Status;
  channel: Channel;
}

export const TODAY: SampleAppointment[] = [
  [
    "Thabo Dlamini",
    "P004117",
    "consult",
    "p-nkosi",
    "08:00",
    "COMPLETED",
    "PHONE",
  ],
  [
    "Anele Zulu",
    "P002380",
    "consult",
    "p-nkosi",
    "08:15",
    "COMPLETED",
    "WHATSAPP",
  ],
  [
    "Pieter du Toit",
    "P001952",
    "chronic",
    "p-nkosi",
    "08:30",
    "IN_PROGRESS",
    "PHONE",
  ],
  [
    "Naledi Dube",
    "P000874",
    "consult",
    "p-nkosi",
    "09:00",
    "CHECKED_IN",
    "WHATSAPP",
  ],
  [
    "Fatima Adams",
    "P003305",
    "consult",
    "p-nkosi",
    "09:15",
    "CONFIRMED",
    "PHONE",
  ],
  [
    "Kagiso Sithole",
    "P005021",
    "consult",
    "p-nkosi",
    "09:45",
    "CONFIRMED",
    "WHATSAPP",
  ],
  [
    "Megan Botha",
    "P002216",
    "chronic",
    "p-nkosi",
    "10:30",
    "CONFIRMED",
    "REFERRAL",
  ],
  [
    "Sipho Khumalo",
    "P001408",
    "consult",
    "p-smit",
    "08:00",
    "COMPLETED",
    "WALK_IN",
  ],
  ["Ayesha Patel", "P004670", "consult", "p-smit", "08:30", "NO_SHOW", "PHONE"],
  [
    "Johan Pretorius",
    "P000519",
    "consult",
    "p-smit",
    "08:45",
    "CHECKED_IN",
    "PHONE",
  ],
  [
    "Ruth Nel",
    "P003998",
    "consult",
    "p-smit",
    "09:00",
    "CONFIRMED",
    "WHATSAPP",
  ],
  [
    "Bongani Mthembu",
    "P002764",
    "chronic",
    "p-smit",
    "10:00",
    "CONFIRMED",
    "PHONE",
  ],
  [
    "Lindiwe Ndlovu",
    "P001177",
    "bp",
    "p-molefe",
    "08:30",
    "COMPLETED",
    "WALK_IN",
  ],
  [
    "Zanele Mokoena",
    "P003541",
    "bp",
    "p-molefe",
    "09:00",
    "CONFIRMED",
    "WHATSAPP",
  ],
  ["Themba Ngcobo", "P004402", "bp", "p-molefe", "09:30", "CONFIRMED", "PHONE"],
].map(([patient, number, t, p, at, status, channel]) => ({
  patient: patient!,
  number: number!,
  type: t as TypeId,
  practitioner: p as PractitionerId,
  day: "today" as const,
  at: at!,
  status: status as Status,
  channel: channel as Channel,
}));

/** Already booked on the next working day, so its free times are real gaps. */
export const NEXT: SampleAppointment[] = [
  ["p-nkosi", "08:00", "consult"],
  ["p-nkosi", "08:15", "consult"],
  ["p-nkosi", "08:30", "consult"],
  ["p-nkosi", "08:45", "chronic"],
  ["p-nkosi", "09:15", "consult"],
  ["p-nkosi", "09:30", "consult"],
  ["p-nkosi", "09:45", "consult"],
  ["p-nkosi", "10:00", "consult"],
  ["p-nkosi", "10:45", "consult"],
  ["p-nkosi", "11:30", "chronic"],
  ["p-nkosi", "14:00", "consult"],
  ["p-nkosi", "15:15", "consult"],
  ["p-smit", "08:00", "chronic"],
  ["p-smit", "09:00", "consult"],
  ["p-smit", "09:15", "consult"],
  ["p-smit", "11:00", "consult"],
  ["p-smit", "14:30", "chronic"],
  ["p-molefe", "08:00", "bp"],
  ["p-molefe", "09:15", "bp"],
].map(([p, at, t], i) => ({
  patient: `Booked patient ${i + 1}`,
  number: `P00${6100 + i}`,
  type: t as TypeId,
  practitioner: p as PractitionerId,
  day: "next" as const,
  at: at!,
  status: "CONFIRMED" as const,
  channel: "PHONE" as const,
}));

/** Requests that reach reception in the minutes after the page's "now". */
export interface SampleRequest {
  at: string;
  channel: Channel;
  patient: string;
  ask: string;
  type: TypeId;
  practitioner?: PractitionerId;
  day: "today" | "next";
}
export const REQUESTS: SampleRequest[] = [
  {
    at: "08:58",
    channel: "PHONE",
    patient: "Riaan Venter",
    ask: "Wants Dr Smit this morning",
    type: "consult",
    practitioner: "p-smit",
    day: "today",
  },
  {
    at: "08:59",
    channel: "WALK_IN",
    patient: "Grace Mahlaba",
    ask: "At the desk, any doctor",
    type: "consult",
    day: "today",
  },
  {
    at: "09:01",
    channel: "WHATSAPP",
    patient: "Precious Mahlangu",
    ask: "Blood pressure check tomorrow",
    type: "bp",
    day: "next",
  },
  {
    at: "09:03",
    channel: "REFERRAL",
    patient: "Karabo Nkuna",
    ask: "Referred by Dr P. Moodley for a medication review",
    type: "chronic",
    day: "today",
  },
  {
    at: "09:05",
    channel: "WAITLIST",
    patient: "Sipho Dlamini",
    ask: "First on the waitlist when Fatima Adams cancels 09:15",
    type: "consult",
    practitioner: "p-nkosi",
    day: "today",
  },
];

/** The WhatsApp patient the page follows, and the doctor she asks for. */
export const FOLLOWED = {
  patient: "Lerato Mahlangu",
  initials: "LM",
  practitioner: "p-nkosi" as PractitionerId,
  ask: "Hi, can I see Dr Nkosi tomorrow morning?",
};

/** Who else reaches for the same time in the same 20 milliseconds. */
export const CONTENDERS: { channel: Channel; initials: string }[] = [
  ["PHONE", "RV"],
  ["WALK_IN", "TM"],
  ["WHATSAPP", "NS"],
  ["PHONE", "AK"],
  ["WAITLIST", "SD"],
  ["WHATSAPP", "BN"],
  ["PHONE", "MB"],
  ["REFERRAL", "KS"],
  ["WHATSAPP", "ZM"],
  ["WALK_IN", "PD"],
  ["PHONE", "HJ"],
  ["WHATSAPP", "OT"],
  ["WAITLIST", "FA"],
  ["PHONE", "YP"],
  ["WHATSAPP", "DM"],
  ["REFERRAL", "LN"],
  ["PHONE", "JB"],
  ["WHATSAPP", "CK"],
  ["WALK_IN", "EV"],
  ["PHONE", "GS"],
  ["WHATSAPP", "IM"],
  ["WAITLIST", "UN"],
  ["PHONE", "WZ"],
  ["WHATSAPP", "XT"],
].map(([channel, initials]) => ({
  channel: channel as Channel,
  initials: initials!,
}));

/**
 * The scenario's day: today at the practice, or the Monday after a weekend,
 * with "now" fixed at 08:57 so the morning reads the same whenever the page
 * is opened. The next working day follows it.
 */
export function scenario(now: DateTime = DateTime.now()): {
  today: string;
  next: string;
  now: Date;
} {
  let day = now.setZone(ZONE).startOf("day");
  while (day.weekday > 5) day = day.plus({ days: 1 });
  let next = day.plus({ days: 1 });
  while (next.weekday > 5) next = next.plus({ days: 1 });
  return {
    today: day.toISODate()!,
    next: next.toISODate()!,
    now: day.set({ hour: 8, minute: 57 }).toJSDate(),
  };
}
