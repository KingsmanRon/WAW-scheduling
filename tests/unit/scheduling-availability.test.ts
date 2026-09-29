import { describe, expect, it } from "vitest";
import {
  checkSlot,
  findAvailableSlots,
  localDateOf,
  normalize,
  subtract,
  wallClockToInstant,
  type AppointmentTiming,
  type AvailabilityRequest,
  type ScheduleContext,
  type WeeklyRule,
} from "../../packages/scheduling/src/index.js";

const P1 = "00000000-0000-4000-8000-0000000000a1";
const P2 = "00000000-0000-4000-8000-0000000000b2";
const L1 = "00000000-0000-4000-8000-0000000000c1";
const L2 = "00000000-0000-4000-8000-0000000000c2";
const JHB = "Africa/Johannesburg";

const timing = (over: Partial<AppointmentTiming> = {}): AppointmentTiming => ({
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  slotIntervalMinutes: 15,
  minNoticeMinutes: 0,
  maxAdvanceDays: 365,
  ...over,
});
const rule = (over: Partial<WeeklyRule> = {}): WeeklyRule => ({
  practitionerId: P1,
  locationId: L1,
  weekday: 1,
  startMinute: 9 * 60,
  endMinute: 12 * 60,
  validFrom: "2026-01-01",
  validUntil: null,
  ...over,
});
const ctx = (over: Partial<ScheduleContext> = {}): ScheduleContext => ({
  locations: new Map([
    [L1, { timezone: JHB }],
    [L2, { timezone: JHB }],
  ]),
  pairs: [{ practitionerId: P1, locationId: L1 }],
  rules: [rule()],
  exceptions: [],
  blocks: [],
  occupancy: [],
  ...over,
});
// Monday 5 October 2026, Johannesburg (UTC+2, no DST).
const MONDAY = "2026-10-05";
const at = (date: string, hhmm: string, tz = JHB) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return wallClockToInstant(date, h * 60 + m, tz)!;
};
const request = (
  over: Partial<AvailabilityRequest> = {},
): AvailabilityRequest => ({
  from: at(MONDAY, "00:00"),
  to: at("2026-10-06", "00:00"),
  now: new Date("2026-10-01T06:00:00Z"),
  actor: "STAFF",
  timing: timing(),
  ...over,
});
const localTimes = (slots: { start: Date }[], tz = JHB) =>
  slots.map((s) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(s.start),
  );

describe("interval arithmetic", () => {
  it("normalizes, merges touching intervals and subtracts", () => {
    expect(
      normalize([
        { start: 5, end: 7 },
        { start: 1, end: 3 },
        { start: 3, end: 4 },
        { start: 9, end: 9 },
      ]),
    ).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 7 },
    ]);
    expect(
      subtract(
        [{ start: 0, end: 10 }],
        [
          { start: 2, end: 3 },
          { start: 5, end: 12 },
          { start: -4, end: 1 },
        ],
      ),
    ).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 5 },
    ]);
  });
});

