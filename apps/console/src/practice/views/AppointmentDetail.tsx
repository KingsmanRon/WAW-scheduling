import React, { useState } from "react";
import { Icon } from "../../components/Icon";
import { label } from "../../format";
import { PageHeader } from "../../layout/PageHeader";
import { usePractice } from "../context";
import { useLink, type ViewProps } from "../PracticeApp";
import { dt, fmt, todayIn } from "../time";
import {
  CHANNEL_LABELS,
  type Appointment,
  type AppointmentEvent,
  type AuditEvent,
  type Channel,
  type Delivery,
  type Slot,
} from "../types";
import {
  ChannelSelect,
  ConfirmButton,
  Dialog,
  Empty,
  ErrorNote,
  Loading,
  SlotPicker,
  StatusBadge,
  useAction,
  useLoad,
} from "../ui";
import { deliveryStatus } from "./Notifications";

type Action = ReturnType<typeof useAction>;

/**
 * The arrival and consultation steps a status allows, for the operator's
 * role. The Scheduling Core enforces the same rules (and the timing: check
 * in on the day, no-show only after the start); this only avoids offering
 * what would be refused.
 */
export function LifecycleButtons({
  appointment: a,
  action,
  compact = false,
}: {
  appointment: Appointment;
  action: Action;
  compact?: boolean;
}) {
  const practice = usePractice();
  const today = todayIn(a.timezone) === dt(a.starts_at, a.timezone).toISODate();
  const started = Date.parse(a.starts_at) <= Date.now();
  const buttons: {
    path: string;
    text: string;
    can: boolean;
    primary?: boolean;
  }[] = [];
  if (a.status === "CONFIRMED" || a.status === "NO_SHOW")
    buttons.push({
      path: "check-in",
      text: a.status === "NO_SHOW" ? "Arrived late" : "Check in",
      can: today && practice.can("appointment.check_in"),
      primary: true,
    });
  if (a.status === "CHECKED_IN")
    buttons.push({
      path: "start",
      text: "Start",
      can: practice.can("appointment.progress"),
      primary: true,
    });
  if (a.status === "CHECKED_IN" || a.status === "IN_PROGRESS")
    buttons.push({
      path: "complete",
      text: "Complete",
      can: practice.can("appointment.progress"),
      primary: a.status === "IN_PROGRESS",
    });
  if (a.status === "CONFIRMED")
    buttons.push({
      path: "no-show",
      text: "No-show",
      can: started && practice.can("appointment.no_show"),
    });
  const shown = buttons.filter((b) => b.can);
  if (!shown.length) return null;
  const run = (path: string) =>
    void action.run(async () => {
      await practice.client.send("POST", `/appointments/${a.id}/${path}`, {
        expected_version: a.version,
      });
      practice.changed();
    });
  return (
    <div className={`button-row${compact ? " button-row--compact" : ""}`}>
      {shown.map((b) =>
        b.path === "no-show" ? (
          <ConfirmButton
            key={b.path}
            label={b.text}
            question="The patient did not come?"
            confirmLabel="Mark no-show"
            className="btn btn-secondary"
            disabled={action.busy}
            onConfirm={() => run(b.path)}
          />
        ) : (
          <button
            key={b.path}
            type="button"
            className={`btn${b.primary ? "" : " btn-secondary"}`}
            disabled={action.busy}
            onClick={() => run(b.path)}
          >
            {b.text}
          </button>
        ),
      )}
    </div>
  );
}

const EVENT_TEXT: Record<string, string> = {
  HELD: "Held for the patient",
  CONFIRMED: "Booked",
  CHECKED_IN: "Checked in",
  LATE_ARRIVAL: "Arrived after being marked absent",
  STARTED: "Consultation started",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "Marked as no-show",
  RESCHEDULED: "Moved to another time",
  RESCHEDULED_FROM: "Booked as a move from an earlier time",
  EXPIRED: "Hold lapsed",
  HOLD_RELEASED: "Hold released",
  NOTE_UPDATED: "Note updated",
};
export const CANCEL_REASONS = [
  ["PATIENT_REQUEST", "The patient asked to cancel"],
  ["PRACTICE_REQUEST", "The practice cancelled"],
  ["PRACTITIONER_UNAVAILABLE", "The practitioner is unavailable"],
  ["DUPLICATE_BOOKING", "Booked twice by mistake"],
  ["OTHER", "Other"],
] as const;

