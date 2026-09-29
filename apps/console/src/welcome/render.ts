import { DateTime } from "luxon";
import { SchedulingError } from "@access/scheduling/domain";
import {
  Book,
  clock,
  entrants,
  localAt,
  nextDayCells,
  type Booking,
  type DayCell,
  type Placement,
  type RaceResult,
} from "./book";
import { bound, fill, h, icon } from "./dom";
import {
  CHANNEL_LABEL,
  FOLLOWED,
  PRACTITIONERS,
  REQUESTS,
  ZONE,
  practitioner,
  type,
  type Channel,
  type PractitionerId,
  type Status,
} from "./sample";

const STATUS: Record<Status, { text: string; tone: string }> = {
  HELD: { text: "Held", tone: "attention" },
  CONFIRMED: { text: "Booked", tone: "booked" },
  CHECKED_IN: { text: "Arrived", tone: "progress" },
  IN_PROGRESS: { text: "In consultation", tone: "progress" },
  COMPLETED: { text: "Completed", tone: "closed" },
  NO_SHOW: { text: "No-show", tone: "exception" },
  CANCELLED: { text: "Cancelled", tone: "closed" },
};
const CHANNEL_ICON: Record<
  Channel,
  "phone" | "account" | "message" | "document" | "waitlist"
> = {
  PHONE: "phone",
  WALK_IN: "account",
  WHATSAPP: "message",
  REFERRAL: "document",
  WAITLIST: "waitlist",
};
const day = (date: string, format: string) =>
  DateTime.fromISO(date, { zone: ZONE }).setLocale("en-ZA").toFormat(format);
export const when = (d: Date, format: string) =>
  DateTime.fromJSDate(d, { zone: ZONE }).setLocale("en-ZA").toFormat(format);
const statusBadge = (s: Status) =>
  h("span", { class: `wp-tone wp-tone--${STATUS[s].tone}` }, STATUS[s].text);
/** A cue that arrives at `from` and stays for the rest of its act. */
const holdFrom = (from: number, ramp = 0.05) =>
  `${from.toFixed(3)} 1 ${(ramp / (1 - from)).toFixed(3)} ${(0.02 / (1 - from)).toFixed(3)}`;

/* 1 · Today ---------------------------------------------------------------- */

export function renderToday(book: Book, onChange: () => void): void {
  fill("today-long", day(book.days.today, "cccc d LLLL yyyy"));
  fill("today-short", day(book.days.today, "cccc d LLLL"));
  fill("next-long", `${day(book.days.next, "cccc d LLLL")}, booked so far`);
  fill("followed-ask", FOLLOWED.ask);
  fill("request-count", String(REQUESTS.length));

  const today = book.on("today");
  const count = (s: Status[]) =>
    today.filter((b) => s.includes(b.status)).length;
  fill(
    "tiles",
    ...[
      ["Booked", count(["CONFIRMED", "HELD"])],
      ["Arrived", count(["CHECKED_IN"])],
      ["In consultation", count(["IN_PROGRESS"])],
      ["Completed", count(["COMPLETED"])],
      ["No-shows", count(["NO_SHOW"])],
    ].map(([label, n]) =>
      h(
        "li",
        {
          class: `wp-tile${label === "No-shows" ? " wp-tile--exception" : ""}`,
        },
        h("span", { class: "wp-tile__n" }, n),
        h("span", { class: "wp-tile__label" }, label),
      ),
    ),
  );

  const note = bound("today-note")[0];
  const step = (b: Booking, action: "check_in" | "start" | "complete") => {
    try {
      book.act(b.id, action);
      onChange();
    } catch (err) {
      if (note)
        note.textContent =
          err instanceof SchedulingError
            ? `The Scheduling Core refused: ${err.message}`
            : String(err);
    }
  };
  const actions = (b: Booking): HTMLElement[] => {
    const button = (
      text: string,
      action: "check_in" | "start" | "complete",
      quiet = false,
    ) => {
      const el = h(
        "button",
        { type: "button", class: `wp-mini${quiet ? " wp-mini--quiet" : ""}` },
        text,
      );
      el.addEventListener("click", () => step(b, action));
      el.setAttribute("aria-label", `${text}: ${b.patient}`);
      return el;
    };
    if (b.status === "CONFIRMED") return [button("Check in", "check_in")];
    if (b.status === "CHECKED_IN")
      return [button("Start", "start"), button("Complete", "complete", true)];
    if (b.status === "IN_PROGRESS") return [button("Complete", "complete")];
    return [];
  };
  fill(
    "today-list",
    ...today
      .filter((b) => b.status !== "CANCELLED")
      .map((b) =>
        h(
          "tr",
          { class: `wp-row wp-row--${b.status.toLowerCase()}` },
          h(
            "td",
            { class: "wp-num wp-nowrap" },
            `${clock(b.start)}–${clock(b.end)}`,
          ),
          h(
            "td",
            {},
            h("span", { class: "wp-strong" }, b.patient),
            " ",
            h("span", { class: "wp-mono wp-soft" }, b.number),
            h(
              "span",
              { class: "wp-sub" },
              `${type(b.type).name} · ${CHANNEL_LABEL[b.channel]}`,
            ),
          ),
          h("td", { class: "wp-nowrap" }, practitioner(b.practitioner).name),
          h("td", {}, statusBadge(b.status)),
          h("td", { class: "wp-actions" }, ...actions(b)),
        ),
      ),
  );

  fill(
    "next-preview",
    ...book
      .on("next")
      .slice(0, 9)
      .map((b) =>
        h(
          "li",
          {},
          h("span", { class: "wp-num" }, clock(b.start)),
          h("span", {}, practitioner(b.practitioner).name),
        ),
      ),
  );
}

