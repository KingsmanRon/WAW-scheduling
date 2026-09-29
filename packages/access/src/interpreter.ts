/**
 * Deterministic interpretation of a patient's WhatsApp message. It maps
 * words, numbers and tapped options onto a small closed set of intents; it
 * never decides anything consequential - the conversation engine asks the
 * Scheduling Core, and every booking, move or cancellation is confirmed by
 * an explicit tap or "yes" on the exact slot or appointment shown.
 */
export type Intent =
  | { kind: "SAFETY" }
  | { kind: "OPT_OUT" }
  | { kind: "OPT_IN" }
  /** "hi", "hello": opens the menu, but never takes a conversation from staff. */
  | { kind: "GREETING" }
  | { kind: "MENU" }
  | { kind: "BOOK" }
  | { kind: "LIST" }
  | { kind: "CANCEL" }
  | { kind: "RESCHEDULE" }
  | { kind: "HANDOFF" }
  | { kind: "YES" }
  | { kind: "NO" }
  | { kind: "MORE" }
  /** A tapped interactive option (its id as we sent it). */
  | { kind: "CHOICE"; id: string }
  /** "2": the second option currently offered. */
  | { kind: "NUMBER"; n: number }
  /** Free text (a name while registering, or something not understood). */
  | { kind: "TEXT"; text: string }
  | { kind: "UNSUPPORTED" };

export interface InboundContent {
  kind: "TEXT" | "BUTTON_REPLY" | "LIST_REPLY" | "UNSUPPORTED";
  text: string | null;
  replyId: string | null;
}

/**
 * Words that may signal a medical emergency. Matching stops the automated
 * flow, gives emergency guidance and hands the conversation to staff. It
 * errs on the side of caution; it is not triage and gives no advice.
 */
const SAFETY = [
  /\bemergenc/,
  /\bambulance\b/,
  /\bchest pains?\b/,
  /\b(can'?t|cannot|can not|unable to|difficulty|trouble|struggling to) breath/,
  /\bshort(ness)? of breath\b/,
  /\bnot breathing\b/,
  /\bunconscious\b/,
  /\b(passed|passing) out\b/,
  /\bfaint(ed|ing)\b/,
  /\bseizure|\bfitting\b|\bconvuls/,
  /\bstroke\b/,
  /\bheart attack\b/,
  /\b(heavy|severe|bad|lots of) bleed|\bbleeding (heavily|a lot|badly)\b|\bwon'?t stop bleeding\b/,
  /\boverdose|\bpoison/,
  /\bsuicid|\bkill (myself|me)\b|\bend my life\b|\bself[- ]?harm|\bhurt(ing)? myself\b/,
  /\b(severe|extreme|unbearable) pain\b/,
  /\bcollapsed?\b/,
];
export function isSafetyConcern(text: string): boolean {
  const t = normalise(text);
  return SAFETY.some((re) => re.test(t));
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EXACT: Record<string, Intent["kind"]> = {
  hi: "GREETING",
  hello: "GREETING",
  hey: "GREETING",
  hallo: "GREETING",
  "good morning": "GREETING",
  "good afternoon": "GREETING",
  "good evening": "GREETING",
  menu: "MENU",
  start: "MENU",
  restart: "MENU",
  "main menu": "MENU",
  back: "MENU",
  yes: "YES",
  y: "YES",
  yebo: "YES",
  ja: "YES",
  ok: "YES",
  okay: "YES",
  confirm: "YES",
  "yes please": "YES",
  sure: "YES",
  no: "NO",
  n: "NO",
  nee: "NO",
  "no thanks": "NO",
  "no thank you": "NO",
  more: "MORE",
  "more times": "MORE",
  "other times": "MORE",
  stop: "OPT_OUT",
  unsubscribe: "OPT_OUT",
  "stop messages": "OPT_OUT",
  "opt out": "OPT_OUT",
  subscribe: "OPT_IN",
  "opt in": "OPT_IN",
  "reminders on": "OPT_IN",
};
const PHRASES: [RegExp, Intent["kind"]][] = [
  [
    /\b(speak|talk|chat) (to|with)\b|\b(human|person|receptionist|reception|staff|agent|someone)\b|\bcall me\b/,
    "HANDOFF",
  ],
  [/\bcancel/, "CANCEL"],
  [
    /\b(reschedul|re-schedul|change|move|postpone)\w*\b.*\b(appointment|booking|time|date)\b|^(reschedule|change|move|postpone)\b/,
    "RESCHEDULE",
  ],
  [
    /\b(my|next|upcoming) (appointment|appointments|booking|bookings)\b|\bwhen is my\b/,
    "LIST",
  ],
  [
    /\b(book|appointment|make an? appointment|see (a|the) (doctor|dr)|consult|visit)\b/,
    "BOOK",
  ],
];

export function interpret(message: InboundContent): Intent {
  if (message.kind === "UNSUPPORTED") return { kind: "UNSUPPORTED" };
  // A tapped option: its id is authoritative (and validated by the engine
  // against what this conversation was actually offered).
  if (message.replyId) {
    if (message.text && isSafetyConcern(message.text))
      return { kind: "SAFETY" };
    return { kind: "CHOICE", id: message.replyId };
  }
  const raw = (message.text ?? "").trim();
  if (!raw) return { kind: "TEXT", text: "" };
  if (isSafetyConcern(raw)) return { kind: "SAFETY" };
  const t = normalise(raw);
  const exact = EXACT[t];
  if (exact) return { kind: exact } as Intent;
  if (/^\d{1,2}$/.test(t)) return { kind: "NUMBER", n: Number(t) };
  for (const [re, kind] of PHRASES) if (re.test(t)) return { kind } as Intent;
  return { kind: "TEXT", text: raw.slice(0, 500) };
}

/** "12/04/1985", "12-04-1985", "12.4.1985" or "1985-04-12" to ISO date. */
export function parseDateOfBirth(text: string, today: Date): string | null {
  const t = text.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{4})$/.exec(t);
  if (match) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)))
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  )
    return null;
  if (y < 1900 || +date > +today) return null;
  return date.toISOString().slice(0, 10);
}

/** "Thandi Mokoena" to given and family name; null when not a full name. */
export function parseFullName(
  text: string,
): { givenName: string; familyName: string } | null {
  const parts = text.trim().replace(/\s+/g, " ").split(" ");
  if (
    parts.length < 2 ||
    parts.join(" ").length > 120 ||
    parts.some((p) => !/^[\p{L}][\p{L}'’-]*$/u.test(p))
  )
    return null;
  return {
    givenName: parts.slice(0, -1).join(" "),
    familyName: parts[parts.length - 1]!,
  };
}
