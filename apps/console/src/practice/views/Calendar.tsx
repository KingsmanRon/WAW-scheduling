import React, { useState } from "react";
import { Icon } from "../../components/Icon";
import { label } from "../../format";
import { PageHeader } from "../../layout/PageHeader";
import { errorCode, errorDetails } from "../api";
import { usePractice } from "../context";
import { useLink, type ViewProps } from "../PracticeApp";
import {
  atMinute,
  dayRange,
  dt,
  fmt,
  minuteOfDay,
  parseClock,
  shiftDate,
  todayIn,
  weekDays,
  weekRange,
} from "../time";
import type { Appointment, CalendarData, Period } from "../types";
import {
  ConfirmButton,
  Dialog,
  ErrorNote,
  Loading,
  statusText,
  useAction,
  useLoad,
} from "../ui";

/** Vertical scale of the time grid. */
const PX_PER_MIN = 1.6;
const BLOCK_REASONS = [
  "ADMIN",
  "MEETING",
  "BREAK",
  "PERSONAL",
  "EMERGENCY",
  "OTHER",
] as const;

interface Column {
  key: string;
  title: string;
  subtitle?: string;
  date: string;
  practitionerId: string;
  windows: CalendarData["working_windows"];
  periods: (Period & { what: "block" | "exception" })[];
  appointments: Appointment[];
}

/**
 * The practice calendar. Day view: one column per practitioner (all, or one
 * location's). Week view: one practitioner's seven days. Working time is
 * light, blocks and leave are hatched, appointments show patient, type and
 * status. Clicking working time starts a booking there; the Scheduling Core
 * decides whether it can be booked.
 */
