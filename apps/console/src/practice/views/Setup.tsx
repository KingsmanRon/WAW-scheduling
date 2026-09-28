import React, { useState } from "react";
import { Icon } from "../../components/Icon";
import { label } from "../../format";
import { PageHeader } from "../../layout/PageHeader";
import { errorCode, errorDetails } from "../api";
import { usePractice } from "../context";
import type { ViewProps } from "../PracticeApp";
import {
  atMinute,
  fmt,
  parseClock,
  shiftDate,
  startOfDay,
  todayIn,
  WEEKDAYS,
} from "../time";
import type {
  AppointmentType,
  AvailabilityRule,
  Location,
  Period,
  Practitioner,
} from "../types";
import {
  Dialog,
  Empty,
  ErrorNote,
  Loading,
  Tone,
  useAction,
  useLoad,
} from "../ui";

const TABS = [
  ["hours", "Working hours"],
  ["leave", "Leave and extra sessions"],
  ["types", "Appointment types"],
  ["practitioners", "Practitioners"],
  ["locations", "Locations"],
  ["practice", "Practice"],
] as const;
type Tab = (typeof TABS)[number][0];
const EXCEPTION_REASONS = [
  "LEAVE",
  "SICK_LEAVE",
  "TRAINING",
  "PUBLIC_HOLIDAY",
  "PRACTICE_CLOSED",
  "EXTRA_SESSION",
  "OTHER",
] as const;

/** Schedules and configuration. Changes are audited; booked appointments are never moved silently. */
export function Setup({ route, go }: ViewProps) {
  const initial = (route.query.get("tab") as Tab | null) ?? "hours";
  const tab: Tab = TABS.some(([t]) => t === initial) ? initial : "hours";
  const practice = usePractice();
  return (
    <>
      <PageHeader
        title="Schedule setup"
        context={practice.data.practice.name}
      />
      <div
        className="segmented segmented--wrap"
        role="tablist"
        aria-label="Setup"
      >
        {TABS.map(([value, text]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => go(`#/p/${practice.id}/setup?tab=${value}`)}
          >
            {text}
          </button>
        ))}
      </div>
      <div className="section-gap">
        {tab === "hours" && <Hours />}
        {tab === "leave" && <Leave />}
        {tab === "types" && <Types />}
        {tab === "practitioners" && <Practitioners />}
        {tab === "locations" && <Locations />}
        {tab === "practice" && <PracticeSettingsForm />}
      </div>
    </>
  );
}

function PractitionerSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const practice = usePractice();
  return (
    <select
      aria-label="Practitioner"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {practice.data.practitioners.map((p) => (
        <option key={p.id} value={p.id}>
          {p.display_name}
          {p.active ? "" : " (inactive)"}
        </option>
      ))}
    </select>
  );
}