/* 2 · Every channel -------------------------------------------------------- */

/** When each request arrives and is placed, in act progress. */
export const requestTiming = (i: number) => ({
  // They pile up faster than they could be handled by hand...
  arrives: 0.04 + i * 0.07,
  // ...and the Core clears them one by one.
  placed: 0.36 + i * 0.1,
});

export function renderChannels(before: Book, placed: Placement[]): void {
  fill(
    "feed",
    ...placed.map((p, i) => {
      const { arrives, placed: at } = requestTiming(i);
      return h(
        "li",
        { class: "wp-request", "data-sc-cue": holdFrom(arrives) },
        h(
          "p",
          { class: "wp-request__head" },
          h(
            "span",
            {
              class: `wp-channel wp-channel--${p.request.channel.toLowerCase()}`,
            },
            icon(CHANNEL_ICON[p.request.channel], 16),
            CHANNEL_LABEL[p.request.channel],
          ),
          h("span", { class: "wp-num wp-soft" }, p.request.at),
        ),
        h("p", { class: "wp-request__who" }, p.request.patient),
        h("p", { class: "wp-request__ask" }, p.request.ask),
        h(
          "p",
          { class: "wp-request__state" },
          h(
            "span",
            {
              class: "wp-state wp-state--waiting",
              "data-sc-cue": `${arrives.toFixed(3)} ${at.toFixed(3)} ${(0.05 / (at - arrives)).toFixed(3)} ${(0.03 / (at - arrives)).toFixed(3)}`,
            },
            "Checking the book…",
          ),
          h(
            "span",
            {
              class: "wp-state wp-state--done",
              "data-sc-cue": holdFrom(at, 0.03),
            },
            icon("check", 16),
            `${p.outcome} · ${practitioner(p.booking.practitioner).name}`,
          ),
        ),
      );
    }),
  );
  renderBoardToday(before, placed);
}

const ROW_FROM = 8 * 60;
const minuteOf = (d: Date) => {
  const t = DateTime.fromJSDate(d, { zone: ZONE });
  return t.hour * 60 + t.minute;
};
/** Grid rows (1-based) for a booking on a board starting at `from` minutes. */
const rows = (b: { start: Date; end: Date }, from = ROW_FROM) =>
  `${(minuteOf(b.start) - from) / 15 + 2} / span ${(+b.end - +b.start) / 900_000}`;
const column = (id: PractitionerId, ids: PractitionerId[]) =>
  String(ids.indexOf(id) + 2);