export function Calendar({ route, go }: ViewProps) {
  const practice = usePractice();
  const link = useLink();
  const tz = practice.tz;
  const mode = route.query.get("mode") === "week" ? "week" : "day";
  const date = route.query.get("date") ?? todayIn(tz);
  const locationId = route.query.get("location") ?? "";
  const chosen = route.query.get("practitioner") ?? "";
  const active = practice.data.practitioners.filter(
    (p) => p.active && (!locationId || p.location_ids.includes(locationId)),
  );
  const practitionerId =
    mode === "week"
      ? chosen ||
        practice.data.membership.practitioner_id ||
        active[0]?.id ||
        ""
      : chosen;
  const [blocking, setBlocking] = useState(false);
  const [openBlock, setOpenBlock] = useState<Period | null>(null);
  const set = (q: Record<string, string>) =>
    go(
      link("calendar", null, {
        mode,
        date,
        location: locationId,
        practitioner: chosen,
        ...q,
      }),
    );
  const range = mode === "day" ? dayRange(date, tz) : weekRange(date, tz);
  const cal = useLoad(
    () =>
      practice.client.get<CalendarData>("/calendar", {
        ...range,
        location_id: locationId || undefined,
        practitioner_ids: practitionerId || undefined,
      }),
    [range.from, range.to, locationId, practitionerId, practice.tick],
  );

  const days = mode === "week" ? weekDays(date, tz) : [date];
  const columns: Column[] = [];
  if (cal.data) {
    const d = cal.data;
    const inDay = (iso: string, day: string) => dt(iso, tz).toISODate() === day;
    const periods = [
      ...d.blocks.map((b) => ({ ...b, what: "block" as const })),
      ...d.exceptions.map((e) => ({ ...e, what: "exception" as const })),
    ];
    if (mode === "day")
      for (const p of d.practitioners)
        columns.push({
          key: p.id,
          title: p.display_name,
          date,
          practitionerId: p.id,
          windows: d.working_windows.filter((w) => w.practitioner_id === p.id),
          periods: periods.filter((x) => x.practitioner_id === p.id),
          appointments: d.appointments.filter(
            (a) => a.practitioner.id === p.id,
          ),
        });
    else
      for (const day of days)
        columns.push({
          key: day,
          title: fmt.shortDate(day),
          date: day,
          practitionerId,
          windows: d.working_windows.filter((w) => inDay(w.start, day)),
          periods: periods.filter((x) => inDay(x.starts_at, day)),
          appointments: d.appointments.filter((a) => inDay(a.starts_at, day)),
        });
  }
  // The visible hours: working time and anything booked, at least 08-17.
  let first = 8 * 60;
  let last = 17 * 60;
  for (const c of columns) {
    for (const w of c.windows) {
      first = Math.min(first, minuteOfDay(w.start, tz));
      last = Math.max(last, minuteOfDay(w.end, tz) || 1440);
    }
    for (const a of c.appointments) {
      first = Math.min(first, minuteOfDay(a.starts_at, tz));
      last = Math.max(last, minuteOfDay(a.ends_at, tz) || 1440);
    }
  }
  first = Math.floor(first / 60) * 60;
  last = Math.min(1440, Math.ceil(last / 60) * 60);
  const hours = Array.from(
    { length: (last - first) / 60 },
    (_, i) => first + i * 60,
  );
  const top = (iso: string) => (minuteOfDay(iso, tz) - first) * PX_PER_MIN;
  const height = (from: string, to: string) =>
    Math.max(16, ((Date.parse(to) - Date.parse(from)) / 60_000) * PX_PER_MIN);

  const bookAt = (c: Column, e: React.MouseEvent<HTMLDivElement>) => {
    if (!practice.can("appointment.book")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minute =
      first + Math.floor((e.clientY - rect.top) / PX_PER_MIN / 15) * 15;
    const start = atMinute(c.date, minute, tz);
    const open = c.windows.find(
      (w) =>
        Date.parse(w.start) <= Date.parse(start) &&
        Date.parse(start) < Date.parse(w.end),
    );
    if (!open) return;
    go(
      link("book", null, {
        practitioner: c.practitionerId,
        location: open.location_id,
        start,
      }),
    );
  };

  const step = mode === "day" ? 1 : 7;
  const locations = practice.data.locations.filter((l) => l.active);
  return (
    <>
      <PageHeader
        title="Calendar"
        context={
          mode === "day"
            ? fmt.longDay(date)
            : `Week of ${fmt.longDay(days[0]!)} · ${practice.practitioner(practitionerId)?.display_name ?? ""}`
        }
        actions={
          practice.can("schedule.blocks.manage") && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setBlocking(true)}
            >
              <Icon name="lock" size={18} />
              Block time
            </button>
          )
        }
      >
        <div className="toolbar" role="toolbar" aria-label="Calendar controls">
          <div className="segmented" role="group" aria-label="View">
            <button
              type="button"
              aria-pressed={mode === "day"}
              onClick={() => set({ mode: "day" })}
            >
              Day
            </button>
            <button
              type="button"
              aria-pressed={mode === "week"}
              onClick={() => set({ mode: "week" })}
            >
              Week
            </button>
          </div>
          <div className="toolbar__group">
            <button
              type="button"
              className="btn btn-secondary"
              aria-label={mode === "day" ? "Previous day" : "Previous week"}
              onClick={() => set({ date: shiftDate(date, -step) })}
            >
              <Icon name="back" size={18} />
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => set({ date: todayIn(tz) })}
            >
              Today
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              aria-label={mode === "day" ? "Next day" : "Next week"}
              onClick={() => set({ date: shiftDate(date, step) })}
            >
              <Icon name="forward" size={18} />
            </button>
            <label className="vh" htmlFor="cal-date">
              Date
            </label>
            <input
              id="cal-date"
              type="date"
              value={date}
              onChange={(e) => e.target.value && set({ date: e.target.value })}
            />
          </div>
          {locations.length > 1 && (
            <select
              aria-label="Location"
              value={locationId}
              onChange={(e) => set({ location: e.target.value })}
            >
              <option value="">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Practitioner"
            value={mode === "week" ? practitionerId : chosen}
            onChange={(e) => set({ practitioner: e.target.value })}
          >
            {mode === "day" && <option value="">All practitioners</option>}
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name}
              </option>
            ))}
          </select>
        </div>
      </PageHeader>
      <ErrorNote error={cal.error} />
      {!cal.data && !cal.error && <Loading what="the calendar" />}
      {cal.data && !columns.length && (
        <p className="muted">No active practitioners at this location.</p>
      )}
      {cal.data && columns.length > 0 && (
        <div
          className={`calendar${cal.loading ? " is-refreshing" : ""}`}
          style={{ "--cols": columns.length } as React.CSSProperties}
        >
          <div className="calendar__head" aria-hidden>
            <span />
            {columns.map((c) => (
              <span key={c.key} className="calendar__col-title">
                {c.title}
              </span>
            ))}
          </div>
          <div
            className="calendar__body"
            style={{ height: (last - first) * PX_PER_MIN }}
          >
            <div className="calendar__hours" aria-hidden>
              {hours.map((m) => (
                <span key={m} style={{ top: (m - first) * PX_PER_MIN }}>
                  {fmt.minute(m)}
                </span>
              ))}
            </div>
            {columns.map((c) => (
              <div
                key={c.key}
                className="calendar__col"
                role="group"
                aria-label={c.title}
                onClick={(e) => bookAt(c, e)}
              >
                {hours.map((m) => (
                  <span
                    key={m}
                    className="calendar__line"
                    style={{ top: (m - first) * PX_PER_MIN }}
                    aria-hidden
                  />
                ))}
                {c.windows.map((w, i) => (
                  <span
                    key={i}
                    className="calendar__open"
                    style={{
                      top: top(w.start),
                      height: height(w.start, w.end),
                    }}
                    aria-hidden
                  />
                ))}
                {c.periods.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`calendar__period calendar__period--${p.what}${p.kind === "AVAILABLE" ? " is-extra" : ""}`}
                    style={{
                      top: top(p.starts_at),
                      height: height(p.starts_at, p.ends_at),
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (p.what === "block") setOpenBlock(p);
                    }}
                    aria-label={`${p.what === "block" ? "Blocked" : label(p.reason_code)} ${fmt.range(p.starts_at, p.ends_at, tz)}`}
                  >
                    <span>
                      {p.what === "block"
                        ? `Blocked · ${label(p.reason_code)}`
                        : label(p.reason_code)}
                    </span>
                  </button>
                ))}
                {lanes(c.appointments).map(({ a, lane, of }) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`calendar__appt calendar__appt--${a.status.toLowerCase()}${height(a.starts_at, a.ends_at) < 36 ? " calendar__appt--short" : ""}`}
                    style={{
                      top: top(a.starts_at),
                      height: height(a.starts_at, a.ends_at),
                      left: `calc(${(lane / of) * 100}% + 2px)`,
                      width: `calc(${100 / of}% - 4px)`,
                      borderLeftColor:
                        a.appointment_type.calendar_color ?? undefined,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      go(link("appointment", a.id));
                    }}
                    aria-label={`${fmt.range(a.starts_at, a.ends_at, tz)}, ${a.patient.display_name}, ${a.appointment_type.name}, ${statusText(a.status)}`}
                  >
                    <span className="calendar__appt-line">
                      <span className="calendar__appt-time">
                        {fmt.time(a.starts_at, tz)}
                      </span>{" "}
                      <span className="calendar__appt-who">
                        {a.patient.display_name}
                      </span>
                    </span>
                    <span className="calendar__appt-what">
                      {a.appointment_type.name} · {statusText(a.status)}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          {cal.data.truncated && (
            <p className="note small">
              Showing the first 2,000 appointments. Narrow the view to see all.
            </p>
          )}
        </div>
      )}
      {practice.can("appointment.book") && cal.data && (
        <p className="muted small calendar__hint">
          Click working time (the lighter area) to book there.
        </p>
      )}
      {blocking && (
        <BlockDialog
          date={date}
          practitionerId={practitionerId || active[0]?.id || ""}
          onClose={() => setBlocking(false)}
        />
      )}
      {openBlock && (
        <BlockDetail block={openBlock} onClose={() => setOpenBlock(null)} />
      )}
    </>
  );
}

