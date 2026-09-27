import React, { useEffect, useId, useRef, useState } from "react";
import { api, newIds } from "../api";
import { Icon } from "../components/Icon";
import {
  CASE_TYPE_LABELS,
  failureText,
  label,
  reasonLabel,
  slotDay,
  slotTime,
  stamp,
  when,
  WORKFLOW_LABELS,
} from "../format";
import { useSession } from "../session";
import type {
  AppointmentRequestView,
  AppointmentView,
  CaseView,
  Slot,
} from "../types";

/**
 * The Booking stage. Every button here is a command to ACCESS; the worker
 * talks to the destination system. Nothing is booked, held or cancelled by
 * the browser, and a slot on screen is never a reservation.
 */

const MANAGERS = ["PRACTICE_MANAGER", "ADMIN"];
const IN_FLIGHT = ["PENDING", "LEASED", "RETRYABLE", "RECONCILING"];
/** A hold with less than this left is not used for booking (as the API). */
const HOLD_MARGIN_MS = 15_000;

/** A step is running, or its outcome is being checked, without staff. */
export function stepRunning(req: AppointmentRequestView | null): boolean {
  const p = req?.pending_execution;
  if (!p || p.superseded) return false;
  return (
    IN_FLIGHT.includes(p.status) || (p.status === "AMBIGUOUS" && !p.escalated)
  );
}
const unconfirmed = (req: AppointmentRequestView) =>
  req.pending_execution?.status === "AMBIGUOUS" &&
  req.pending_execution.escalated &&
  !req.pending_execution.superseded;