describe("availability engine", () => {
  it("generates candidate starts from working hours on a local grid", () => {
    const slots = findAvailableSlots(request(), ctx());
    expect(localTimes(slots)).toEqual([
      "09:00",
      "09:15",
      "09:30",
      "09:45",
      "10:00",
      "10:15",
      "10:30",
      "10:45",
      "11:00",
      "11:15",
      "11:30",
    ]);
    expect(slots[0]).toMatchObject({
      practitionerId: P1,
      locationId: L1,
      timezone: JHB,
    });
    // Johannesburg is UTC+2: local 09:00 is 07:00Z.
    expect(slots[0]!.start.toISOString()).toBe("2026-10-05T07:00:00.000Z");
    expect(slots[0]!.end.toISOString()).toBe("2026-10-05T07:30:00.000Z");
  });

  it("uses the appointment type's duration and interval (no 30-minute assumption)", () => {
    const slots = findAvailableSlots(
      request({
        timing: timing({ durationMinutes: 45, slotIntervalMinutes: 20 }),
      }),
      ctx(),
    );
    expect(localTimes(slots)).toEqual([
      "09:00",
      "09:20",
      "09:40",
      "10:00",
      "10:20",
      "10:40",
      "11:00",
    ]);
    expect(+slots[0]!.end - +slots[0]!.start).toBe(45 * 60_000);
  });

  it("keeps buffers inside working hours and clear of other appointments", () => {
    const slots = findAvailableSlots(
      request({
        timing: timing({ bufferBeforeMinutes: 10, bufferAfterMinutes: 5 }),
      }),
      ctx(),
    );
    // occupied [s-10, s+35) must fit 09:00-12:00: first 09:10 -> grid 09:15,
    // last start 11:25 -> grid 11:15.
    expect(localTimes(slots)[0]).toBe("09:15");
    expect(localTimes(slots).at(-1)).toBe("11:15");
  });

  it("applies rules only on their weekday and validity dates", () => {
    const tuesday = findAvailableSlots(
      request({
        from: at("2026-10-06", "00:00"),
        to: at("2026-10-07", "00:00"),
      }),
      ctx(),
    );
    expect(tuesday).toEqual([]);
    const expired = findAvailableSlots(
      request(),
      ctx({ rules: [rule({ validUntil: "2026-10-04" })] }),
    );
    expect(expired).toEqual([]);
    const notYet = findAvailableSlots(
      request(),
      ctx({ rules: [rule({ validFrom: "2026-10-06" })] }),
    );
    expect(notYet).toEqual([]);
    const lastDay = findAvailableSlots(
      request(),
      ctx({ rules: [rule({ validUntil: MONDAY })] }),
    );
    expect(lastDay).toHaveLength(11);
  });

  it("removes leave and adds one-off sessions", () => {
    const leave = findAvailableSlots(
      request(),
      ctx({
        exceptions: [
          {
            practitionerId: P1,
            locationId: null,
            kind: "UNAVAILABLE",
            start: at(MONDAY, "00:00"),
            end: at(MONDAY, "10:00"),
          },
        ],
      }),
    );
    expect(localTimes(leave)[0]).toBe("10:00");
    const saturday = "2026-10-10";
    const extra = findAvailableSlots(
      request({ from: at(saturday, "00:00"), to: at(saturday, "23:59") }),
      ctx({
        exceptions: [
          {
            practitionerId: P1,
            locationId: L1,
            kind: "AVAILABLE",
            start: at(saturday, "08:00"),
            end: at(saturday, "09:00"),
          },
        ],
      }),
    );
    expect(localTimes(extra)).toEqual(["08:00", "08:15", "08:30"]);
  });

  it("scopes location-specific unavailability to that location", () => {
    const twoLocations = ctx({
      pairs: [
        { practitionerId: P1, locationId: L1 },
        { practitionerId: P1, locationId: L2 },
      ],
      rules: [
        rule(),
        rule({ locationId: L2, startMinute: 13 * 60, endMinute: 14 * 60 }),
      ],
      exceptions: [
        {
          practitionerId: P1,
          locationId: L2,
          kind: "UNAVAILABLE",
          start: at(MONDAY, "00:00"),
          end: at(MONDAY, "23:59"),
        },
      ],
    });
    const slots = findAvailableSlots(request(), twoLocations);
    expect(new Set(slots.map((s) => s.locationId))).toEqual(new Set([L1]));
  });

  it("removes schedule blocks", () => {
    const slots = findAvailableSlots(
      request(),
      ctx({
        blocks: [
          {
            practitionerId: P1,
            locationId: null,
            start: at(MONDAY, "10:00"),
            end: at(MONDAY, "10:30"),
          },
        ],
      }),
    );
    const times = localTimes(slots);
    expect(times).not.toContain("09:45");
    expect(times).not.toContain("10:00");
    expect(times).not.toContain("10:15");
    expect(times).toContain("09:30");
    expect(times).toContain("10:30");
  });

  it("excludes time occupied by appointments and live holds, but not adjacent time", () => {
    const occupied = ctx({
      occupancy: [
        {
          practitionerId: P1,
          appointmentId: "a",
          start: at(MONDAY, "09:30"),
          end: at(MONDAY, "10:00"),
        },
      ],
    });
    const times = localTimes(findAvailableSlots(request(), occupied));
    expect(times).toContain("09:00");
    expect(times).not.toContain("09:15");
    expect(times).not.toContain("09:30");
    expect(times).not.toContain("09:45");
    expect(times).toContain("10:00");
    // Ignoring the appointment being rescheduled frees its own time.
    const own = localTimes(
      findAvailableSlots(request({ excludeAppointmentIds: ["a"] }), occupied),
    );
    expect(own).toContain("09:30");
    // Other practitioners are unaffected by P1's appointment.
    const other = findAvailableSlots(
      request(),
      ctx({
        pairs: [
          { practitionerId: P1, locationId: L1 },
          { practitionerId: P2, locationId: L1 },
        ],
        rules: [rule(), rule({ practitionerId: P2 })],
        occupancy: occupied.occupancy,
      }),
    );
    expect(
      other.filter((s) => s.practitionerId === P2).map((s) => s.start),
    ).toContainEqual(at(MONDAY, "09:30"));
  });

  it("applies the patient booking window; staff may book walk-ins now", () => {
    const now = at(MONDAY, "09:40");
    const patient = localTimes(
      findAvailableSlots(
        request({
          now,
          actor: "PATIENT",
          timing: timing({ minNoticeMinutes: 60 }),
        }),
        ctx(),
      ),
    );
    expect(patient[0]).toBe("10:45");
    const staff = localTimes(findAvailableSlots(request({ now }), ctx()));
    // Staff grace: a slot that started up to 15 minutes ago is still offered.
    expect(staff[0]).toBe("09:30");
    const far = findAvailableSlots(
      request({
        now: new Date("2026-06-01T00:00:00Z"),
        actor: "PATIENT",
        timing: timing({ maxAdvanceDays: 30 }),
      }),
      ctx(),
    );
    expect(far).toEqual([]);
  });

  it("orders slots by time then practitioner and honours the limit", () => {
    const both = ctx({
      pairs: [
        { practitionerId: P2, locationId: L1 },
        { practitionerId: P1, locationId: L1 },
      ],
      rules: [rule(), rule({ practitionerId: P2 })],
    });
    const slots = findAvailableSlots(request({ limit: 4 }), both);
    expect(slots.map((s) => [localTimes([s])[0], s.practitionerId])).toEqual([
      ["09:00", P1],
      ["09:00", P2],
      ["09:15", P1],
      ["09:15", P2],
    ]);
  });

  it("stays correct across a DST spring-forward gap", () => {
    const tz = "Europe/London";
    const sunday = "2026-03-29"; // 01:00 -> 02:00 local
    const london = ctx({
      locations: new Map([[L1, { timezone: tz }]]),
      rules: [rule({ weekday: 7, startMinute: 0, endMinute: 4 * 60 })],
    });
    const slots = findAvailableSlots(
      request({
        from: new Date("2026-03-28T20:00:00Z"),
        to: new Date("2026-03-29T12:00:00Z"),
        now: new Date("2026-03-01T00:00:00Z"),
        timing: timing({ slotIntervalMinutes: 30 }),
      }),
      london,
    );
    expect(localTimes(slots, tz)).toEqual([
      "00:00",
      "00:30",
      "02:00",
      "02:30",
      "03:00",
      "03:30",
    ]);
    expect(slots.every((s) => localDateOf(s.start, tz) === sunday)).toBe(true);
    // Every slot is a real 30-minute interval of elapsed time.
    expect(slots.every((s) => +s.end - +s.start === 30 * 60_000)).toBe(true);
  });

  it("stays correct across a DST fall-back overlap", () => {
    const tz = "Europe/London";
    const london = ctx({
      locations: new Map([[L1, { timezone: tz }]]),
      rules: [rule({ weekday: 7, startMinute: 0, endMinute: 3 * 60 })],
    });
    const slots = findAvailableSlots(
      request({
        from: new Date("2026-10-24T20:00:00Z"),
        to: new Date("2026-10-25T12:00:00Z"),
        now: new Date("2026-10-01T00:00:00Z"),
        timing: timing({ slotIntervalMinutes: 60, durationMinutes: 60 }),
      }),
      london,
    );
    // The window is four real hours (00:00 BST to 03:00 GMT). Local 01:00
    // happens twice; it is offered once, at its first occurrence.
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-10-24T23:00:00.000Z",
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T02:00:00.000Z",
    ]);
  });

  it("is fast enough for practical clinic searches", () => {
    const practitioners = Array.from(
      { length: 12 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const big = ctx({
      pairs: practitioners.map((p) => ({ practitionerId: p, locationId: L1 })),
      rules: practitioners.flatMap((p) =>
        [1, 2, 3, 4, 5].map((weekday) =>
          rule({
            practitionerId: p,
            weekday,
            startMinute: 7 * 60,
            endMinute: 18 * 60,
          }),
        ),
      ),
      occupancy: practitioners.flatMap((p, i) =>
        Array.from({ length: 200 }, (_, k) => ({
          practitionerId: p,
          appointmentId: `${i}-${k}`,
          start: new Date(Date.UTC(2026, 9, 5 + (k % 25), 6 + (k % 9), 0)),
          end: new Date(Date.UTC(2026, 9, 5 + (k % 25), 6 + (k % 9), 20)),
        })),
      ),
    });
    const started = performance.now();
    const slots = findAvailableSlots(
      request({
        to: at("2026-11-05", "00:00"),
        timing: timing({ slotIntervalMinutes: 5, durationMinutes: 20 }),
      }),
      big,
    );
    const elapsed = performance.now() - started;
    expect(slots.length).toBeGreaterThan(10_000);
    expect(elapsed).toBeLessThan(1_500);
  });
});