function renderBoardToday(before: Book, placed: Placement[]): void {
  const ids = PRACTITIONERS.map((p) => p.id);
  const until = 11 * 60;
  const inRange = (b: Booking) =>
    minuteOf(b.start) >= ROW_FROM && minuteOf(b.end) <= until;
  const board = bound("board-today")[0];
  if (!board) return;
  board.style.setProperty("--cols", String(ids.length));
  board.style.setProperty("--rows", String((until - ROW_FROM) / 15));
  const cells: HTMLElement[] = [
    ...PRACTITIONERS.map((p) => h("p", { class: "wp-board__col" }, p.name)),
  ];
  cells.forEach((el, i) => {
    el.style.gridColumn = String(i + 2);
    el.style.gridRow = "1";
  });
  for (let m = ROW_FROM; m < until; m += 60) {
    const el = h(
      "span",
      { class: "wp-board__hour" },
      `${String(m / 60).padStart(2, "0")}:00`,
    );
    el.style.gridRow = `${(m - ROW_FROM) / 15 + 2} / span 4`;
    el.style.gridColumn = "1";
    cells.push(el);
  }
  const block = (b: Booking, extra: string, cue?: string) => {
    const el = h(
      "p",
      {
        class: `wp-block ${extra}`,
        ...(cue ? { "data-sc-cue": cue, "data-sc-rise": "0" } : {}),
      },
      h("span", { class: "wp-num" }, clock(b.start)),
      " ",
      b.patient,
    );
    el.style.gridRow = rows(b);
    el.style.gridColumn = column(b.practitioner, ids);
    return el;
  };
  const cancelled = new Set(
    placed.flatMap((p) => (p.cancelled ? [p.cancelled.id] : [])),
  );
  for (const b of before.on("today").filter(inRange)) {
    if (b.status === "CANCELLED") continue;
    cells.push(block(b, "wp-block--base"));
    if (cancelled.has(b.id)) {
      const i = placed.findIndex((p) => p.cancelled?.id === b.id);
      const x = block(
        b,
        "wp-block--cancelled",
        holdFrom(requestTiming(i).arrives + 0.03, 0.03),
      );
      x.replaceChildren(h("span", {}, "Cancelled"));
      cells.push(x);
    }
  }
  const todayDate = before.days.today;
  placed.forEach((p, i) => {
    if (
      when(p.booking.start, "yyyy-MM-dd") !== todayDate ||
      !inRange(p.booking)
    )
      return;
    cells.push(
      block(
        p.booking,
        `wp-block--new${p.booking.status === "HELD" ? " wp-block--held" : ""}`,
        holdFrom(requestTiming(i).placed, 0.03),
      ),
    );
  });
  board.replaceChildren(...cells);
}

/* 3 · WhatsApp ------------------------------------------------------------- */

