import {
  APPOINTMENT_ACTIONS,
  assertActionTiming,
  assertTransition,
  checkSlot,
  findAvailableSlots,
  occupiesTime,
  type ActorKind,
  type AppointmentActionName,
  type AppointmentTiming,
  type CandidateSlot,
  type ScheduleContext,
  type SlotCheck,
  type SlotRefusal,
  type WeeklyRule,
} from "@access/scheduling/domain";
import { DateTime } from "luxon";
import {
  CONTENDERS,
  FOLLOWED,
  HOURS,
  LOCATION,
  NEXT,
  REQUESTS,
  TODAY,
  TYPES,
  ZONE,
  scenario,
  type AppointmentType,
  type Channel,
  type PractitionerId,
  type SampleRequest,
  type Status,
  type TypeId,
} from "./sample.js";

/**
 * The front page's appointment book: sample data in memory, with every
 * bookable time, refusal and status change decided by the Scheduling Core's
 * own domain rules (the same functions the API runs before the database's
 * exclusion constraint has the final word). Nothing here is a lookup table
 * of answers.
 */
export interface Booking {
  id: string;
  patient: string;
  number: string;
  type: TypeId;
  practitioner: PractitionerId;
  start: Date;
  end: Date;
  status: Status;
  channel: Channel;
}
export interface Days {
  today: string;
  next: string;
  now: Date;
}

const MINUTE = 60_000;
export const localAt = (date: string, hhmm: string): Date =>
  DateTime.fromISO(`${date}T${hhmm}`, { zone: ZONE }).toJSDate();
export const clock = (d: Date): string =>
  DateTime.fromJSDate(d, { zone: ZONE }).toFormat("HH:mm");
const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

export function timing(t: AppointmentType): AppointmentTiming {
  return {
    durationMinutes: t.minutes,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    slotIntervalMinutes: 15,
    minNoticeMinutes: 0,
    maxAdvanceDays: 60,
  };
}
const typeOf = (id: TypeId): AppointmentType => TYPES.find((t) => t.id === id)!;

export class Book {
  private seq = 0;
  constructor(
    readonly days: Days,
    readonly bookings: Booking[],
  ) {}

  static sample(days: Days = scenario()): Book {
    const book = new Book(days, []);
    for (const a of [...TODAY, ...NEXT]) {
      const start = localAt(a.day === "today" ? days.today : days.next, a.at);
      book.add({
        patient: a.patient,
        number: a.number,
        type: a.type,
        practitioner: a.practitioner,
        start,
        status: a.status,
        channel: a.channel,
      });
    }
    return book;
  }

  clone(): Book {
    const copy = new Book(
      this.days,
      this.bookings.map((b) => ({ ...b })),
    );
    copy.seq = this.seq;
    return copy;
  }

  add(b: Omit<Booking, "id" | "end">): Booking {
    const booking = {
      ...b,
      id: `sample-${++this.seq}`,
      end: new Date(+b.start + typeOf(b.type).minutes * MINUTE),
    };
    this.bookings.push(booking);
    return booking;
  }

  /** The practice's weekly hours as the Core's rules (Monday to Friday). */
  private rules(): WeeklyRule[] {
    return [1, 2, 3, 4, 5].flatMap((weekday) =>
      HOURS.map((h) => ({
        practitionerId: h.practitioner,
        locationId: LOCATION.id,
        weekday,
        startMinute: minutes(h.from),
        endMinute: minutes(h.to),
        validFrom: "2020-01-01",
        validUntil: null,
      })),
    );
  }

  context(type: TypeId, only?: PractitionerId): ScheduleContext {
    return {
      locations: new Map([[LOCATION.id, { timezone: ZONE }]]),
      pairs: typeOf(type)
        .practitioners.filter((p) => !only || p === only)
        .map((practitionerId) => ({
          practitionerId,
          locationId: LOCATION.id,
        })),
      rules: this.rules(),
      exceptions: [],
      blocks: [],
      occupancy: this.bookings
        .filter((b) => occupiesTime(b.status))
        .map((b) => ({
          practitionerId: b.practitioner,
          appointmentId: b.id,
          start: b.start,
          end: b.end,
        })),
    };
  }

