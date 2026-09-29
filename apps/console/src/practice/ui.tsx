import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { problem } from "./api";
import { usePractice } from "./context";
import { fmt } from "./time";
import {
  CHANNEL_LABELS,
  CHANNELS,
  type AppointmentStatus,
  type Channel,
  type PatientSummary,
  type Slot,
} from "./types";

/**
 * Load data for a view; re-loads when `deps` change (include
 * `practice.tick` to follow live schedule changes). A refresh keeps the
 * previous data on screen until the new data arrives.
 */
export function useLoad<T>(
  fn: () => Promise<T>,
  deps: React.DependencyList,
): {
  data: T | null;
  error: string;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  // `deps` names what the loader reads (the caller's closure changes on
  // every render, so it cannot be the dependency itself).
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const value = await run();
      if (mine === seq.current) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (mine === seq.current) setError(problem(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

const STATUS: Record<
  AppointmentStatus,
  { text: string; tone: string; glyph: string }
> = {
  HELD: { text: "Held", tone: "attention", glyph: "ring" },
  CONFIRMED: { text: "Booked", tone: "booked", glyph: "dot" },
  CHECKED_IN: { text: "Arrived", tone: "progress", glyph: "dot" },
  IN_PROGRESS: { text: "In consultation", tone: "progress", glyph: "square" },
  COMPLETED: { text: "Completed", tone: "closed", glyph: "square" },
  NO_SHOW: { text: "No-show", tone: "exception", glyph: "square" },
  CANCELLED: { text: "Cancelled", tone: "closed", glyph: "bar" },
  RESCHEDULED: { text: "Moved", tone: "closed", glyph: "bar" },
  EXPIRED: { text: "Hold lapsed", tone: "closed", glyph: "ring" },
};
export function statusText(status: AppointmentStatus): string {
  return STATUS[status].text;
}
/** An appointment's status: always a word and a shape, colour only supports. */
export function StatusBadge({ status }: { status: AppointmentStatus }) {
  const s = STATUS[status];
  return (
    <span className={`state state--${s.tone}`}>
      <span className={`glyph glyph--${s.glyph}`} aria-hidden />
      {s.text}
    </span>
  );
}
export function Tone({
  tone,
  children,
}: {
  tone: "attention" | "progress" | "booked" | "exception" | "closed" | "system";
  children: React.ReactNode;
}) {
  return <span className={`state state--${tone}`}>{children}</span>;
}

export function ErrorNote({ error }: { error: string }) {
  if (!error) return null;
  return (
    <p className="alert" role="alert">
      <Icon name="alert" size={18} />
      <span>{error}</span>
    </p>
  );
}
export function Loading({ what }: { what: string }) {
  return <p className="loading">Loading {what}…</p>;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}

/**
 * A modal dialog (native <dialog>: focus is trapped and Escape closes it).
 */
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? " dialog--wide" : ""}`}
      aria-labelledby="dialog-title"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="dialog__head">
        <h2 id="dialog-title" className="section-title">
          {title}
        </h2>
        <button
          type="button"
          className="btn btn-quiet dialog__close"
          onClick={onClose}
          aria-label="Close"
        >
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="dialog__body">{children}</div>
    </dialog>
  );
}

/** Run a change; the button shows progress and refusals appear beside it. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError(problem(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/**
 * A button for a change that removes or ends something. The first press
 * asks in place ("Remove these hours?"); only the second, on the confirming
 * button, acts. Focus moves to the confirming button, and Escape or "Keep"
 * backs out.
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel = label,
  onConfirm,
  disabled = false,
  className = "btn btn-quiet",
}: {
  label: string;
  question: string;
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) confirm.current?.focus();
  }, [asking]);
  if (!asking)
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  return (
    <span
      className="confirm"
      role="group"
      aria-label={question}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Back out of the question only, not a dialog around it.
        e.preventDefault();
        e.stopPropagation();
        setAsking(false);
      }}
    >
      <span className="confirm__question">{question}</span>
      <button
        ref={confirm}
        type="button"
        className="btn btn-danger"
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setAsking(false)}
      >
        Keep
      </button>
    </span>
  );
}

export function ChannelSelect({
  id,
  value,
  onChange,
  label = "How the request reached us",
}: {
  id: string;
  value: Channel;
  onChange: (c: Channel) => void;
  label?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as Channel)}
      >
        {CHANNELS.map((c) => (
          <option key={c} value={c}>
            {CHANNEL_LABELS[c]}
          </option>
        ))}
      </select>
    </div>
  );
}

/** What the search box holds decides the search: number, e-mail or name. */
function searchQuery(text: string): Record<string, string> {
  const t = text.trim();
  if (/^\d{13}$/.test(t)) return { national_id: t };
  if (/^P\d{4,}$/i.test(t)) return { patient_number: t };
  if (/^[+0-9][0-9 ()-]{6,}$/.test(t)) return { mobile: t };
  if (t.includes("@")) return { email: t };
  return { q: t };
}

/**
 * Find a patient by mobile number, e-mail, patient number, national ID or
 * name. Exact identifiers first; names are a prefix search. Similar names
 * are never merged: staff choose.
 */
export function PatientPicker({
  onPick,
  autoFocus = false,
}: {
  onPick: (p: PatientSummary) => void;
  autoFocus?: boolean;
}) {
  const practice = usePractice();
  const [text, setText] = useState("");
  const [results, setResults] = useState<PatientSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (text.trim().length < 2) return;
    setBusy(true);
    setError("");
    try {
      const r = await practice.client.get<{ items: PatientSummary[] }>(
        "/patients",
        { ...searchQuery(text), limit: 20 },
      );
      setResults(r.items);
    } catch (err) {
      setError(problem(err));
      setResults(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="picker">
      {/* Not a <form>: the picker sits inside other forms (waitlist,
          referrals), and a nested form submits natively and reloads. */}
      <div className="search-row" role="search">
        <label className="vh" htmlFor="patient-search">
          Find a patient
        </label>
        <input
          id="patient-search"
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter searches here and never submits a surrounding form.
            if (e.key !== "Enter") return;
            e.preventDefault();
            void search();
          }}
          placeholder="Mobile, e-mail, patient number, ID or name"
          autoComplete="off"
        />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void search()}
        >
          <Icon name="search" size={18} />
          Search
        </button>
      </div>
      <ErrorNote error={error} />
      {results && results.length === 0 && (
        <p className="muted small">
          No patient matches. Check the number or spelling, or register the
          patient.
        </p>
      )}
      {results && results.length > 0 && (
        <ul className="pick-list">
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onPick(p)}>
                <span className="pick-list__main">
                  <strong>{p.display_name}</strong>
                  <span className="mono muted">{p.patient_number}</span>
                </span>
                <span className="pick-list__meta muted small">
                  {[
                    p.date_of_birth && `Born ${p.date_of_birth}`,
                    p.primary_mobile,
                    p.identity_verification === "UNVERIFIED" &&
                      "Identity not verified",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Real availability from the Scheduling Core for a type, grouped by day.
 * Nothing here computes availability; the list is exactly what the API
 * returned for the window.
 */
export function SlotPicker({
  typeId,
  practitionerId,
  locationId,
  from,
  days = 7,
  rescheduleOf,
  selected,
  onPick,
}: {
  typeId: string;
  practitionerId?: string | undefined;
  locationId?: string | undefined;
  from: string;
  days?: number;
  rescheduleOf?: string | undefined;
  selected?: Slot | null | undefined;
  onPick: (s: Slot) => void;
}) {
  const practice = usePractice();
  const { data, error, loading } = useLoad(
    () =>
      practice.client.get<{ slots: Slot[] }>("/availability", {
        appointment_type_id: typeId,
        from,
        to: new Date(Date.parse(from) + days * 86_400_000).toISOString(),
        practitioner_id: practitionerId,
        location_id: locationId,
        reschedule_of: rescheduleOf,
        limit: 400,
      }),
    [
      typeId,
      practitionerId,
      locationId,
      from,
      days,
      rescheduleOf,
      practice.tick,
    ],
  );
  // One day at a time: a week of two practitioners' times is hundreds of
  // buttons. The chosen day survives refreshes (it is kept by its label).
  const [day, setDay] = useState<string | null>(null);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading what="available times" />;
  const byDay = new Map<string, Slot[]>();
  // The held time is no longer available, so it drops out of refreshed
  // results; keep showing it as the chosen one.
  const same = (a: Slot, b: Slot) =>
    a.start === b.start &&
    a.practitioner_id === b.practitioner_id &&
    a.location_id === b.location_id;
  const shown =
    selected && !data.slots.some((s) => same(s, selected))
      ? [...data.slots, selected].sort(
          (a, b) => Date.parse(a.start) - Date.parse(b.start),
        )
      : data.slots;
  if (!shown.length)
    return (
      <Empty title="No available times in this window">
        Try later dates, another practitioner, or add the patient to the
        waitlist.
      </Empty>
    );
  for (const s of shown) {
    const d = fmt.day(s.start, s.timezone);
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const dayList = [...byDay.entries()];
  const wanted =
    day ?? (selected ? fmt.day(selected.start, selected.timezone) : null);
  const [current, slots] = dayList.find(([d]) => d === wanted) ?? dayList[0]!;
  return (
    <div className={`slots${loading ? " is-refreshing" : ""}`}>
      <div className="slot-days" role="group" aria-label="Day">
        {dayList.map(([d, list]) => (
          <button
            key={d}
            type="button"
            aria-pressed={d === current}
            onClick={() => setDay(d)}
          >
            <span className="slot-days__day">{d}</span>
            <span className="slot-days__count">
              {list.length} time{list.length === 1 ? "" : "s"}
            </span>
          </button>
        ))}
      </div>
      <ul className="slots__list" aria-label={`Times on ${current}`}>
        {slots.map((s) => {
          const on = !!selected && same(selected, s);
          return (
            <li key={`${s.practitioner_id}:${s.location_id}:${s.start}`}>
              <button
                type="button"
                className="slot"
                aria-pressed={on}
                onClick={() => onPick(s)}
              >
                <span className="slot__time">
                  {fmt.time(s.start, s.timezone)}
                </span>
                <span className="slot__who">
                  {s.practitioner_name}
                  <span className="muted"> · {s.location_name}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