export function renderWhatsApp(
  book: Book,
  chosen: Date,
  choose: (start: Date) => void,
): DayCell[] {
  const cells = nextDayCells(book);
  const offered = cells
    .filter((c) => c.free && minuteOf(c.start) < 13 * 60)
    .slice(0, 3);
  const pick = (start: Date, label: string) => {
    const el = h(
      "button",
      {
        type: "button",
        class: "wp-option",
        "aria-pressed": String(+start === +chosen),
      },
      label,
    );
    el.addEventListener("click", () => choose(start));
    return el;
  };
  fill(
    "thread",
    h(
      "li",
      { class: "wp-bubble wp-bubble--in" },
      FOLLOWED.ask,
      h("small", {}, "08:59"),
    ),
    h(
      "li",
      { class: "wp-bubble wp-bubble--out" },
      `Dr Nkosi's first free times on ${day(book.days.next, "cccc d LLLL")}:`,
      h(
        "span",
        { class: "wp-options" },
        ...offered.map((c) => pick(c.start, clock(c.start))),
      ),
      h("small", {}, "Assistant · 08:59"),
    ),
    h(
      "li",
      { class: "wp-bubble wp-bubble--in wp-bubble--tap" },
      `${clock(chosen)} please`,
      h("small", {}, "Sending at 09:06:02"),
    ),
  );

  const items: HTMLElement[] = [
    h("li", { class: "wp-day__spacer", "aria-hidden": "true" }),
    h(
      "li",
      { class: "wp-day__lead" },
      h("p", { class: "wp-day__title" }, day(book.days.next, "cccc d LLLL")),
      h(
        "p",
        { class: "wp-soft" },
        "Dr Lindiwe Nkosi, quarter hour by quarter hour",
      ),
    ),
  ];
  let lastEnd = 0;
  for (const c of cells) {
    const m = minuteOf(c.start);
    if (lastEnd && m > lastEnd)
      items.push(
        h(
          "li",
          { class: "wp-cell wp-cell--closed" },
          h("span", { class: "wp-num" }, clock(new Date(+c.start - 3_600_000))),
          h("span", {}, "Lunch"),
        ),
      );
    lastEnd = m + 15;
    if (!c.free) {
      items.push(
        h(
          "li",
          { class: "wp-cell wp-cell--taken" },
          h("span", { class: "wp-num" }, clock(c.start)),
          h("span", {}, "Booked"),
        ),
      );
      continue;
    }
    const button = h(
      "button",
      {
        type: "button",
        class: "wp-cell__pick",
        "aria-pressed": String(+c.start === +chosen),
      },
      h("span", { class: "wp-num" }, clock(c.start)),
      h("span", {}, +c.start === +chosen ? "Her time" : "Free"),
    );
    button.setAttribute(
      "aria-label",
      `${clock(c.start)}, free${+c.start === +chosen ? ", chosen" : ""}`,
    );
    button.addEventListener("click", () => choose(c.start));
    items.push(h("li", { class: "wp-cell" }, button));
  }
  items.push(
    h(
      "li",
      { class: "wp-day__note" },
      h("p", {}, `She taps ${clock(chosen)}.`),
      h(
        "p",
        { class: "wp-soft" },
        "At the same moment, 24 other people ask for it too.",
      ),
    ),
  );
  bound("day")[0]?.replaceChildren(...items);
  return cells;
}

/* 4 · The race ------------------------------------------------------------- */

const RACE_DOCTORS: PractitionerId[] = ["p-nkosi", "p-smit"];
const NEXT_FROM = 8 * 60;
const NEXT_UNTIL = 17 * 60;
/** When the 24 refused requests leave the lit cell, in act progress. */
export const deflectAt = (i: number) => 0.46 + i * 0.012;
export const DEFLECT_FOR = 0.1;

/**
 * Builds the race board once, with a fixed set of elements (the engine
 * keeps references to every cue it found at mount); a new choice of time
 * only moves and relabels them.
 */