  /** Bookable starts, exactly as the Core offers them. */
  free(
    type: TypeId,
    options: {
      from: Date;
      to: Date;
      practitioner?: PractitionerId;
      actor?: ActorKind;
      limit?: number;
    },
  ): CandidateSlot[] {
    return findAvailableSlots(
      {
        actor: options.actor ?? "STAFF",
        now: this.days.now,
        timing: timing(typeOf(type)),
        from: options.from,
        to: options.to,
        ...(options.limit ? { limit: options.limit } : {}),
      },
      this.context(type, options.practitioner),
    );
  }

  /** Whether one start can be booked now, and if not, the Core's reason. */
  check(
    type: TypeId,
    practitioner: PractitionerId,
    start: Date,
    actor: ActorKind = "STAFF",
  ): SlotCheck {
    return checkSlot(
      { actor, now: this.days.now, timing: timing(typeOf(type)) },
      this.context(type, practitioner),
      { practitionerId: practitioner, locationId: LOCATION.id, start },
    );
  }

  /** A visit step, allowed only where the Core's state machine and timing rules allow it. */
  act(id: string, action: AppointmentActionName): Booking {
    const b = this.bookings.find((x) => x.id === id)!;
    assertActionTiming({
      action,
      from: b.status,
      startsAt: b.start,
      timezone: ZONE,
      now: this.days.now,
    });
    b.status = APPOINTMENT_ACTIONS[action];
    return b;
  }

  on(day: "today" | "next"): Booking[] {
    const date = day === "today" ? this.days.today : this.days.next;
    const from = +localAt(date, "00:00");
    const to = from + 24 * 60 * MINUTE;
    return this.bookings
      .filter((b) => +b.start >= from && +b.start < to)
      .sort(
        (a, b) =>
          +a.start - +b.start || a.practitioner.localeCompare(b.practitioner),
      );
  }

  /** Any two time-consuming bookings of one practitioner that overlap (always none). */
  overlaps(): [Booking, Booking][] {
    const live = this.bookings.filter((b) => occupiesTime(b.status));
    const out: [Booking, Booking][] = [];
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!;
        const b = live[j]!;
        if (
          a.practitioner === b.practitioner &&
          a.start < b.end &&
          b.start < a.end
        )
          out.push([a, b]);
      }
    return out;
  }
}

export interface Placement {
  request: SampleRequest;
  booking: Booking;
  /** What the Core did, in the console's words. */
  outcome: string;
  cancelled?: Booking;
}

/**
 * The requests of the "every channel" act, each placed at the first time
 * the Core offers for it, in arrival order. The waitlist request is the
 * console's flow for a cancellation: the freed time is held for the first
 * patient in the queue until they answer.
 */
export function placeRequests(book: Book): Placement[] {
  const out: Placement[] = [];
  for (const request of REQUESTS) {
    const date = request.day === "today" ? book.days.today : book.days.next;
    const actor: ActorKind =
      request.channel === "WHATSAPP" ? "PATIENT" : "STAFF";
    if (request.channel === "WAITLIST") {
      const cancelled = book
        .on("today")
        .find((b) => b.patient === "Fatima Adams" && b.status === "CONFIRMED")!;
      book.act(cancelled.id, "cancel");
      const check = book.check(
        request.type,
        cancelled.practitioner,
        cancelled.start,
      );
      if (!check.ok) throw new Error(`freed time refused: ${check.code}`);
      const booking = book.add({
        patient: request.patient,
        number: "P002049",
        type: request.type,
        practitioner: cancelled.practitioner,
        start: cancelled.start,
        status: "HELD",
        channel: "WAITLIST",
      });
      out.push({
        request,
        booking,
        cancelled,
        outcome: `Offered ${clock(booking.start)}, held until he answers`,
      });
      continue;
    }
    const from =
      request.day === "today"
        ? new Date(Math.max(+book.days.now, +localAt(date, "00:00")))
        : localAt(date, "00:00");
    const [slot] = book.free(request.type, {
      from,
      to: localAt(date, "23:59"),
      ...(request.practitioner ? { practitioner: request.practitioner } : {}),
      actor,
      limit: 1,
    });
    if (!slot) throw new Error(`no time for ${request.patient}`);
    const booking = book.add({
      patient: request.patient,
      number: `P00${5300 + out.length}`,
      type: request.type,
      practitioner: slot.practitionerId as PractitionerId,
      start: slot.start,
      status: "CONFIRMED",
      channel: request.channel,
    });
    out.push({
      request,
      booking,
      outcome: `Booked ${request.day === "next" ? "tomorrow " : ""}${clock(booking.start)}`,
    });
  }
  return out;
}