function useCommand(onDone: () => void) {
  const session = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const run = async (
    name: string,
    path: string,
    body: Record<string, unknown>,
    after?: (result: Record<string, unknown>) => void,
  ) => {
    setBusy(name);
    setError("");
    try {
      const result = await api<Record<string, unknown>>(session.headers, path, {
        method: "POST",
        body: { ...newIds(), ...body },
      });
      if (after) after(result);
      else onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run, setError };
}

// ---------------------------------------------------------------------------
// Appointment operations case: the booking panel
// ---------------------------------------------------------------------------

export function BookingPanel({
  view,
  onDone,
}: {
  view: CaseView;
  onDone: () => void;
}) {
  const session = useSession();
  const role = session.me?.role ?? "READ_ONLY";
  const req = view.appointment_request!;
  const caseType = req.case_type;
  const mayAct =
    role !== "READ_ONLY" &&
    (caseType === "APPOINTMENT_REQUEST" || MANAGERS.includes(role));
  const cmd = useCommand(onDone);
  const step = (
    action: string,
    extra: Record<string, unknown> = {},
    after?: () => void,
  ) =>
    cmd.run(
      action,
      `/v1/cases/${view.case.id}/appointment-actions`,
      { action, expected_version: req.version, ...extra },
      after ? () => (after(), onDone()) : undefined,
    );
  const current = view.appointments.find((a) => a.id === req.appointment_id);
  const original = view.appointments.find(
    (a) => a.id === req.original_appointment_id,
  );
  const state = view.case.current_state;
  const finished = ["BOOKED", "COMPLETED", "CANCELLED", "WITHDRAWN"].includes(
    req.workflow_status,
  );

  return (
    <section className="panel booking" aria-labelledby="booking-title">
      <div className="booking__head">
        <div>
          <p className="caps">{CASE_TYPE_LABELS[caseType]}</p>
          <h2 className="section-title" id="booking-title">
            {WORKFLOW_LABELS[req.workflow_status]}
          </h2>
        </div>
        {req.origin_referral_case_id && (
          <a
            className="booking__origin"
            href={`#/case/${req.origin_referral_case_id}`}
          >
            Referral <span className="mono">{req.origin_display_ref}</span>
          </a>
        )}
      </div>
      <BookingSteps req={req} appointment={current} />
      <Situation
        req={req}
        state={state}
        exception={view.case.exception_reason}
      />

      {original && (
        <AppointmentCard
          appointment={original}
          title={
            caseType === "CANCELLATION_REQUEST"
              ? original.status === "BOOKED"
                ? "Appointment to cancel"
                : "Appointment"
              : original.status === "BOOKED"
                ? "Current appointment"
                : "Original appointment"
          }
        />
      )}
      {current && caseType !== "CANCELLATION_REQUEST" && (
        <AppointmentCard
          appointment={current}
          title={
            caseType === "RESCHEDULING_REQUEST"
              ? "New appointment"
              : "Appointment"
          }
          checking={["COMMITTED", "REPLACEMENT_BOOKED"].includes(
            req.workflow_status,
          )}
        />
      )}

      {!mayAct ? (
        <p className="actions__readonly">
          <Icon name="lock" size={18} />
          {role === "READ_ONLY"
            ? "Read-only access: no actions available."
            : "Only a practice manager can change a booked appointment."}
        </p>
      ) : (
        !finished && (
          <Steps
            view={view}
            req={req}
            step={step}
            busy={cmd.busy}
            current={current}
            original={original}
          />
        )
      )}
      {mayAct && current?.status === "BOOKED" && finished && (
        <AppointmentChanges appointment={current} onDone={onDone} />
      )}
      {cmd.error && (
        <p className="alert" role="alert">
          {cmd.error}
        </p>
      )}
    </section>
  );
}

/** Where the request is, as a short line of steps. Presentation only. */
function BookingSteps({
  req,
  appointment,
}: {
  req: AppointmentRequestView;
  appointment: AppointmentView | undefined;
}) {
  const w = req.workflow_status;
  const order: Record<string, number> = {
    AVAILABILITY_REQUESTED: 0,
    NO_AVAILABILITY: 0,
    AVAILABILITY_RETURNED: 1,
    SLOT_SELECTED: 2,
    HOLD_REQUESTED: 2,
    HELD: 3,
    BOOKING_SUBMITTED: 3,
    COMMITTED: 3,
    REPLACEMENT_BOOKED: 4,
    ORIGINAL_CANCELLATION_PENDING: 5,
    BOOKED: 4,
    COMPLETED: 6,
    CANCELLATION_REQUESTED: 0,
    CANCELLATION_SUBMITTED: 1,
    CANCELLED: 3,
    WITHDRAWN: -1,
  };
  const names =
    req.case_type === "CANCELLATION_REQUEST"
      ? ["Requested", "Submitted", "Cancelled"]
      : req.case_type === "RESCHEDULING_REQUEST"
        ? [
            "Availability",
            "Select",
            "Hold",
            "New booking",
            "Check",
            "Cancel original",
          ]
        : ["Availability", "Select", "Hold", "Commit", "Confirm"];
  const confirmed = appointment?.confirmation_status === "CONFIRMED";
  const at =
    req.case_type === "APPOINTMENT_REQUEST" && w === "BOOKED" && confirmed
      ? names.length
      : order[w]!;
  // The hold is optional: once past it, it counts as done only if a hold
  // was actually taken (a booking consumes it).
  const held = req.hold?.status === "ACTIVE" || req.hold?.status === "CONSUMED";
  return (
    <ol className="booking-steps" aria-label="Booking steps">
      {names.map((name, i) => {
        const passed = w !== "WITHDRAWN" && i < at;
        const status =
          w === "WITHDRAWN"
            ? "skipped"
            : passed
              ? name === "Hold" && !held
                ? "skipped"
                : "done"
              : i === at
                ? "current"
                : "ahead";
        return (
          <li
            key={name}
            className={`booking-steps__step is-${status}${passed ? " is-passed" : ""}`}
            aria-current={status === "current" ? "step" : undefined}
          >
            <span className="booking-steps__node" aria-hidden />
            <span className="booking-steps__name">{name}</span>
            {name === "Hold" && status !== "done" && (
              <span className="booking-steps__note">
                {passed ? "Not used" : "Optional"}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const RUNNING: Record<string, string> = {
  "appointment.availability.read":
    "Searching the destination system for appointments.",
  "appointment.hold": "Asking the destination system to hold the slot.",
  "appointment.create": "Sending the booking to the destination system.",
  "appointment.verify":
    "Checking with the destination system that the appointment is there.",
  "appointment.reschedule":
    "Booking the new appointment. The original is not touched until the new one is checked in the destination system.",
  "appointment.reschedule.cancel_original":
    "The new appointment is in the destination system. Cancelling the original.",
  "appointment.cancel": "Sending the cancellation to the destination system.",
};
const WHAT: Record<string, string> = {
  "appointment.hold": "hold",
  "appointment.create": "booking",
  "appointment.reschedule": "new appointment",
  "appointment.reschedule.cancel_original": "cancellation of the original",
  "appointment.cancel": "cancellation",
};

/** Plain-language explanation of the current position. */
function Situation({
  req,
  state,
  exception,
}: {
  req: AppointmentRequestView;
  state: string;
  exception: string | null;
}) {
  const p = req.pending_execution;
  let tone: "info" | "attention" | "exception" = "info";
  let text: React.ReactNode = null;
  if (
    p &&
    !p.superseded &&
    (p.status === "AMBIGUOUS" || p.status === "RECONCILING")
  ) {
    const what = WHAT[p.operation] ?? "request";
    if (p.escalated) {
      tone = "exception";
      text = `ACCESS could not confirm with the destination system whether the ${what} was made. Check the destination system, then ask ACCESS to check again or confirm it is not there. Nothing is sent again until then.`;
    } else {
      tone = "attention";
      text =
        p.operation === "appointment.create"
          ? "Booking submitted. The destination system has not yet confirmed whether it was committed. ACCESS is checking before attempting anything else."
          : `The ${what} was sent. The destination system has not yet confirmed whether it happened. ACCESS is checking before attempting anything else.`;
    }
  } else if (p && !p.superseded && IN_FLIGHT.includes(p.status)) {
    text =
      RUNNING[p.operation] ?? "ACCESS is working with the destination system.";
  } else if (state === "EXCEPTION") {
    tone = "exception";
    text = exceptionText(exception);
  } else if (req.last_failure_code) {
    tone = "attention";
    text = failureText(req.last_failure_code);
  } else if (req.workflow_status === "NO_AVAILABILITY") {
    tone = "attention";
    text =
      "The destination system has no free appointment in this window. Search a wider window, or withdraw and book by hand.";
  }
  if (!text) return null;
  return (
    <p className={`booking-situation booking-situation--${tone}`} role="status">
      {tone === "exception" && <Icon name="alert" size={18} />}
      <span>{text}</span>
    </p>
  );
}
function exceptionText(reason: string | null): string {
  const r = reason ?? "";
  if (
    r.includes("both_appointments_may_exist") ||
    r.includes("both_appointments_exist")
  )
    return "The new appointment is booked, but the original may not have been cancelled. Both appointments may currently exist in the destination system.";
  if (r === "original_already_cancelled_elsewhere")
    return "The original appointment was already cancelled at the destination. Check the destination system, then confirm the original is cancelled.";
  if (r.startsWith("availability_unavailable"))
    return "The destination system could not be searched. Search again later, or withdraw and book by hand.";
  if (r.startsWith("booking_refused"))
    return `The destination system refused the booking. ${failureText(r.split(":")[1]?.toUpperCase())}`;
  if (
    r.startsWith("booking_not_verified") ||
    r.startsWith("replacement_not_verified")
  )
    return "The destination system did not show the appointment when ACCESS checked it. Ask ACCESS to check again; if it still cannot be found, contact the destination.";
  if (r.startsWith("cancellation_refused"))
    return "The destination system refused the cancellation.";
  return `Held for a person: ${reasonLabel(r)}.`;
}

type StepFn = (
  action: string,
  extra?: Record<string, unknown>,
  after?: () => void,
) => Promise<void>;

/** The actions that apply now. */
function Steps({
  view,
  req,
  step,
  busy,
  current,
  original,
}: {
  view: CaseView;
  req: AppointmentRequestView;
  step: StepFn;
  busy: string | null;
  current: AppointmentView | undefined;
  original: AppointmentView | undefined;
}) {
  const w = req.workflow_status;
  const running = stepRunning(req);
  const exception = view.case.current_state === "EXCEPTION";
  // The new appointment exists; the original's cancellation is not done.
  const bothMayExist =
    req.case_type === "RESCHEDULING_REQUEST" &&
    w === "ORIGINAL_CANCELLATION_PENDING" &&
    (exception || !running);
  const choosing = w === "AVAILABILITY_RETURNED";
  const chosen = ["SLOT_SELECTED", "HELD"].includes(w) && !!req.selected_slot;
  return (
    <div className="booking__work">
      {choosing && req.availability && (
        <Availability req={req} step={step} busy={busy} disabled={running} />
      )}
      {chosen && (
        <Selected req={req} step={step} busy={busy} disabled={running} />
      )}
      {chosen &&
        req.availability &&
        req.case_type !== "CANCELLATION_REQUEST" && (
          <details className="disclosure slots__other">
            <summary>
              Choose a different slot ({req.availability.slots.length} found)
              <Icon name="chevron" size={18} className="disclosure__caret" />
            </summary>
            <Availability
              req={req}
              step={step}
              busy={busy}
              disabled={running}
            />
          </details>
        )}
      {w === "CANCELLATION_REQUESTED" && original && (
        <Commit
          label="Cancel this appointment"
          question={`Cancel the appointment on ${slotTime(original.starts_at, original.timezone)}? The destination system will be asked to cancel it.`}
          confirm="Confirm cancellation"
          busy={busy === "commit"}
          disabled={running}
          danger
          onConfirm={() => step("commit")}
        />
      )}
      <Recovery
        req={req}
        step={step}
        busy={busy}
        exception={exception}
        bothMayExist={bothMayExist}
        current={current}
      />
      <div className="booking__secondary">
        {[
          "AVAILABILITY_REQUESTED",
          "AVAILABILITY_RETURNED",
          "NO_AVAILABILITY",
          "SLOT_SELECTED",
          "HELD",
        ].includes(w) &&
          req.case_type !== "CANCELLATION_REQUEST" && (
            <SearchAgain req={req} step={step} busy={busy} disabled={running} />
          )}
        {[
          "AVAILABILITY_REQUESTED",
          "AVAILABILITY_RETURNED",
          "NO_AVAILABILITY",
          "SLOT_SELECTED",
          "HELD",
          "CANCELLATION_REQUESTED",
        ].includes(w) && (
          <Withdraw step={step} busy={busy} caseType={req.case_type} />
        )}
      </div>
    </div>
  );
}

/** Slots as the destination returned them, grouped by local day. */
function Availability({
  req,
  step,
  busy,
  disabled,
}: {
  req: AppointmentRequestView;
  step: StepFn;
  busy: string | null;
  disabled: boolean;
}) {
  const a = req.availability!;
  const name = useId();
  const [choice, setChoice] = useState(req.selected_slot?.slot_reference ?? "");
  useEffect(
    () => setChoice(req.selected_slot?.slot_reference ?? ""),
    [req.selected_slot?.slot_reference],
  );
  const days = new Map<string, Slot[]>();
  for (const s of a.slots) {
    const day = slotDay(s.start_at, s.timezone);
    days.set(day, [...(days.get(day) ?? []), s]);
  }
  const changed = choice && choice !== req.selected_slot?.slot_reference;
  const zones = [...new Set(a.slots.map((s) => s.timezone))];
  const oneZone = zones.length === 1 ? zones[0] : null;
  return (
    <fieldset className="slots">
      <legend className="slots__legend">
        <span className="section-title">Available appointments</span>
        <span className={`slots__fresh${a.fresh ? "" : " is-stale"}`}>
          {a.fresh
            ? `Found ${stamp(a.observed_at)}. Not reserved until held or booked.`
            : `Found ${stamp(a.observed_at)}: out of date. Search again before choosing.`}
          {oneZone && ` Times are in ${oneZone}.`}
        </span>
      </legend>
      {a.slots.length === 0 ? (
        <p className="muted">No appointments left in this search.</p>
      ) : (
        [...days.entries()].map(([day, slots], d) => (
          <div
            className="slots__day"
            key={day}
            role="group"
            aria-labelledby={`${name}-day-${d}`}
          >
            <p className="slots__date" id={`${name}-day-${d}`}>
              {day}
            </p>
            <div className="slots__grid">
              {slots.map((s) => (
                <label
                  key={s.slot_reference}
                  className={`slot${choice === s.slot_reference ? " is-chosen" : ""}`}
                >
                  <input
                    type="radio"
                    name={name}
                    value={s.slot_reference}
                    checked={choice === s.slot_reference}
                    disabled={!a.fresh || disabled}
                    onChange={() => setChoice(s.slot_reference)}
                  />
                  <span className="slot__time">
                    {clock(s.start_at, s.timezone)}
                  </span>
                  <span className="slot__meta">
                    {Math.round(
                      (Date.parse(s.end_at) - Date.parse(s.start_at)) / 60000,
                    )}{" "}
                    min · {s.provider_reference ?? "Any provider"}
                  </span>
                  {s.location_reference && (
                    <span className="slot__meta">{s.location_reference}</span>
                  )}
                  {!oneZone && <span className="slot__zone">{s.timezone}</span>}
                  {!s.hold_supported && (
                    <span className="slot__nohold">Cannot be held</span>
                  )}
                </label>
              ))}
            </div>
          </div>
        ))
      )}
      {changed && (
        <div className="slots__submit">
          <button
            type="button"
            className="btn"
            disabled={!a.fresh || disabled || busy !== null}
            onClick={() => step("select", { slot_reference: choice })}
          >
            {busy === "select" ? "Selecting…" : "Select this slot"}
          </button>
          {req.workflow_status === "HELD" && (
            <span className="muted small">
              The current hold is let go when you choose another slot.
            </span>
          )}
        </div>
      )}
    </fieldset>
  );
}

/** The chosen slot: hold it (optional) and book it. */
function Selected({
  req,
  step,
  busy,
  disabled,
}: {
  req: AppointmentRequestView;
  step: StepFn;
  busy: string | null;
  disabled: boolean;
}) {
  const s = req.selected_slot!;
  const held = req.workflow_status === "HELD" && req.hold?.status === "ACTIVE";
  const now = useNow(held);
  const left = held ? new Date(req.hold!.expires_at).getTime() - now : 0;
  const usable = held && left > HOLD_MARGIN_MS;
  const reschedule = req.case_type === "RESCHEDULING_REQUEST";
  const place = [s.provider_reference, s.location_reference]
    .filter(Boolean)
    .join(" at ");
  return (
    <div className="selected">
      <div className="selected__slot">
        <p className="caps">Selected</p>
        <p className="selected__time">
          {slotTime(s.start_at, s.timezone, s.end_at)}
        </p>
        <p className="muted small">
          {place || "Any provider"} · {s.timezone}
        </p>
      </div>
      {held && <HoldTimer expiresAt={req.hold!.expires_at} left={left} />}
      <div className="selected__actions">
        {!held && s.hold_supported && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={disabled || busy !== null || !req.availability?.fresh}
            onClick={() => step("hold")}
          >
            {busy === "hold" ? "Holding…" : "Hold this slot"}
          </button>
        )}
        <Commit
          label={reschedule ? "Book as the new appointment" : "Book this slot"}
          question={`${reschedule ? "Book the new appointment for" : "Book"} ${slotTime(s.start_at, s.timezone)}${place ? ` with ${place}` : ""}? ${reschedule ? "The original is cancelled only after the new one is checked in the destination system." : "This creates the appointment in the destination system."}`}
          confirm={reschedule ? "Confirm new booking" : "Confirm booking"}
          busy={busy === "commit"}
          disabled={
            disabled ||
            busy !== null ||
            (held ? !usable : !req.availability?.fresh)
          }
          onConfirm={() => step("commit")}
        />
      </div>
      {held && !usable && (
        <p className="booking-situation booking-situation--attention">
          <span>
            Too little time is left on this hold to book against it. Hold the
            slot again or choose another.
          </span>
        </p>
      )}
    </div>
  );
}

/** Wall-clock time in the appointment's own zone. */
function clock(at: string, timezone: string): string {
  return new Intl.DateTimeFormat([], {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** The hold's expiry, counted down. Announced only at thresholds. */
function HoldTimer({ expiresAt, left }: { expiresAt: string; left: number }) {
  const seconds = Math.max(0, Math.floor(left / 1000));
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const phase =
    seconds === 0
      ? "The hold has expired."
      : seconds <= 15
        ? "Less than 15 seconds left on the hold."
        : seconds <= 60
          ? "Less than a minute left on the hold."
          : "";
  return (
    <div
      className={`hold${seconds <= 60 ? " hold--short" : ""}${seconds === 0 ? " hold--over" : ""}`}
    >
      <Icon name="lock" size={16} />
      <span>
        Held until{" "}
        <time dateTime={expiresAt}>
          {new Date(expiresAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </time>
      </span>
      <span className="hold__left num" aria-hidden>
        {text} left
      </span>
      <span className="vh" aria-live="polite">
        {phase}
      </span>
    </div>
  );
}

/** A consequential step asks once more, in words, before it is sent. */
function Commit(p: {
  label: string;
  question: string;
  confirm: string;
  busy: boolean;
  disabled: boolean;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // The button that asked is gone: keep keyboard focus on the question.
  useEffect(() => {
    if (asking) confirmRef.current?.focus();
  }, [asking]);
  if (!asking)
    return (
      <button
        type="button"
        className={`btn${p.danger ? " btn-danger" : ""}`}
        disabled={p.disabled}
        onClick={() => setAsking(true)}
      >
        {p.label}
      </button>
    );
  return (
    <div className="confirm" role="group" aria-label={p.label}>
      <p>{p.question}</p>
      <div className="confirm__buttons">
        <button
          type="button"
          className={`btn${p.danger ? " btn-danger" : ""}`}
          disabled={p.busy}
          onClick={p.onConfirm}
          ref={confirmRef}
        >
          {p.busy ? "Sending…" : p.confirm}
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => setAsking(false)}
        >
          Back
        </button>
      </div>
    </div>
  );
}

/** Recovery after the destination could not confirm, or refused. */
function Recovery({
  req,
  step,
  busy,
  exception,
  bothMayExist,
  current,
}: {
  req: AppointmentRequestView;
  step: StepFn;
  busy: string | null;
  exception: boolean;
  bothMayExist: boolean;
  current: AppointmentView | undefined;
}) {
  const [attesting, setAttesting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);
  const noteId = useId();
  const unknown = unconfirmed(req);
  const unverified =
    exception &&
    ["COMMITTED", "REPLACEMENT_BOOKED"].includes(req.workflow_status) &&
    !req.pending_execution;
  const cancelRefused = bothMayExist && !stepRunning(req) && !unknown;
  if (!unknown && !unverified && !bothMayExist) return null;
  const attest = (action: string) => {
    setAttesting(attesting === action ? null : action);
    setNote("");
    setChecked(false);
  };
  return (
    <div className="recovery">
      <div className="recovery__buttons">
        {(unknown || unverified) && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy !== null}
            onClick={() => step("recheck")}
          >
            {busy === "recheck" ? "Asking…" : "Check again"}
          </button>
        )}
        {unknown && (
          <button
            type="button"
            className="btn btn-quiet"
            aria-expanded={attesting === "attest_not_committed"}
            onClick={() => attest("attest_not_committed")}
          >
            It is not in the destination system
          </button>
        )}
        {bothMayExist && cancelRefused && !req.pending_execution && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy !== null}
            onClick={() => step("commit")}
          >
            {busy === "commit" ? "Sending…" : "Cancel the original again"}
          </button>
        )}
        {bothMayExist && (
          <button
            type="button"
            className="btn btn-quiet"
            aria-expanded={attesting === "attest_original_cancelled"}
            onClick={() => attest("attest_original_cancelled")}
          >
            The original is cancelled
          </button>
        )}
      </div>
      {attesting && (
        <form
          className="action-form"
          onSubmit={(e) => {
            e.preventDefault();
            void step(attesting, { note }, () => setAttesting(null));
          }}
        >
          <p className="action-form__title">
            {attesting === "attest_not_committed"
              ? "Confirm it is not in the destination system"
              : "Confirm the original appointment is cancelled"}
          </p>
          <label className="check check--attest">
            <input
              type="checkbox"
              required
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            {attesting === "attest_not_committed"
              ? `I checked the destination system and this ${current ? "appointment" : "request"} is NOT there.`
              : "I checked the destination system and the original appointment is cancelled there."}
          </label>
          <div className="field">
            <label htmlFor={noteId}>What you checked (required)</label>
            <textarea
              id={noteId}
              required
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="action-form__submit">
            <button className="btn" disabled={busy !== null || !checked}>
              {busy ? "Saving…" : "Confirm"}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setAttesting(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function SearchAgain({
  req,
  step,
  busy,
  disabled,
}: {
  req: AppointmentRequestView;
  step: StepFn;
  busy: string | null;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState(() =>
    searchWindowFields(req.search?.timezone ?? req.timezone),
  );
  return (
    <div className="search-again">
      <div className="booking__row">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled || busy !== null}
          onClick={() => step("search")}
        >
          {busy === "search" ? "Searching…" : "Search again"}
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Change the search
        </button>
      </div>
      {open && (
        <form
          className="action-form"
          onSubmit={(e) => {
            e.preventDefault();
            void step("search", { search: searchFrom(range) }, () =>
              setOpen(false),
            );
          }}
        >
          <SearchFields value={range} onChange={setRange} />
          <div className="action-form__submit">
            <button className="btn" disabled={busy !== null}>
              Search
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Withdraw({
  step,
  busy,
  caseType,
}: {
  step: StepFn;
  busy: string | null;
  caseType: string;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const id = useId();
  return (
    <div className="withdraw">
      <button
        type="button"
        className="btn btn-quiet"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {caseType === "APPOINTMENT_REQUEST"
          ? "Withdraw this booking"
          : "Withdraw this request"}
      </button>
      {open && (
        <form
          className="action-form"
          onSubmit={(e) => {
            e.preventDefault();
            void step("withdraw", { note }, () => setOpen(false));
          }}
        >
          <p className="muted small">
            {caseType === "APPOINTMENT_REQUEST"
              ? "Nothing has been booked. The referral goes back to Ready for booking."
              : "The appointment stays as it is."}
          </p>
          <div className="field">
            <label htmlFor={id}>Reason (required)</label>
            <textarea
              id={id}
              required
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="action-form__submit">
            <button className="btn" disabled={busy !== null}>
              {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export function AppointmentCard({
  appointment: a,
  title,
  checking = false,
}: {
  appointment: AppointmentView;
  title: string;
  checking?: boolean;
}) {
  const place = [a.provider_reference, a.location_reference]
    .filter(Boolean)
    .join(" at ");
  const status =
    a.status === "BOOKED"
      ? checking
        ? "Booked, being checked"
        : a.confirmation_status === "CONFIRMED"
          ? "Confirmed with the patient"
          : "Booked, not yet confirmed with the patient"
      : a.status === "SUPERSEDED"
        ? "Replaced by a new appointment"
        : "Cancelled";
  return (
    <div className={`appointment appointment--${a.status.toLowerCase()}`}>
      <p className="caps">{title}</p>
      <p className="appointment__time">
        {slotTime(a.starts_at, a.timezone, a.ends_at)}
      </p>
      <p className="appointment__meta">
        {place || "Any provider"} · {a.timezone}
      </p>
      <p className="appointment__status">
        <span
          className={`appointment__dot appointment__dot--${a.status.toLowerCase()}`}
          aria-hidden
        />
        {status}
      </p>
      <p className="appointment__ref muted small">
        Destination reference{" "}
        <span className="mono">{a.external_reference}</span>
        {a.confirmed_at &&
          ` · confirmed ${stamp(a.confirmed_at)}${a.confirmation_method ? ` (${label(a.confirmation_method)})` : ""}`}
        {a.cancelled_at &&
          ` · ${a.status === "SUPERSEDED" ? "replaced" : "cancelled"} ${stamp(a.cancelled_at)}`}
      </p>
    </div>
  );
}

/** Confirm (coordinators), reschedule or cancel (managers). */
function AppointmentChanges({
  appointment: a,
  onDone,
}: {
  appointment: AppointmentView;
  onDone: () => void;
}) {
  const session = useSession();
  const role = session.me?.role ?? "READ_ONLY";
  const manager = MANAGERS.includes(role);
  const cmd = useCommand(onDone);
  const [open, setOpen] = useState<string | null>(null);
  const [method, setMethod] = useState("PHONE");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("PATIENT_REQUEST");
  const [range, setRange] = useState(() => searchWindowFields(a.timezone));
  const ids = { method: useId(), note: useId(), reason: useId() };
  if (role === "READ_ONLY" || a.status !== "BOOKED") return null;
  const change = (action: string, extra: Record<string, unknown>) =>
    cmd.run(
      action,
      `/v1/appointments/${a.id}/actions`,
      { action, expected_version: a.version, ...extra },
      (result) => {
        setOpen(null);
        if (typeof result.case_id === "string" && result.case_id)
          location.hash = `#/case/${result.case_id}`;
        else onDone();
      },
    );
  const toggle = (name: string) => {
    setOpen(open === name ? null : name);
    setNote("");
  };
  return (
    <div className="appointment-changes">
      <div className="booking__row">
        {a.confirmation_status !== "CONFIRMED" && (
          <button
            type="button"
            className="btn"
            aria-expanded={open === "confirm"}
            onClick={() => toggle("confirm")}
          >
            Record patient confirmation
          </button>
        )}
        {manager && (
          <>
            <button
              type="button"
              className="btn btn-secondary"
              aria-expanded={open === "reschedule"}
              onClick={() => toggle("reschedule")}
            >
              Reschedule
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              aria-expanded={open === "cancel"}
              onClick={() => toggle("cancel")}
            >
              Cancel appointment
            </button>
          </>
        )}
      </div>
      {open && (
        <form
          className="action-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (open === "confirm")
              void change("confirm", { method, ...(note ? { note } : {}) });
            else if (open === "reschedule")
              void change("reschedule", { note, search: searchFrom(range) });
            else void change("cancel", { note, reason });
          }}
        >
          <p className="action-form__title">
            {open === "confirm"
              ? "Record that the patient confirmed"
              : open === "reschedule"
                ? "Find a new appointment"
                : "Request cancellation"}
          </p>
          {open === "confirm" && (
            <div className="field">
              <label htmlFor={ids.method}>How the patient confirmed</label>
              <select
                id={ids.method}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="PHONE">Phone</option>
                <option value="IN_PERSON">In person</option>
                <option value="WRITTEN">Written</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
          )}
          {open === "reschedule" && (
            <>
              <p className="muted small">
                The current appointment stays booked until the new one is booked
                and confirmed by the destination system.
              </p>
              <SearchFields value={range} onChange={setRange} />
            </>
          )}
          {open === "cancel" && (
            <>
              <p className="muted small">
                Nothing is cancelled yet: you confirm the cancellation on the
                next screen.
              </p>
              <div className="field">
                <label htmlFor={ids.reason}>Reason</label>
                <select
                  id={ids.reason}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                >
                  <option value="PATIENT_REQUEST">Patient asked</option>
                  <option value="PROVIDER_REQUEST">Provider asked</option>
                  <option value="DUPLICATE_BOOKING">Duplicate booking</option>
                  <option value="ADMINISTRATIVE">Administrative</option>
                </select>
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor={ids.note}>
              Note{" "}
              {open === "confirm" ? (
                <span className="optional">(optional)</span>
              ) : (
                "(required)"
              )}
            </label>
            <textarea
              id={ids.note}
              required={open !== "confirm"}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="action-form__submit">
            <button className="btn" disabled={cmd.busy !== null}>
              {cmd.busy ? "Saving…" : open === "confirm" ? "Save" : "Continue"}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setOpen(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {cmd.error && (
        <p className="alert" role="alert">
          {cmd.error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Referral case: booking summary and "Start booking"
// ---------------------------------------------------------------------------

const REASONS: Record<string, string> = {
  NOT_READY_FOR_BOOKING: "The referral is not ready for booking yet.",
  SAFETY_REVIEW_OPEN: "A safety review is open.",
  BOOKING_ALREADY_ACTIVE: "A booking is already in progress.",
};
function reasonText(code: string): string {
  if (code.startsWith("BOOKING_PREREQUISITES_UNMET:"))
    return `Booking prerequisites are missing: ${code
      .split(":")[1]!
      .split(",")
      .map((x) => label(x))
      .join(", ")}.`;
  return REASONS[code] ?? label(code);
}

export function ReferralBooking({
  view,
  onDone,
}: {
  view: CaseView;
  onDone: () => void;
}) {
  const session = useSession();
  const role = session.me?.role ?? "READ_ONLY";
  const active = view.appointment_requests.find(
    (r) =>
      !["BOOKED", "COMPLETED", "CANCELLED", "WITHDRAWN"].includes(
        r.workflow_status,
      ),
  );
  const current = view.appointments.filter((a) => a.status === "BOOKED");
  const past = view.appointments.filter((a) => a.status !== "BOOKED");
  const eligible = view.booking?.eligible ?? false;
  const resolved = ["BOOKED", "CLOSED", "REJECTED"].includes(
    view.case.current_state,
  );
  const review = view.work_items.some(
    (w) => w.kind === "OUTCOME_REVIEW" && w.status === "OPEN",
  );
  const show =
    eligible ||
    active ||
    view.appointments.length > 0 ||
    ["READY_FOR_BOOKING", "WAITING"].includes(view.case.current_state);
  if (!show) return null;
  return (
    <section
      className="panel booking booking--referral"
      aria-labelledby="referral-booking-title"
    >
      <div className="booking__head">
        <div>
          <p className="caps">Booking</p>
          <h2 className="section-title" id="referral-booking-title">
            {view.access_status?.label ?? "Booking"}
          </h2>
        </div>
      </div>
      {active && (
        <p className="booking-situation booking-situation--info">
          <span>
            {CASE_TYPE_LABELS[active.case_type]} in progress:{" "}
            {WORKFLOW_LABELS[active.workflow_status]}.{" "}
            <a href={`#/case/${active.case_id}`}>Open {active.display_ref}</a>
          </span>
        </p>
      )}
      {current.map((a) => (
        <div key={a.id} className="booking__appointment">
          <AppointmentCard appointment={a} title="Appointment" />
          {!active && <AppointmentChanges appointment={a} onDone={onDone} />}
        </div>
      ))}
      {!active && eligible && role !== "READ_ONLY" && (
        <StartBooking view={view} onDone={onDone} />
      )}
      {!active &&
        !eligible &&
        current.length === 0 &&
        view.booking &&
        (resolved ? (
          past.length > 0 && (
            <p className="muted">
              The appointment was cancelled.{" "}
              {review
                ? "A practice manager reviews the referral's outcome."
                : "Booking again needs a new referral in this version."}
            </p>
          )
        ) : (
          <ul className="booking__reasons">
            {view.booking.reasons.map((r) => (
              <li key={r}>{reasonText(r)}</li>
            ))}
          </ul>
        ))}
      {past.length > 0 && (
        <details className="disclosure booking__past">
          <summary>
            Earlier appointments ({past.length})
            <Icon name="chevron" size={18} className="disclosure__caret" />
          </summary>
          {past.map((a) => (
            <AppointmentCard
              key={a.id}
              appointment={a}
              title={a.status === "SUPERSEDED" ? "Replaced" : "Cancelled"}
            />
          ))}
        </details>
      )}
      {view.appointment_requests.length > 0 && (
        <details className="disclosure booking__past">
          <summary>
            Booking requests ({view.appointment_requests.length})
            <Icon name="chevron" size={18} className="disclosure__caret" />
          </summary>
          <ul className="booking__requests">
            {view.appointment_requests.map((r) => (
              <li key={r.case_id}>
                <a href={`#/case/${r.case_id}`} className="mono">
                  {r.display_ref}
                </a>
                <span>
                  {CASE_TYPE_LABELS[r.case_type]} ·{" "}
                  {WORKFLOW_LABELS[r.workflow_status]}
                </span>
                <span className="muted small">{when(r.created_at)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function StartBooking({
  view,
  onDone,
}: {
  view: CaseView;
  onDone: () => void;
}) {
  const cmd = useCommand(onDone);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [range, setRange] = useState(() => searchWindowFields());
  const id = useId();
  return (
    <div className="start-booking">
      <button
        type="button"
        className="btn"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Start booking
      </button>
      {open && (
        <form
          className="action-form"
          onSubmit={(e) => {
            e.preventDefault();
            void cmd.run(
              "start_booking",
              `/v1/cases/${view.case.id}/actions`,
              {
                action: "start_booking",
                expected_version: view.case.version,
                note,
                search: searchFrom(range),
              },
              (result) => {
                if (typeof result.appointment_case_id === "string")
                  location.hash = `#/case/${result.appointment_case_id}`;
                else onDone();
              },
            );
          }}
        >
          <p className="action-form__title">Search for an appointment</p>
          <p className="muted small">
            ACCESS asks the destination system for free appointments. Nothing is
            reserved or booked until you choose.
          </p>
          <SearchFields value={range} onChange={setRange} />
          <div className="field">
            <label htmlFor={id}>Note (required)</label>
            <textarea
              id={id}
              required
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="action-form__submit">
            <button className="btn" disabled={cmd.busy !== null}>
              {cmd.busy ? "Starting…" : "Search"}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {cmd.error && (
        <p className="alert" role="alert">
          {cmd.error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search window
// ---------------------------------------------------------------------------

interface WindowFields {
  from: string;
  days: string;
  timezone: string;
}
function searchWindowFields(timezone?: string): WindowFields {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const local = new Date(
    tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60_000,
  );
  return {
    from: local.toISOString().slice(0, 10),
    days: "14",
    timezone:
      timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  };
}
/** Search from the start of the chosen day, for N days (the API allows 62). */
function searchFrom(w: WindowFields) {
  const from = new Date(`${w.from}T00:00:00`);
  const start = Math.max(from.getTime(), Date.now());
  const to = from.getTime() + Number(w.days) * 86_400_000;
  return {
    from: new Date(start).toISOString(),
    to: new Date(to).toISOString(),
    timezone: w.timezone,
  };
}
function SearchFields({
  value,
  onChange,
}: {
  value: WindowFields;
  onChange: (w: WindowFields) => void;
}) {
  const ids = { from: useId(), days: useId(), zone: useId() };
  return (
    <div className="action-form__row">
      <div className="field">
        <label htmlFor={ids.from}>From</label>
        <input
          id={ids.from}
          type="date"
          required
          value={value.from}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={ids.days}>For</label>
        <select
          id={ids.days}
          value={value.days}
          onChange={(e) => onChange({ ...value, days: e.target.value })}
        >
          <option value="7">1 week</option>
          <option value="14">2 weeks</option>
          <option value="28">4 weeks</option>
          <option value="56">8 weeks</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={ids.zone}>Time zone of the appointment</label>
        <input
          id={ids.zone}
          required
          value={value.timezone}
          onChange={(e) => onChange({ ...value, timezone: e.target.value })}
        />
      </div>
    </div>
  );
}