describe("checking one requested start", () => {
  const staff = {
    actor: "STAFF" as const,
    now: new Date("2026-10-01T06:00:00Z"),
    timing: timing(),
  };
  const slot = (hhmm: string, practitionerId = P1, locationId = L1) => ({
    practitionerId,
    locationId,
    start: at(MONDAY, hhmm),
  });

  it("accepts starts inside availability and refuses conflicts", () => {
    expect(checkSlot(staff, ctx(), slot("09:00"))).toMatchObject({ ok: true });
    const busy = ctx({
      occupancy: [
        {
          practitionerId: P1,
          appointmentId: "x",
          start: at(MONDAY, "09:10"),
          end: at(MONDAY, "09:20"),
        },
      ],
    });
    expect(checkSlot(staff, busy, slot("09:00"))).toEqual({
      ok: false,
      code: "SLOT_UNAVAILABLE",
    });
  });

  it("lets staff start off-grid but keeps patients on the offered grid", () => {
    expect(checkSlot(staff, ctx(), slot("09:05"))).toMatchObject({ ok: true });
    expect(
      checkSlot({ ...staff, actor: "PATIENT" }, ctx(), slot("09:05")),
    ).toEqual({ ok: false, code: "NOT_ON_SLOT_GRID" });
  });

  it("refuses outside availability unless an authorised override is given", () => {
    expect(checkSlot(staff, ctx(), slot("11:45"))).toEqual({
      ok: false,
      code: "OUTSIDE_AVAILABILITY",
    });
    expect(
      checkSlot({ ...staff, override: true }, ctx(), slot("12:30")),
    ).toMatchObject({ ok: true });
    // An override never permits a double booking.
    const busy = ctx({
      occupancy: [
        {
          practitionerId: P1,
          appointmentId: "x",
          start: at(MONDAY, "12:30"),
          end: at(MONDAY, "13:00"),
        },
      ],
    });
    expect(
      checkSlot({ ...staff, override: true }, busy, slot("12:45")),
    ).toEqual({ ok: false, code: "SLOT_UNAVAILABLE" });
  });

  it("refuses an ineligible practitioner/location and the booking window", () => {
    expect(checkSlot(staff, ctx(), slot("09:00", P1, L2))).toEqual({
      ok: false,
      code: "PRACTITIONER_NOT_AT_LOCATION",
    });
    expect(
      checkSlot({ ...staff, now: at(MONDAY, "10:00") }, ctx(), slot("09:00")),
    ).toEqual({ ok: false, code: "OUTSIDE_BOOKING_WINDOW" });
  });

  it("agrees with the slot search for every offered start", () => {
    const busy = ctx({
      occupancy: [
        {
          practitionerId: P1,
          appointmentId: "x",
          start: at(MONDAY, "10:10"),
          end: at(MONDAY, "10:40"),
        },
      ],
    });
    const offered = findAvailableSlots(
      request({ actor: "PATIENT", timing: timing() }),
      busy,
    );
    for (const s of offered)
      expect(
        checkSlot({ ...staff, actor: "PATIENT" }, busy, {
          practitionerId: s.practitionerId,
          locationId: s.locationId,
          start: s.start,
        }).ok,
      ).toBe(true);
  });
});