/** A quarter hour of the followed doctor's next working day. */
export interface DayCell {
  start: Date;
  free: boolean;
}
/** The followed doctor's working quarter hours on the next day, free or taken, as the Core sees them for a patient. */
export function nextDayCells(book: Book): DayCell[] {
  const date = book.days.next;
  const doctor = FOLLOWED.practitioner;
  const free = new Set(
    book
      .free("consult", {
        from: localAt(date, "00:00"),
        to: localAt(date, "23:59"),
        practitioner: doctor,
        actor: "PATIENT",
      })
      .map((s) => +s.start),
  );
  return HOURS.filter((h) => h.practitioner === doctor).flatMap((h) => {
    const cells: DayCell[] = [];
    for (let m = minutes(h.from); m + 15 <= minutes(h.to); m += 15) {
      const start = localAt(
        date,
        `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
      );
      cells.push({ start, free: free.has(+start) });
    }
    return cells;
  });
}

export interface Entrant {
  channel: Channel;
  initials: string;
  /** Arrival, milliseconds after the first request. */
  after: number;
  followed: boolean;
}
export interface RaceResult {
  start: Date;
  winner: { entrant: Entrant; booking: Booking };
  refused: {
    entrant: Entrant;
    code: SlotRefusal;
    alternative: Booking;
  }[];
  book: Book;
}

/** Arrivals spread over less than 20 milliseconds, the followed patient first. */
export function entrants(): Entrant[] {
  const all = [
    {
      channel: "WHATSAPP" as Channel,
      initials: FOLLOWED.initials,
      followed: true,
    },
    ...CONTENDERS.map((c) => ({ ...c, followed: false })),
  ];
  return all.map((e, i) => ({ ...e, after: Math.round(i * 0.79 * 100) / 100 }));
}

/**
 * Twenty-five requests for the same time, taken in arrival order: the Core
 * checks each against the book as it stands, the first is held, and every
 * later one is refused and given the first time still free with either
 * doctor, that day or a later one. The database does the same with
 * simultaneous transactions.
 */
export function race(base: Book, start: Date): RaceResult {
  const book = base.clone();
  const doctor = FOLLOWED.practitioner;
  let winner: RaceResult["winner"] | null = null;
  const refused: RaceResult["refused"] = [];
  for (const entrant of entrants()) {
    const actor: ActorKind =
      entrant.channel === "WHATSAPP" ? "PATIENT" : "STAFF";
    const check = book.check("consult", doctor, start, actor);
    if (check.ok) {
      const booking = book.add({
        patient: entrant.followed ? FOLLOWED.patient : entrant.initials,
        number: entrant.followed ? "P003126" : "",
        type: "consult",
        practitioner: doctor,
        start,
        status: "HELD",
        channel: entrant.channel,
      });
      winner = { entrant, booking };
      continue;
    }
    // The next free time with either doctor, that day or a later one.
    const [next] = book.free("consult", {
      from: start,
      to: new Date(+start + 14 * 24 * 60 * MINUTE),
      actor,
      limit: 1,
    });
    if (!next) throw new Error("no free time in the next fortnight");
    refused.push({
      entrant,
      code: check.code,
      alternative: book.add({
        patient: entrant.initials,
        number: "",
        type: "consult",
        practitioner: next.practitionerId as PractitionerId,
        start: next.start,
        status: "CONFIRMED",
        channel: entrant.channel,
      }),
    });
  }
  if (!winner) throw new Error("nobody could hold the time");
  return { start, winner, refused, book };
}

/** A confirmation that turns the winner's hold into a booking, through the state machine. */
export function confirm(result: RaceResult): Booking {
  const b = result.winner.booking;
  assertTransition(b.status, "CONFIRMED");
  b.status = "CONFIRMED";
  return b;
}