function Hours() {
  const practice = usePractice();
  const own =
    practice.data.membership.role === "DOCTOR"
      ? practice.data.membership.practitioner_id
      : null;
  const [practitionerId, setPractitionerId] = useState(
    own ?? practice.data.practitioners[0]?.id ?? "",
  );
  const rules = useLoad(
    () =>
      practice.client.get<{ items: AvailabilityRule[] }>(
        "/availability-rules",
        { practitioner_id: practitionerId },
      ),
    [practitionerId, practice.tick],
  );
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const manage = practice.can("schedule.hours.manage");
  const practitioner = practice.practitioner(practitionerId);
  if (!practitioner) return <Empty title="Add a practitioner first" />;
  return (
    <section className="panel">
      <div className="panel__head">
        <PractitionerSelect
          value={practitionerId}
          onChange={setPractitionerId}
        />
        {manage && (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" size={18} />
            Add working hours
          </button>
        )}
      </div>
      <div className="panel__body">
        <p className="field-hint">
          Recurring weekly hours. Leave, holidays and one-off sessions are
          exceptions; blocks are set in the calendar. Times are {practice.tz}{" "}
          time.
        </p>
        <ErrorNote error={rules.error || action.error} />
        {!rules.data ? (
          <Loading what="working hours" />
        ) : !rules.data.items.length ? (
          <Empty title="No working hours">
            Without working hours nothing can be booked with{" "}
            {practitioner.display_name}.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Hours</th>
                <th scope="col">Location</th>
                <th scope="col">From</th>
                <th scope="col">Until</th>
                <th scope="col">
                  <span className="vh">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{WEEKDAYS[r.weekday - 1]}</td>
                  <td className="num">
                    {fmt.minute(r.start_minute)}–{fmt.minute(r.end_minute)}
                  </td>
                  <td>{practice.location(r.location_id)?.name}</td>
                  <td>{r.valid_from}</td>
                  <td>
                    {r.valid_until ?? <span className="muted">Open-ended</span>}
                  </td>
                  <td>
                    {manage && (
                      <button
                        type="button"
                        className="btn btn-quiet"
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(async () => {
                            await practice.client.send(
                              "POST",
                              `/availability-rules/${r.id}/remove`,
                              {},
                            );
                            practice.changed();
                          })
                        }
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && (
        <AddHoursDialog
          practitioner={practitioner}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}

function AddHoursDialog({
  practitioner,
  onClose,
}: {
  practitioner: Practitioner;
  onClose: () => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [locationId, setLocationId] = useState(
    practitioner.location_ids[0] ?? "",
  );
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [from, setFrom] = useState("08:00");
  const [to, setTo] = useState("17:00");
  const [validFrom, setValidFrom] = useState(todayIn(practice.tz));
  const [validUntil, setValidUntil] = useState("");
  return (
    <Dialog
      title={`Working hours · ${practitioner.display_name}`}
      onClose={onClose}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const start = parseClock(from);
          const end = parseClock(to);
          if (start === null || end === null || end <= start)
            return action.setError(
              "Enter the hours as HH:MM, the end after the start.",
            );
          void action
            .run(async () => {
              for (const weekday of days)
                await practice.client.send("POST", "/availability-rules", {
                  practitioner_id: practitioner.id,
                  location_id: locationId,
                  weekday,
                  start_minute: start,
                  end_minute: end,
                  valid_from: validFrom,
                  valid_until: validUntil || null,
                });
              practice.changed();
            })
            .then((ok) => ok && onClose());
        }}
      >
        <div className="field">
          <label htmlFor="hours-location">Location</label>
          <select
            id="hours-location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            required
          >
            {practitioner.location_ids.map((id) => (
              <option key={id} value={id}>
                {practice.location(id)?.name}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="field">
          <legend className="label">Days</legend>
          <div className="weekday-picks">
            {WEEKDAYS.map((d, i) => (
              <label key={d} className="check">
                <input
                  type="checkbox"
                  checked={days.includes(i + 1)}
                  onChange={(e) =>
                    setDays(
                      e.target.checked
                        ? [...days, i + 1].sort()
                        : days.filter((x) => x !== i + 1),
                    )
                  }
                />
                {d.slice(0, 3)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-row">
          <div className="field">
            <label htmlFor="hours-from">From</label>
            <input
              id="hours-from"
              type="time"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="hours-to">Until</label>
            <input
              id="hours-to"
              type="time"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="hours-valid-from">Starting</label>
            <input
              id="hours-valid-from"
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="hours-valid-until">
              Ending <span className="optional">(optional)</span>
            </label>
            <input
              id="hours-valid-until"
              type="date"
              value={validUntil}
              min={validFrom}
              onChange={(e) => setValidUntil(e.target.value)}
            />
          </div>
        </div>
        <ErrorNote error={action.error} />
        <div className="form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            className="btn"
            disabled={!days.length || !locationId || action.busy}
          >
            Add hours
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Leave() {
  const practice = usePractice();
  const tz = practice.tz;
  const own =
    practice.data.membership.role === "DOCTOR"
      ? practice.data.membership.practitioner_id
      : null;
  const [practitionerId, setPractitionerId] = useState(
    own ?? practice.data.practitioners[0]?.id ?? "",
  );
  const [adding, setAdding] = useState(false);
  const today = todayIn(tz);
  const list = useLoad(
    () =>
      practice.client.get<{ items: Period[] }>("/availability-exceptions", {
        practitioner_id: practitionerId,
        from: startOfDay(shiftDate(today, -7), tz).toISO(),
        to: startOfDay(shiftDate(today, 180), tz).toISO(),
      }),
    [practitionerId, today, practice.tick],
  );
  const action = useAction();
  const manage = practice.can("schedule.exceptions.manage");
  return (
    <section className="panel">
      <div className="panel__head">
        <PractitionerSelect
          value={practitionerId}
          onChange={setPractitionerId}
        />
        {manage && (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" size={18} />
            Add leave or session
          </button>
        )}
      </div>
      <div className="panel__body">
        <ErrorNote error={list.error || action.error} />
        {!list.data ? (
          <Loading what="leave and sessions" />
        ) : !list.data.items.length ? (
          <Empty title="No leave or extra sessions in the next six months" />
        ) : (
          <ul className="events">
            {list.data.items.map((x) => (
              <li key={x.id}>
                <span>
                  <Tone tone={x.kind === "AVAILABLE" ? "booked" : "closed"}>
                    {x.kind === "AVAILABLE" ? "Extra session" : "Unavailable"}
                  </Tone>{" "}
                  {x.reason_code !== "EXTRA_SESSION" &&
                    `${label(x.reason_code)} · `}
                  {fmt.when(x.starts_at, tz)} – {fmt.when(x.ends_at, tz)}
                  {x.note && <span className="muted"> · {x.note}</span>}
                </span>
                {manage && (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await practice.client.send(
                          "POST",
                          `/availability-exceptions/${x.id}/remove`,
                          {},
                        );
                        practice.changed();
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {adding && (
        <AddLeaveDialog
          practitionerId={practitionerId}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}

function AddLeaveDialog({
  practitionerId,
  onClose,
}: {
  practitionerId: string;
  onClose: () => void;
}) {
  const practice = usePractice();
  const tz = practice.tz;
  const practitioner = practice.practitioner(practitionerId);
  const action = useAction();
  const [kind, setKind] = useState<"UNAVAILABLE" | "AVAILABLE">("UNAVAILABLE");
  const [reason, setReason] =
    useState<(typeof EXCEPTION_REASONS)[number]>("LEAVE");
  const [fromDay, setFromDay] = useState(todayIn(tz));
  const [fromTime, setFromTime] = useState("00:00");
  const [toDay, setToDay] = useState(todayIn(tz));
  const [toTime, setToTime] = useState("23:59");
  const [locationId, setLocationId] = useState(
    practitioner?.location_ids[0] ?? "",
  );
  const [note, setNote] = useState("");
  const [conflicts, setConflicts] = useState<
    { appointment_id: string; starts_at: string }[] | null
  >(null);
  const submit = (acknowledge: boolean) => {
    const a = parseClock(fromTime);
    const b = parseClock(toTime);
    if (a === null || b === null)
      return action.setError("Enter times as HH:MM.");
    void action
      .run(async () => {
        try {
          await practice.client.send("POST", "/availability-exceptions", {
            practitioner_id: practitionerId,
            location_id: kind === "AVAILABLE" ? locationId : null,
            kind,
            reason_code: reason,
            start: atMinute(fromDay, a, tz),
            end: atMinute(toDay, b === 1439 ? 1440 : b, tz),
            note: note.trim() || null,
            acknowledge_conflicts: acknowledge,
          });
        } catch (e) {
          if (errorCode(e) === "SCHEDULE_BLOCK_CONFLICT") {
            const d = errorDetails(e) as {
              conflicts?: { appointment_id: string; starts_at: string }[];
            } | null;
            setConflicts(d?.conflicts ?? []);
          }
          throw e;
        }
        practice.changed();
      })
      .then((ok) => ok && onClose());
  };
  return (
    <Dialog
      title={`Leave or extra session · ${practitioner?.display_name ?? ""}`}
      onClose={onClose}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        <fieldset className="field">
          <legend className="label">This is</legend>
          <label className="check">
            <input
              type="radio"
              name="kind"
              checked={kind === "UNAVAILABLE"}
              onChange={() => {
                setKind("UNAVAILABLE");
                setReason("LEAVE");
              }}
            />
            Time away (leave, training, holiday): nothing can be booked
          </label>
          <label className="check">
            <input
              type="radio"
              name="kind"
              checked={kind === "AVAILABLE"}
              onChange={() => {
                setKind("AVAILABLE");
                setReason("EXTRA_SESSION");
              }}
            />
            An extra session outside the usual hours
          </label>
        </fieldset>
        <div className="form-row">
          <div className="field">
            <label htmlFor="leave-reason">Reason</label>
            <select
              id="leave-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as typeof reason)}
            >
              {EXCEPTION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </select>
          </div>
          {kind === "AVAILABLE" && (
            <div className="field">
              <label htmlFor="leave-location">Location</label>
              <select
                id="leave-location"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                {(practitioner?.location_ids ?? []).map((id) => (
                  <option key={id} value={id}>
                    {practice.location(id)?.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="leave-from-day">From</label>
            <input
              id="leave-from-day"
              type="date"
              value={fromDay}
              onChange={(e) => setFromDay(e.target.value)}
              required
            />
            <input
              aria-label="From time"
              type="time"
              value={fromTime}
              onChange={(e) => setFromTime(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="leave-to-day">Until</label>
            <input
              id="leave-to-day"
              type="date"
              value={toDay}
              min={fromDay}
              onChange={(e) => setToDay(e.target.value)}
              required
            />
            <input
              aria-label="Until time"
              type="time"
              value={toTime}
              onChange={(e) => setToTime(e.target.value)}
              required
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="leave-note">
            Note <span className="optional">(optional)</span>
          </label>
          <input
            id="leave-note"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {conflicts && (
          <div className="note">
            <p>
              {conflicts.length} booked appointment
              {conflicts.length === 1 ? "" : "s"} fall in this time. They stay
              booked: move or cancel them with the patients.
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
              Save anyway
            </button>
          ) : (
            <button className="btn" disabled={action.busy}>
              Save
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

function Types() {
  const practice = usePractice();
  const [editing, setEditing] = useState<AppointmentType | "new" | null>(null);
  const manage = practice.can("configuration.manage");
  const types = practice.data.appointment_types;
  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="section-title">Appointment types</h2>
        {manage && (
          <button
            type="button"
            className="btn"
            onClick={() => setEditing("new")}
          >
            <Icon name="plus" size={18} />
            Add type
          </button>
        )}
      </div>
      <div className="panel__body">
        {!types.length ? (
          <Empty title="No appointment types" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Length</th>
                <th scope="col">Rules</th>
                <th scope="col">Offered by</th>
                <th scope="col">
                  <span className="vh">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span
                      className="type-dot"
                      style={{ background: t.calendar_color ?? undefined }}
                      aria-hidden
                    />
                    {t.name}
                    <span className="mono muted small type-code">{t.code}</span>
                    {!t.active && (
                      <>
                        {" "}
                        <Tone tone="closed">Inactive</Tone>
                      </>
                    )}
                  </td>
                  <td className="num">
                    {t.duration_minutes} min
                    {(t.buffer_before_minutes > 0 ||
                      t.buffer_after_minutes > 0) && (
                      <span className="muted small">
                        {" "}
                        (+{t.buffer_before_minutes}/{t.buffer_after_minutes})
                      </span>
                    )}
                  </td>
                  <td className="small">
                    {[
                      t.requires_referral && "referral needed",
                      !t.new_patient_allowed && "existing patients only",
                      t.follow_up_only && "follow-up only",
                      t.patient_bookable
                        ? "patients may book on WhatsApp"
                        : "staff booking only",
                      t.min_notice_minutes > 0 &&
                        `${t.min_notice_minutes} min notice`,
                      `up to ${t.max_advance_days} days ahead`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                  <td className="small">
                    {t.practitioner_ids
                      .map((id) => practice.practitioner(id)?.display_name)
                      .filter(Boolean)
                      .join(", ") || <span className="muted">Nobody yet</span>}
                  </td>
                  <td>
                    {manage && (
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={() => setEditing(t)}
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <TypeDialog
          type={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function TypeDialog({
  type,
  onClose,
}: {
  type: AppointmentType | null;
  onClose: () => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [f, setF] = useState({
    code: type?.code ?? "",
    name: type?.name ?? "",
    duration: String(type?.duration_minutes ?? 15),
    before: String(type?.buffer_before_minutes ?? 0),
    after: String(type?.buffer_after_minutes ?? 0),
    interval: type?.slot_interval_minutes
      ? String(type.slot_interval_minutes)
      : "",
    notice: String(type?.min_notice_minutes ?? 0),
    advance: String(type?.max_advance_days ?? 90),
    referral: type?.requires_referral ?? false,
    newPatients: type?.new_patient_allowed ?? true,
    followUp: type?.follow_up_only ?? false,
    patientBookable: type?.patient_bookable ?? true,
    color: type?.calendar_color ?? "#2b6b63",
    active: type?.active ?? true,
    practitioners: type?.practitioner_ids ?? [],
    locations: type?.location_ids ?? practice.data.locations.map((l) => l.id),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) =>
    setF({ ...f, [k]: v });
  const toggle = (k: "practitioners" | "locations", id: string, on: boolean) =>
    set(k, on ? [...f[k], id] : f[k].filter((x) => x !== id));
  return (
    <Dialog
      title={type ? `Edit ${type.name}` : "Add appointment type"}
      onClose={onClose}
      wide
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const body = {
            name: f.name.trim(),
            duration_minutes: Number(f.duration),
            buffer_before_minutes: Number(f.before),
            buffer_after_minutes: Number(f.after),
            slot_interval_minutes: f.interval ? Number(f.interval) : null,
            min_notice_minutes: Number(f.notice),
            max_advance_days: Number(f.advance),
            requires_referral: f.referral,
            new_patient_allowed: f.newPatients,
            follow_up_only: f.followUp,
            patient_bookable: f.patientBookable,
            calendar_color: f.color,
            active: f.active,
            practitioner_ids: f.practitioners,
            location_ids: f.locations,
          };
          void action
            .run(async () => {
              if (type)
                await practice.client.send(
                  "PATCH",
                  `/appointment-types/${type.id}`,
                  {
                    ...body,
                    code: f.code,
                    expected_version: type.version,
                  },
                );
              else
                await practice.client.send("POST", "/appointment-types", {
                  ...body,
                  code: f.code.trim().toUpperCase(),
                });
              await practice.reload();
              practice.changed();
            })
            .then((ok) => ok && onClose());
        }}
      >
        <div className="form-row">
          <div className="field">
            <label htmlFor="type-name">Name</label>
            <input
              id="type-name"
              value={f.name}
              onChange={(e) => set("name", e.target.value)}
              required
              maxLength={120}
            />
          </div>
          <div className="field">
            <label htmlFor="type-code">Code</label>
            <input
              id="type-code"
              className="mono"
              value={f.code}
              onChange={(e) => set("code", e.target.value.toUpperCase())}
              required
              pattern="[A-Z0-9_]{2,40}"
            />
          </div>
          <div className="field">
            <label htmlFor="type-color">Calendar colour</label>
            <input
              id="type-color"
              type="color"
              value={f.color}
              onChange={(e) => set("color", e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="type-duration">Length (min)</label>
            <input
              id="type-duration"
              type="number"
              min={5}
              max={480}
              value={f.duration}
              onChange={(e) => set("duration", e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="type-before">Buffer before</label>
            <input
              id="type-before"
              type="number"
              min={0}
              max={240}
              value={f.before}
              onChange={(e) => set("before", e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="type-after">Buffer after</label>
            <input
              id="type-after"
              type="number"
              min={0}
              max={240}
              value={f.after}
              onChange={(e) => set("after", e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="type-interval">
              Start every{" "}
              <span className="optional">(min, blank: practice default)</span>
            </label>
            <input
              id="type-interval"
              type="number"
              min={5}
              max={240}
              value={f.interval}
              onChange={(e) => set("interval", e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="type-notice">Minimum notice (min)</label>
            <input
              id="type-notice"
              type="number"
              min={0}
              max={43200}
              value={f.notice}
              onChange={(e) => set("notice", e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="type-advance">Bookable up to (days ahead)</label>
            <input
              id="type-advance"
              type="number"
              min={1}
              max={730}
              value={f.advance}
              onChange={(e) => set("advance", e.target.value)}
            />
          </div>
        </div>
        <div className="check-grid">
          <label className="check">
            <input
              type="checkbox"
              checked={f.referral}
              onChange={(e) => set("referral", e.target.checked)}
            />
            Needs a referral
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={f.newPatients}
              onChange={(e) => set("newPatients", e.target.checked)}
            />
            New patients may book it
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={f.followUp}
              onChange={(e) => set("followUp", e.target.checked)}
            />
            Follow-up with the same practitioner only
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={f.patientBookable}
              onChange={(e) => set("patientBookable", e.target.checked)}
            />
            Patients may book it themselves (WhatsApp)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={f.active}
              onChange={(e) => set("active", e.target.checked)}
            />
            Active
          </label>
        </div>
        <fieldset className="field">
          <legend className="label">Offered by</legend>
          <div className="check-grid">
            {practice.data.practitioners.map((p) => (
              <label key={p.id} className="check">
                <input
                  type="checkbox"
                  checked={f.practitioners.includes(p.id)}
                  onChange={(e) =>
                    toggle("practitioners", p.id, e.target.checked)
                  }
                />
                {p.display_name}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field">
          <legend className="label">At</legend>
          <div className="check-grid">
            {practice.data.locations.map((l) => (
              <label key={l.id} className="check">
                <input
                  type="checkbox"
                  checked={f.locations.includes(l.id)}
                  onChange={(e) => toggle("locations", l.id, e.target.checked)}
                />
                {l.name}
              </label>
            ))}
          </div>
        </fieldset>
        <ErrorNote error={action.error} />
        <div className="form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={action.busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Practitioners() {
  const practice = usePractice();
  const [editing, setEditing] = useState<Practitioner | "new" | null>(null);
  const manage = practice.can("configuration.manage");
  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="section-title">Practitioners</h2>
        {manage && (
          <button
            type="button"
            className="btn"
            onClick={() => setEditing("new")}
          >
            <Icon name="plus" size={18} />
            Add practitioner
          </button>
        )}
      </div>
      <div className="panel__body">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Profession</th>
              <th scope="col">Works at</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="vh">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {practice.data.practitioners.map((p) => (
              <tr key={p.id}>
                <td>
                  <span
                    className="type-dot"
                    style={{ background: p.calendar_color ?? undefined }}
                    aria-hidden
                  />
                  {p.display_name}
                  {p.registration_number && (
                    <span className="mono muted small">
                      {" "}
                      {p.registration_number}
                    </span>
                  )}
                </td>
                <td>{label(p.profession)}</td>
                <td className="small">
                  {p.location_ids
                    .map((id) => practice.location(id)?.name)
                    .join(", ")}
                </td>
                <td>
                  {p.active ? (
                    <Tone tone="booked">Active</Tone>
                  ) : (
                    <Tone tone="closed">Inactive</Tone>
                  )}
                  {!p.bookable_by_patients && (
                    <span className="muted small"> · staff booking only</span>
                  )}
                </td>
                <td>
                  {manage && (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => setEditing(p)}
                    >
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <PractitionerDialog
          practitioner={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function PractitionerDialog({
  practitioner: p,
  onClose,
}: {
  practitioner: Practitioner | null;
  onClose: () => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [f, setF] = useState({
    display: p?.display_name ?? "",
    title: p?.title ?? "",
    given: p?.given_name ?? "",
    family: p?.family_name ?? "",
    profession: p?.profession ?? "DOCTOR",
    registration: p?.registration_number ?? "",
    color: p?.calendar_color ?? "#3b7cb3",
    active: p?.active ?? true,
    patients: p?.bookable_by_patients ?? true,
    locations:
      p?.location_ids ?? practice.data.locations.slice(0, 1).map((l) => l.id),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) =>
    setF({ ...f, [k]: v });
  return (
    <Dialog
      title={p ? `Edit ${p.display_name}` : "Add practitioner"}
      onClose={onClose}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const body = {
            display_name: f.display.trim(),
            title: f.title.trim() || null,
            given_name: f.given.trim() || null,
            family_name: f.family.trim(),
            profession: f.profession,
            registration_number: f.registration.trim() || null,
            calendar_color: f.color,
            active: f.active,
            bookable_by_patients: f.patients,
            location_ids: f.locations,
          };
          void action
            .run(async () => {
              if (p)
                await practice.client.send("PATCH", `/practitioners/${p.id}`, {
                  ...body,
                  expected_version: p.version,
                });
              else await practice.client.send("POST", "/practitioners", body);
              await practice.reload();
              practice.changed();
            })
            .then((ok) => ok && onClose());
        }}
      >
        <div className="form-row">
          <div className="field">
            <label htmlFor="pr-display">Name shown to staff and patients</label>
            <input
              id="pr-display"
              value={f.display}
              onChange={(e) => set("display", e.target.value)}
              required
              maxLength={120}
              placeholder="Dr N. Naidoo"
            />
          </div>
          <div className="field">
            <label htmlFor="pr-title">
              Title <span className="optional">(optional)</span>
            </label>
            <input
              id="pr-title"
              value={f.title}
              onChange={(e) => set("title", e.target.value)}
              maxLength={20}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="pr-given">
              Given name <span className="optional">(optional)</span>
            </label>
            <input
              id="pr-given"
              value={f.given}
              onChange={(e) => set("given", e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="pr-family">Family name</label>
            <input
              id="pr-family"
              value={f.family}
              onChange={(e) => set("family", e.target.value)}
              required
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="pr-profession">Profession</label>
            <select
              id="pr-profession"
              value={f.profession}
              onChange={(e) => set("profession", e.target.value)}
            >
              <option value="DOCTOR">Doctor</option>
              <option value="NURSE">Nurse</option>
              <option value="ALLIED_HEALTH">Allied health</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="pr-reg">
              Registration number <span className="optional">(optional)</span>
            </label>
            <input
              id="pr-reg"
              value={f.registration}
              onChange={(e) => set("registration", e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="pr-color">Calendar colour</label>
            <input
              id="pr-color"
              type="color"
              value={f.color}
              onChange={(e) => set("color", e.target.value)}
            />
          </div>
        </div>
        <fieldset className="field">
          <legend className="label">Works at</legend>
          <div className="check-grid">
            {practice.data.locations.map((l) => (
              <label key={l.id} className="check">
                <input
                  type="checkbox"
                  checked={f.locations.includes(l.id)}
                  onChange={(e) =>
                    set(
                      "locations",
                      e.target.checked
                        ? [...f.locations, l.id]
                        : f.locations.filter((x) => x !== l.id),
                    )
                  }
                />
                {l.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="check">
          <input
            type="checkbox"
            checked={f.patients}
            onChange={(e) => set("patients", e.target.checked)}
          />
          Patients may book with this practitioner themselves (WhatsApp)
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={f.active}
            onChange={(e) => set("active", e.target.checked)}
          />
          Active
        </label>
        <ErrorNote error={action.error} />
        <div className="form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={action.busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Locations() {
  const practice = usePractice();
  const [editing, setEditing] = useState<Location | "new" | null>(null);
  const manage = practice.can("configuration.manage");
  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="section-title">Locations</h2>
        {manage && (
          <button
            type="button"
            className="btn"
            onClick={() => setEditing("new")}
          >
            <Icon name="plus" size={18} />
            Add location
          </button>
        )}
      </div>
      <div className="panel__body">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Address</th>
              <th scope="col">Time zone</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="vh">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {practice.data.locations.map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td className="small">
                  {[l.address_line1, l.city].filter(Boolean).join(", ")}
                </td>
                <td className="mono small">{l.timezone}</td>
                <td>
                  {l.active ? (
                    <Tone tone="booked">Active</Tone>
                  ) : (
                    <Tone tone="closed">Inactive</Tone>
                  )}
                </td>
                <td>
                  {manage && (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => setEditing(l)}
                    >
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <LocationDialog
          location={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function LocationDialog({
  location: l,
  onClose,
}: {
  location: Location | null;
  onClose: () => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [f, setF] = useState({
    name: l?.name ?? "",
    timezone: l?.timezone ?? practice.tz,
    line1: l?.address_line1 ?? "",
    city: l?.city ?? "",
    postal: l?.postal_code ?? "",
    phone: l?.phone ?? "",
    active: l?.active ?? true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) =>
    setF({ ...f, [k]: v });
  return (
    <Dialog title={l ? `Edit ${l.name}` : "Add location"} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const body = {
            name: f.name.trim(),
            timezone: f.timezone.trim(),
            address_line1: f.line1.trim() || null,
            city: f.city.trim() || null,
            postal_code: f.postal.trim() || null,
            phone: f.phone.trim() || null,
            active: f.active,
          };
          void action
            .run(async () => {
              if (l)
                await practice.client.send("PATCH", `/locations/${l.id}`, {
                  ...body,
                  expected_version: l.version,
                });
              else await practice.client.send("POST", "/locations", body);
              await practice.reload();
            })
            .then((ok) => ok && onClose());
        }}
      >
        <div className="form-row">
          <div className="field">
            <label htmlFor="loc-name">Name</label>
            <input
              id="loc-name"
              value={f.name}
              onChange={(e) => set("name", e.target.value)}
              required
              maxLength={120}
            />
          </div>
          <div className="field">
            <label htmlFor="loc-tz">Time zone (IANA)</label>
            <input
              id="loc-tz"
              className="mono"
              value={f.timezone}
              onChange={(e) => set("timezone", e.target.value)}
              required
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="loc-line1">Address</label>
          <input
            id="loc-line1"
            value={f.line1}
            onChange={(e) => set("line1", e.target.value)}
            maxLength={200}
          />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="loc-city">City</label>
            <input
              id="loc-city"
              value={f.city}
              onChange={(e) => set("city", e.target.value)}
              maxLength={100}
            />
          </div>
          <div className="field">
            <label htmlFor="loc-postal">Postal code</label>
            <input
              id="loc-postal"
              value={f.postal}
              onChange={(e) => set("postal", e.target.value)}
              maxLength={20}
            />
          </div>
          <div className="field">
            <label htmlFor="loc-phone">Phone (+27…)</label>
            <input
              id="loc-phone"
              type="tel"
              value={f.phone}
              onChange={(e) => set("phone", e.target.value)}
              pattern="\+[1-9][0-9]{6,14}"
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={f.active}
            onChange={(e) => set("active", e.target.checked)}
          />
          Active
        </label>
        <ErrorNote error={action.error} />
        <div className="form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={action.busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function PracticeSettingsForm() {
  const practice = usePractice();
  const s = practice.data.practice;
  const manage = practice.can("configuration.manage");
  const action = useAction();
  const [saved, setSaved] = useState(false);
  const [f, setF] = useState({
    name: s.name,
    phone: s.contact_phone ?? "",
    email: s.contact_email ?? "",
    hold: String(Math.round(s.hold_ttl_seconds / 60)),
    interval: String(s.default_slot_interval_minutes),
    reminder24: s.reminder_24h_enabled,
    nearTerm: s.near_term_reminder_minutes
      ? String(s.near_term_reminder_minutes)
      : "",
    offer: String(s.waitlist_offer_ttl_minutes),
    verify: s.referral_verification_required,
    cutoff: String(Math.round(s.patient_change_cutoff_minutes / 60)),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    setSaved(false);
    setF({ ...f, [k]: v });
  };
  return (
    <form
      className="panel panel__body form"
      onSubmit={(e) => {
        e.preventDefault();
        void action
          .run(async () => {
            await practice.client.send("PATCH", "/settings", {
              name: f.name.trim(),
              contact_phone: f.phone.trim() || null,
              contact_email: f.email.trim() || null,
              hold_ttl_seconds: Number(f.hold) * 60,
              default_slot_interval_minutes: Number(f.interval),
              reminder_24h_enabled: f.reminder24,
              near_term_reminder_minutes: f.nearTerm
                ? Number(f.nearTerm)
                : null,
              waitlist_offer_ttl_minutes: Number(f.offer),
              referral_verification_required: f.verify,
              patient_change_cutoff_minutes: Number(f.cutoff) * 60,
              expected_version: s.version,
            });
            await practice.reload();
          })
          .then((ok) => ok && setSaved(true));
      }}
    >
      <fieldset disabled={!manage} className="form">
        <div className="form-row">
          <div className="field">
            <label htmlFor="ps-name">Practice name</label>
            <input
              id="ps-name"
              value={f.name}
              onChange={(e) => set("name", e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="ps-phone">Phone for patients (+27…)</label>
            <input
              id="ps-phone"
              type="tel"
              value={f.phone}
              onChange={(e) => set("phone", e.target.value)}
              pattern="\+[1-9][0-9]{6,14}"
            />
          </div>
          <div className="field">
            <label htmlFor="ps-email">E-mail for patients</label>
            <input
              id="ps-email"
              type="email"
              value={f.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="ps-hold">Hold a chosen time for (minutes)</label>
            <input
              id="ps-hold"
              type="number"
              min={1}
              max={30}
              value={f.hold}
              onChange={(e) => set("hold", e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ps-interval">
              Default start interval (minutes)
            </label>
            <input
              id="ps-interval"
              type="number"
              min={5}
              max={120}
              value={f.interval}
              onChange={(e) => set("interval", e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ps-offer">
              Waitlist offers stay open for (minutes)
            </label>
            <input
              id="ps-offer"
              type="number"
              min={5}
              max={1440}
              value={f.offer}
              onChange={(e) => set("offer", e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="ps-cutoff">
              Patients may change bookings themselves until (hours before)
            </label>
            <input
              id="ps-cutoff"
              type="number"
              min={0}
              max={168}
              value={f.cutoff}
              onChange={(e) => set("cutoff", e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ps-near">
              Near-term reminder (minutes before){" "}
              <span className="optional">(blank: none)</span>
            </label>
            <input
              id="ps-near"
              type="number"
              min={15}
              max={720}
              value={f.nearTerm}
              onChange={(e) => set("nearTerm", e.target.value)}
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={f.reminder24}
            onChange={(e) => set("reminder24", e.target.checked)}
          />
          Send a reminder 24 hours before each appointment
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={f.verify}
            onChange={(e) => set("verify", e.target.checked)}
          />
          Referrals must be verified before they authorise bookings
        </label>
        <ErrorNote error={action.error} />
        {saved && <p className="note">Saved.</p>}
        {manage && (
          <div className="form__actions">
            <button className="btn" disabled={action.busy}>
              Save settings
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