export function buildRace(): void {
  const board = bound("board-next")[0]!;
  board.style.setProperty("--cols", String(RACE_DOCTORS.length));
  board.style.setProperty("--rows", String((NEXT_UNTIL - NEXT_FROM) / 15 + 1));
  const fixed: HTMLElement[] = [];
  RACE_DOCTORS.forEach((id, i) => {
    const el = h("p", { class: "wp-board__col" }, practitioner(id).name);
    el.style.gridColumn = String(i + 2);
    el.style.gridRow = "1";
    fixed.push(el);
  });
  for (let m = NEXT_FROM; m < NEXT_UNTIL; m += 60) {
    const el = h(
      "span",
      { class: "wp-board__hour" },
      `${String(m / 60).padStart(2, "0")}:00`,
    );
    el.style.gridRow = `${(m - NEXT_FROM) / 15 + 2} / span 4`;
    el.style.gridColumn = "1";
    fixed.push(el);
  }
  const lunch = h("span", { class: "wp-board__closed" }, "Lunch");
  lunch.style.gridRow = `${(13 * 60 - NEXT_FROM) / 15 + 2} / span 4`;
  lunch.style.gridColumn = `2 / span ${RACE_DOCTORS.length}`;
  fixed.push(lunch);
  const layer = h("div", {
    class: "wp-board__layer",
    "data-bind": "race-base",
  });
  layer.style.display = "contents";
  const target = h("p", {
    class: "wp-block wp-block--target",
    "data-bind": "race-target",
  });
  const held = h("p", {
    class: "wp-block wp-block--won",
    "data-bind": "race-held",
    "data-sc-cue": "0.4 1 0.06 0.03",
    "data-sc-rise": "0",
  });
  const alternatives = Array.from({ length: 24 }, (_, i) =>
    h("p", {
      class: "wp-block wp-block--alt",
      "data-bind": "race-alt",
      "data-sc-cue": holdFrom(deflectAt(i) + DEFLECT_FOR * 0.8, 0.02),
      "data-sc-rise": "0",
    }),
  );
  // Requests the day cannot hold go to the next working day.
  const later = h("p", {
    class: "wp-board__later",
    "data-bind": "race-later",
    "data-sc-cue": holdFrom(0.72, 0.03),
    "data-sc-rise": "0",
  });
  later.style.gridRow = `${(NEXT_UNTIL - NEXT_FROM) / 15 + 2}`;
  later.style.gridColumn = `2 / span ${RACE_DOCTORS.length}`;
  board.replaceChildren(...fixed, layer, target, held, ...alternatives, later);

  const chips = bound("chips")[0]!;
  chips.replaceChildren(
    ...entrants().map((e, i) =>
      h(
        "span",
        {
          class: `wp-chip${e.followed ? " wp-chip--first" : ""}`,
          "data-bind": "race-chip",
        },
        icon(CHANNEL_ICON[e.channel], 14),
        e.initials,
        i === 0 ? h("span", { class: "vh" }, " (Lerato Mahlangu)") : null,
      ),
    ),
  );
  chips.querySelectorAll<HTMLElement>(".wp-chip").forEach((el, i) => {
    el.style.setProperty("--i", String(i));
    if (i > 0) el.style.setProperty("--d0", deflectAt(i - 1).toFixed(3));
  });
}

export function renderRace(result: RaceResult, before: Book): void {
  fill(
    "race-context",
    `${day(before.days.next, "cccc d LLLL")} · ${clock(result.start)} with Dr Lindiwe Nkosi`,
  );
  fill("race-time", `${clock(result.start)} with Dr Nkosi`);
  const place = (
    el: HTMLElement,
    b: { start: Date; end: Date; practitioner: PractitionerId },
  ) => {
    el.style.gridRow = rows(b, NEXT_FROM);
    el.style.gridColumn = column(b.practitioner, RACE_DOCTORS);
  };
  const base = bound("race-base")[0]!;
  base.replaceChildren(
    ...before
      .on("next")
      .filter((b) => RACE_DOCTORS.includes(b.practitioner))
      .map((b) => {
        const el = h(
          "p",
          { class: "wp-block wp-block--base" },
          h("span", { class: "wp-num" }, clock(b.start)),
        );
        place(el, b);
        return el;
      }),
  );
  const slot = {
    start: result.start,
    end: result.winner.booking.end,
    practitioner: "p-nkosi" as PractitionerId,
  };
  const target = bound("race-target")[0]!;
  place(target, slot);
  target.replaceChildren(
    h("span", { class: "wp-num" }, clock(result.start)),
    " Free",
  );
  const held = bound("race-held")[0]!;
  place(held, slot);
  held.replaceChildren(
    h("span", { class: "wp-num" }, clock(result.start)),
    ` Held · ${FOLLOWED.initials} · WhatsApp`,
  );
  const nextDate = before.days.next;
  const dateOf = (d: Date) => when(d, "yyyy-MM-dd");
  bound("race-alt").forEach((el, i) => {
    const r = result.refused[i]!;
    el.hidden = dateOf(r.alternative.start) !== nextDate;
    if (el.hidden) return;
    place(el, r.alternative);
    el.replaceChildren(
      h("span", { class: "wp-num" }, clock(r.alternative.start)),
      ` ${r.entrant.initials}`,
    );
  });
  const moved = result.refused.filter(
    (r) => dateOf(r.alternative.start) !== nextDate,
  );
  const days = new Set(moved.map((r) => dateOf(r.alternative.start)));
  const later = bound("race-later")[0]!;
  later.hidden = moved.length === 0;
  later.replaceChildren(
    `${moved.length} placed on ${
      days.size === 1 ? day([...days][0]!, "cccc") : "later days"
    }, the next free times`,
  );
}

