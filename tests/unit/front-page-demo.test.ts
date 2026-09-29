import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  Book,
  clock,
  confirm,
  entrants,
  nextDayCells,
  placeRequests,
  race,
} from "../../apps/console/src/welcome/book.js";
import {
  REQUESTS,
  ZONE,
  scenario,
} from "../../apps/console/src/welcome/sample.js";

/**
 * The front page runs the Scheduling Core's own availability rules on
 * sample data in the browser. These tests hold it to what the page claims.
 */
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE });

describe("front page demonstration", () => {
  const days = scenario(at("2026-09-29T14:00"));

  it("runs on a working day, with the next working day after it", () => {
    expect(days.today).toBe("2026-09-29");
    expect(days.next).toBe("2026-09-30");
    expect(clock(days.now)).toBe("08:57");
    // A weekend visit shows Monday; Friday's next working day is Monday.
    expect(scenario(at("2026-10-03T10:00")).today).toBe("2026-10-05");
    expect(scenario(at("2026-10-02T10:00")).next).toBe("2026-10-05");
  });

  it("places every request at a time the Core offers, and never twice", () => {
    const book = Book.sample(days);
    const placed = placeRequests(book);
    expect(placed.map((p) => p.request.patient)).toEqual(
      REQUESTS.map((r) => r.patient),
    );
    expect(book.overlaps()).toEqual([]);
    // The waitlist takes the time a cancellation freed, as a hold.
    const offer = placed.at(-1)!;
    expect(offer.cancelled?.status).toBe("CANCELLED");
    expect(offer.booking.status).toBe("HELD");
    expect(+offer.booking.start).toBe(+offer.cancelled!.start);
  });

  it("gives one time to the first of 25 requests and refuses the other 24", () => {
    const book = Book.sample(days);
    placeRequests(book);
    const free = nextDayCells(book).filter((c) => c.free);
    expect(free.length).toBeGreaterThan(10);
    expect(entrants()).toHaveLength(25);
    expect(entrants().at(-1)!.after).toBeLessThan(20);
    for (const cell of free) {
      const result = race(book, cell.start);
      expect(result.winner.entrant.followed).toBe(true);
      expect(+result.winner.booking.start).toBe(+cell.start);
      expect(result.refused).toHaveLength(24);
      expect(new Set(result.refused.map((r) => r.code))).toEqual(
        new Set(["SLOT_UNAVAILABLE"]),
      );
      // Everyone refused is placed elsewhere (a later day when this one is
      // full), and nothing overlaps.
      const starts = result.refused.map(
        (r) => `${r.alternative.practitioner}@${+r.alternative.start}`,
      );
      expect(new Set(starts).size).toBe(24);
      expect(result.book.overlaps()).toEqual([]);
    }
    // The race works on a copy: the book the page shows is untouched.
    expect(book.overlaps()).toEqual([]);
    expect(book.bookings.filter((b) => b.status === "HELD")).toHaveLength(1);
  });

  it("confirms the held time through the state machine", () => {
    const book = Book.sample(days);
    placeRequests(book);
    const cell = nextDayCells(book).find((c) => c.free)!;
    const result = race(book, cell.start);
    expect(confirm(result).status).toBe("CONFIRMED");
    expect(() => confirm(result)).toThrow(/confirmed cannot become confirmed/);
  });

  it("lets the page's visit buttons do only what the state machine allows", () => {
    const book = Book.sample(days);
    const booked = book.on("today").find((b) => b.patient === "Fatima Adams")!;
    expect(book.act(booked.id, "check_in").status).toBe("CHECKED_IN");
    const done = book.on("today").find((b) => b.status === "COMPLETED")!;
    expect(() => book.act(done.id, "check_in")).toThrow();
    // Tomorrow's patients cannot arrive today.
    const tomorrow = book.on("next")[0]!;
    expect(() => book.act(tomorrow.id, "check_in")).toThrow();
  });
});