export function actorText(type: string, id: string, role: string | null) {
  if (type === "SYSTEM") return "System";
  if (type === "PATIENT") return "The patient (self-service)";
  if (type === "INTEGRATION") return "Integration";
  return role ? `Staff · ${label(role)}` : "Staff";
}

export function AppointmentDetail({ route, go }: ViewProps) {
  const practice = usePractice();
  const link = useLink();
  const id = route.id!;
  const appt = useLoad(
    () =>
      practice.client.get<{ appointment: Appointment }>(`/appointments/${id}`),
    [id, practice.tick],
  );
  const history = useLoad(
    () =>
      practice.client.get<{ items: AppointmentEvent[] }>(
        `/appointments/${id}/history`,
      ),
    [id, practice.tick],
  );
  const messages = useLoad(
    async () =>
      practice.can("notification.read")
        ? (
            await practice.client.get<{ items: Delivery[] }>(
              `/appointments/${id}/notifications`,
            )
          ).items
        : null,
    [id, practice.tick],
  );
  const audit = useLoad(
    async () =>
      practice.can("audit.read")
        ? (
            await practice.client.get<{ items: AuditEvent[] }>(
              "/audit-events",
              {
                resource_type: "appointment",
                resource_id: id,
                limit: 50,
              },
            )
          ).items
        : null,
    [id, practice.tick],
  );
  const action = useAction();
  const [dialog, setDialog] = useState<null | "cancel" | "move" | "notes">(
    null,
  );
  if (appt.error && !appt.data) return <ErrorNote error={appt.error} />;
  if (!appt.data) return <Loading what="the appointment" />;
  const a = appt.data.appointment;
  const tz = a.timezone;
  const open = a.status === "CONFIRMED" || a.status === "CHECKED_IN";
  return (
    <>
      <PageHeader
        title={
          <>
            {a.patient.display_name}
            <span className="title-meta"> · {fmt.when(a.starts_at, tz)}</span>
          </>
        }
        context={`${a.appointment_type.name} with ${a.practitioner.display_name} at ${a.location.name}`}
        actions={
          <>
            <StatusBadge status={a.status} />
            <a
              className="btn btn-secondary"
              href={link("calendar", null, {
                date: dt(a.starts_at, tz).toISODate(),
                mode: "day",
              })}
            >
              <Icon name="calendar" size={18} />
              In the calendar
            </a>
          </>
        }
      />
      <div className="detail-grid">
        <section className="panel">
          <div className="panel__head">
            <h2 className="section-title">Appointment</h2>
          </div>
          <div className="panel__body">
            <dl className="facts">
              <dt>When</dt>
              <dd>
                {fmt.when(a.starts_at, tz)}–{fmt.time(a.ends_at, tz)} (
                {a.duration_minutes} min)
              </dd>
              <dt>Patient</dt>
              <dd>
                {practice.can("patient.read") ? (
                  <a href={link("patient", a.patient.id)}>
                    {a.patient.display_name}
                  </a>
                ) : (
                  a.patient.display_name
                )}{" "}
                <span className="mono muted">{a.patient.patient_number}</span>
              </dd>
              <dt>Type</dt>
              <dd>{a.appointment_type.name}</dd>
              <dt>With</dt>
              <dd>
                {a.practitioner.display_name} · {a.location.name}
              </dd>
              <dt>Booked through</dt>
              <dd>
                {CHANNEL_LABELS[a.source_channel]} ·{" "}
                {actorText(
                  a.booked_by.actor_type,
                  a.booked_by.actor_id,
                  a.booked_by.role,
                )}
              </dd>
              {a.referral_id && (
                <>
                  <dt>Referral</dt>
                  <dd>
                    {practice.can("referral.read") ? (
                      <a
                        href={link("referrals", null, { open: a.referral_id })}
                      >
                        View the referral
                      </a>
                    ) : (
                      "Linked"
                    )}
                  </dd>
                </>
              )}
              {a.waitlist_entry_id && (
                <>
                  <dt>From the waitlist</dt>
                  <dd>Yes</dd>
                </>
              )}
              {a.hold && a.status === "HELD" && (
                <>
                  <dt>Held until</dt>
                  <dd>{fmt.time(a.hold.expires_at, tz)}</dd>
                </>
              )}
              {a.cancellation_reason_code && (
                <>
                  <dt>Cancelled</dt>
                  <dd>
                    {label(a.cancellation_reason_code)}
                    {a.cancellation_note && ` · ${a.cancellation_note}`}
                  </dd>
                </>
              )}
              {a.rescheduled_to_id && (
                <>
                  <dt>Moved to</dt>
                  <dd>
                    <a href={link("appointment", a.rescheduled_to_id)}>
                      The new appointment
                    </a>
                  </dd>
                </>
              )}
              {a.rescheduled_from_id && (
                <>
                  <dt>Moved from</dt>
                  <dd>
                    <a href={link("appointment", a.rescheduled_from_id)}>
                      The earlier appointment
                    </a>
                  </dd>
                </>
              )}
              <dt>Administrative note</dt>
              <dd>
                {a.notes ?? <span className="muted">None</span>}
                {practice.can("appointment.notes") &&
                  !["CANCELLED", "RESCHEDULED", "EXPIRED"].includes(
                    a.status,
                  ) && (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => setDialog("notes")}
                    >
                      Edit
                    </button>
                  )}
              </dd>
            </dl>
            <div className="detail-actions">
              <LifecycleButtons appointment={a} action={action} />
              {a.status === "CONFIRMED" &&
                practice.can("appointment.reschedule") && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setDialog("move")}
                  >
                    Reschedule
                  </button>
                )}
              {open && practice.can("appointment.cancel") && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setDialog("cancel")}
                >
                  Cancel appointment
                </button>
              )}
            </div>
            <ErrorNote error={action.error} />
          </div>
        </section>

        <section className="panel">
          <div className="panel__head">
            <h2 className="section-title">History</h2>
          </div>
          <div className="panel__body">
            {history.data ? (
              <ol className="events">
                {history.data.items.map((e) => (
                  <li key={e.id}>
                    <span>
                      {EVENT_TEXT[e.event_type] ?? label(e.event_type)}
                      {e.reason_code && (
                        <span className="muted"> · {label(e.reason_code)}</span>
                      )}
                    </span>
                    <time dateTime={e.occurred_at}>
                      {fmt.when(e.occurred_at, tz)}
                    </time>
                    <small>
                      {actorText(e.actor_type, e.actor_id, e.actor_role)}
                      {e.channel &&
                        e.channel !== "SYSTEM" &&
                        ` · ${label(e.channel)}`}
                    </small>
                  </li>
                ))}
              </ol>
            ) : (
              <Loading what="history" />
            )}
          </div>
        </section>

        {messages.data && (
          <section className="panel">
            <div className="panel__head">
              <h2 className="section-title">Messages to the patient</h2>
            </div>
            <div className="panel__body">
              {messages.data.length ? (
                <ul className="events">
                  {messages.data.map((d) => (
                    <li key={d.id}>
                      <span>
                        {label(d.notification_type)} · {label(d.channel)}
                      </span>
                      <time dateTime={d.created_at}>
                        {fmt.when(d.created_at, practice.tz)}
                      </time>
                      <small>{deliveryStatus(d)}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  No messages planned for this appointment.
                </p>
              )}
            </div>
          </section>
        )}

        {audit.data && (
          <section className="panel">
            <div className="panel__head">
              <h2 className="section-title">Audit trail</h2>
            </div>
            <div className="panel__body">
              {audit.data.length ? (
                <ul className="events">
                  {audit.data.map((e) => (
                    <li key={e.id}>
                      <span className="mono small">{e.action}</span>
                      <time dateTime={e.occurred_at}>
                        {fmt.when(e.occurred_at, practice.tz)}
                      </time>
                      <small>
                        {actorText(e.actor_type, e.actor_id, e.actor_role)}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title="No audit records" />
              )}
            </div>
          </section>
        )}
      </div>

      {dialog === "cancel" && (
        <CancelDialog appointment={a} onClose={() => setDialog(null)} />
      )}
      {dialog === "move" && (
        <RescheduleDialog
          appointment={a}
          onClose={() => setDialog(null)}
          onMoved={(newId) => {
            setDialog(null);
            go(link("appointment", newId));
          }}
        />
      )}
      {dialog === "notes" && (
        <NotesDialog appointment={a} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function CancelDialog({
  appointment: a,
  onClose,
}: {
  appointment: Appointment;
  onClose: () => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [reason, setReason] =
    useState<(typeof CANCEL_REASONS)[number][0]>("PATIENT_REQUEST");
  const [note, setNote] = useState("");
  const [channel, setChannel] = useState<Channel>("PHONE");
  return (
    <Dialog title="Cancel appointment" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void action
            .run(async () => {
              await practice.client.send(
                "POST",
                `/appointments/${a.id}/cancel`,
                {
                  reason_code: reason,
                  note: note.trim() || null,
                  expected_version: a.version,
                  channel,
                },
              );
              practice.changed();
            })
            .then((ok) => ok && onClose());
        }}
      >
        <p>
          {a.patient.display_name}, {fmt.when(a.starts_at, a.timezone)} with{" "}
          {a.practitioner.display_name}. The patient is told if they have agreed
          to messages, and the time is offered to the waitlist.
        </p>
        <fieldset className="field">
          <legend className="label">Reason</legend>
          {CANCEL_REASONS.map(([value, text]) => (
            <label key={value} className="check">
              <input
                type="radio"
                name="reason"
                value={value}
                checked={reason === value}
                onChange={() => setReason(value)}
              />
              {text}
            </label>
          ))}
        </fieldset>
        <ChannelSelect
          id="cancel-channel"
          value={channel}
          onChange={setChannel}
          label="Requested through"
        />
        <div className="field">
          <label htmlFor="cancel-note">
            Note{" "}
            <span className="optional">(optional, administrative only)</span>
          </label>
          <textarea
            id="cancel-note"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <ErrorNote error={action.error} />
        <div className="form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Keep appointment
          </button>
          <button className="btn btn-danger" disabled={action.busy}>
            Cancel appointment
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function RescheduleDialog({
  appointment: a,
  onClose,
  onMoved,
}: {
  appointment: Appointment;
  onClose: () => void;
  onMoved: (id: string) => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [practitionerId, setPractitionerId] = useState(a.practitioner.id);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [channel, setChannel] = useState<Channel>("PHONE");
  const [from] = useState(() => new Date().toISOString());
  const type = practice.type(a.appointment_type.id);
  const allowed = practice.data.practitioners.filter(
    (p) => p.active && (type?.practitioner_ids ?? []).includes(p.id),
  );
  return (
    <Dialog title="Reschedule" onClose={onClose} wide>
      <p className="muted">
        Currently {fmt.when(a.starts_at, a.timezone)} with{" "}
        {a.practitioner.display_name}. The current time stays booked until the
        new one is confirmed.
      </p>
      <div className="form-row">
        <div className="field">
          <label htmlFor="move-practitioner">Practitioner</label>
          <select
            id="move-practitioner"
            value={practitionerId}
            onChange={(e) => {
              setPractitionerId(e.target.value);
              setSlot(null);
            }}
          >
            <option value="">Any who offers {a.appointment_type.name}</option>
            {allowed.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name}
              </option>
            ))}
          </select>
        </div>
        <ChannelSelect
          id="move-channel"
          value={channel}
          onChange={setChannel}
          label="Requested through"
        />
      </div>
      <SlotPicker
        typeId={a.appointment_type.id}
        practitionerId={practitionerId || undefined}
        from={from}
        days={14}
        rescheduleOf={a.id}
        selected={slot}
        onPick={setSlot}
      />
      <ErrorNote error={action.error} />
      <div className="form__actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="btn"
          disabled={!slot || action.busy}
          onClick={() =>
            slot &&
            void action.run(async () => {
              const r = await practice.client.send<{
                appointment: Appointment;
              }>("POST", `/appointments/${a.id}/reschedule`, {
                start: slot.start,
                practitioner_id: slot.practitioner_id,
                location_id: slot.location_id,
                expected_version: a.version,
                channel,
              });
              practice.changed();
              onMoved(r.appointment.id);
            })
          }
        >
          {slot
            ? `Move to ${fmt.when(slot.start, slot.timezone)}`
            : "Choose a new time"}
        </button>
      </div>
    </Dialog>
  );
}

function NotesDialog({
  appointment: a,
  onClose,
}: {
  appointment: Appointment;
  onClose: () => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [notes, setNotes] = useState(a.notes ?? "");
  return (
    <Dialog title="Administrative note" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void action
            .run(async () => {
              await practice.client.send(
                "PATCH",
                `/appointments/${a.id}/notes`,
                {
                  notes: notes.trim() || null,
                  expected_version: a.version,
                },
              );
              practice.changed();
            })
            .then((ok) => ok && onClose());
        }}
      >
        <p className="field-hint">
          For scheduling and reception only (for example, &ldquo;needs
          wheelchair access&rdquo;). Clinical information belongs in the
          clinical record, not here.
        </p>
        <div className="field">
          <label htmlFor="appt-notes">Note</label>
          <textarea
            id="appt-notes"
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <ErrorNote error={action.error} />
        <div className="form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={action.busy}>
            Save note
          </button>
        </div>
      </form>
    </Dialog>
  );
}