/** Chip start, lit-cell and final positions, measured on the laid-out board. */
export function measureRace(): void {
  const field = bound("field")[0];
  if (!field) return;
  const box = field.getBoundingClientRect();
  if (!box.width) return;
  const centre = (el: Element) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2 - box.left,
      y: r.top + r.height / 2 - box.top,
    };
  };
  const target = centre(bound("race-target")[0]!);
  const later = bound("race-later")[0]!;
  // A request placed on a later day heads for the note that counts them.
  const alts = bound("race-alt").map((el) => centre(el.hidden ? later : el));
  const chips = bound("race-chip");
  const n = chips.length;
  chips.forEach((el, i) => {
    // Arrivals from every side, spread by the golden angle, just outside the board.
    const angle = i * 2.39996 + 0.6;
    const rx = box.width * 0.62;
    const ry = box.height * 0.58;
    const x0 = box.width / 2 + Math.cos(angle) * rx;
    const y0 = box.height / 2 + Math.sin(angle) * ry;
    const end = i === 0 ? target : alts[i - 1]!;
    // Each refused request bounces off on its own heading before it lands.
    const jitter = ((i * 37) % 11) - 5;
    const set = (k: string, v: number) =>
      el.style.setProperty(k, `${v.toFixed(1)}px`);
    set("--x0", x0);
    set("--y0", y0);
    set("--xc", target.x + jitter * 1.5);
    set("--yc", target.y + (((i * 53) % 7) - 3));
    set("--x1", end.x);
    set("--y1", end.y);
    el.style.setProperty("--n", String(n));
  });
}

/* 5 · The record ----------------------------------------------------------- */

export function renderRecord(result: RaceResult, before: Book): void {
  const b = result.winner.booking;
  fill(
    "record-title",
    `${FOLLOWED.patient} · ${when(b.start, "ccc d LLL")}, ${clock(b.start)}`,
  );
  fill(
    "record-context",
    `General consultation with Dr Lindiwe Nkosi at Main rooms · booked through WhatsApp`,
  );
  const today = before.days.today;
  const t = (hhmmss: string) =>
    DateTime.fromISO(`${today}T${hhmmss}`, { zone: ZONE }).toJSDate();
  const reminder = new Date(+b.start - 24 * 3_600_000);
  const event = (title: string, detail: string, at: string, i: number) =>
    h(
      "li",
      {
        "data-sc-reveal": "left",
        "data-sc-reveal-at": `${(0.16 + i * 0.07).toFixed(2)} ${(0.3 + i * 0.07).toFixed(2)}`,
      },
      h("span", { class: "wp-events__what" }, title),
      h("time", { class: "wp-num" }, at),
      h("small", {}, detail),
    );
  fill(
    "history",
    event(
      "Held",
      "Patient · WhatsApp · first of 25 requests",
      when(t("09:06:02.118"), "HH:mm:ss.SSS"),
      0,
    ),
    event(
      "24 requests refused",
      "SLOT_UNAVAILABLE · each given the next free time",
      `within ${Math.ceil(entrants().at(-1)!.after)} ms`,
      1,
    ),
    event(
      "Confirmed",
      "Patient replied YES · WhatsApp",
      when(t("09:06:40"), "HH:mm:ss"),
      2,
    ),
  );
  fill(
    "messages",
    event(
      "Confirmation · WhatsApp",
      "Sent · consent recorded",
      when(t("09:06:41"), "HH:mm:ss"),
      0,
    ),
    event(
      "24-hour reminder · WhatsApp",
      "Planned",
      when(reminder, "ccc d LLL, HH:mm"),
      1,
    ),
  );
}

/* 6 · Sign in -------------------------------------------------------------- */

export function renderCarry(result: RaceResult, finished: boolean): void {
  fill(
    "carry",
    finished
      ? `In the sample practice you gave Lerato ${when(result.start, "cccc")} ${clock(result.start)} with Dr Nkosi, and 24 other requests for it were refused. Sign in to run your own practice's book.`
      : "New here? A sample morning runs above, computed in your browser.",
  );
}

export function nextDayStart(book: Book): Date {
  return localAt(book.days.next, "00:00");
}