/** Side-by-side lanes for appointments that overlap in one column. */
function lanes(appointments: Appointment[]) {
  const sorted = [...appointments].sort(
    (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
  );
  const out: { a: Appointment; lane: number; of: number }[] = [];
  let group: { a: Appointment; lane: number }[] = [];
  let groupEnd = 0;
  let laneEnds: number[] = [];
  const flush = () => {
    const of = Math.max(1, laneEnds.length);
    for (const g of group) out.push({ ...g, of });
    group = [];
    laneEnds = [];
  };
  for (const a of sorted) {
    const s = Date.parse(a.starts_at);
    const e = Date.parse(a.ends_at);
    if (group.length && s >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= s);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(e);
    } else laneEnds[lane] = e;
    group.push({ a, lane });
    groupEnd = Math.max(groupEnd, e);
  }
  flush();
  return out;
}

function BlockDialog({
  date,
  practitionerId,
  onClose,
}: {
  date: string;
  practitionerId: string;
  onClose: () => void;
}) {
  const practice = usePractice();
  const tz = practice.tz;
  const own =
    practice.data.membership.role === "DOCTOR"
      ? practice.data.membership.practitioner_id
      : null;
  const [who, setWho] = useState(own ?? practitionerId);
  const [day, setDay] = useState(date);
  const [from, setFrom] = useState("12:00");
  const [to, setTo] = useState("13:00");
  const [reason, setReason] = useState<(typeof BLOCK_REASONS)[number]>("ADMIN");
  const [note, setNote] = useState("");
  const [conflicts, setConflicts] = useState<
    { appointment_id: string; starts_at: string }[] | null
  >(null);
  const action = useAction();
  const submit = (acknowledge: boolean) => {
    const start = parseClock(from);
    const end = parseClock(to);
    if (start === null || end === null || end <= start) {
      action.setError(
        "Enter a start and end time (HH:MM), the end after the start.",
      );
      return;
    }
    void action
      .run(async () => {
        try {
          await practice.client.send("POST", "/schedule-blocks", {
            practitioner_id: who,
            start: atMinute(day, start, tz),
            end: atMinute(day, end, tz),
            reason_code: reason,
            note: note.trim() || null,
            acknowledge_conflicts: acknowledge,
          });
        } catch (e) {
          if (errorCode(e) === "SCHEDULE_BLOCK_CONFLICT") {
            const details = errorDetails(e) as {
              conflicts?: { appointment_id: string; starts_at: string }[];
            } | null;
            setConflicts(details?.conflicts ?? []);
          }
          throw e;
        }
        practice.changed();
      })
      .then((ok) => ok && onClose());
  };
  const practitioners = practice.data.practitioners.filter(
    (p) => p.active && (!own || p.id === own),
  );
  return (
    <Dialog title="Block time" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        <div className="field">
          <label htmlFor="block-who">Practitioner</label>
          <select
            id="block-who"
            value={who}
            onChange={(e) => setWho(e.target.value)}
          >
            {practitioners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="block-day">Date</label>
            <input
              id="block-day"
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="block-from">From</label>
            <input
              id="block-from"
              type="time"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="block-to">Until</label>
            <input
              id="block-to"
              type="time"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="block-reason">Reason</label>
          <select
            id="block-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as typeof reason)}
          >
            {BLOCK_REASONS.map((r) => (
              <option key={r} value={r}>
                {label(r)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="block-note">
            Note <span className="optional">(optional)</span>
          </label>
          <input
            id="block-note"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {conflicts && (
          <div className="note">
            <p>
              {conflicts.length} booked appointment
              {conflicts.length === 1 ? " falls" : "s fall"} in this time.
              Blocking keeps them booked; move or cancel them separately if
              needed.
            </p>
            <ul className="small">
              {conflicts.map((c) => (
                <li key={c.appointment_id}>{fmt.when(c.starts_at, tz)}</li>
              ))}
            </ul>
          </div>
        )}
        <ErrorNote error={conflicts ? "" : action.error} />
        <div className="form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          {conflicts ? (
            <button
              type="button"
              className="btn"
              disabled={action.busy}
              onClick={() => submit(true)}
            >
              Block anyway
            </button>
          ) : (
            <button className="btn" disabled={action.busy}>
              Block time
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

function BlockDetail({
  block,
  onClose,
}: {
  block: Period;
  onClose: () => void;
}) {
  const practice = usePractice();
  const action = useAction();
  return (
    <Dialog title="Blocked time" onClose={onClose}>
      <dl className="facts">
        <dt>Practitioner</dt>
        <dd>{practice.practitioner(block.practitioner_id)?.display_name}</dd>
        <dt>When</dt>
        <dd>
          {fmt.day(block.starts_at, practice.tz)},{" "}
          {fmt.range(block.starts_at, block.ends_at, practice.tz)}
        </dd>
        <dt>Reason</dt>
        <dd>{label(block.reason_code)}</dd>
        {block.note && (
          <>
            <dt>Note</dt>
            <dd>{block.note}</dd>
          </>
        )}
      </dl>
      <ErrorNote error={action.error} />
      <div className="form__actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
        {practice.can("schedule.blocks.manage") && (
          <ConfirmButton
            label="Remove block"
            question="Make this time bookable again?"
            className="btn btn-secondary"
            disabled={action.busy}
            onConfirm={() =>
              void action
                .run(async () => {
                  await practice.client.send(
                    "POST",
                    `/schedule-blocks/${block.id}/remove`,
                    {},
                  );
                  practice.changed();
                })
                .then((ok) => ok && onClose())
            }
          />
        )}
      </div>
    </Dialog>
  );
}
