import React, { useState } from "react";
import { Icon } from "../../components/Icon";
import { label } from "../../format";
import { PageHeader } from "../../layout/PageHeader";
import { usePractice } from "../context";
import { useLink, type ViewProps } from "../PracticeApp";
import {
  atMinute,
  fmt,
  parseClock,
  shiftDate,
  todayIn,
  WEEKDAYS,
} from "../time";
import type { PatientSummary, Referral, WaitlistEntry } from "../types";
import {
  ConfirmButton,
  Dialog,
  Empty,
  ErrorNote,
  Loading,
  PatientPicker,
  Tone,
  useAction,
  useLoad,
} from "../ui";

/**
 * Put a patient on the waitlist for an appointment type, with the dates,
 * days and hours they can come. Priority is administrative (for example a
 * patient already waiting a long time), never a clinical judgement.
 */
export function AddToWaitlistDialog({
  patient: initialPatient,
  typeId: initialType = "",
  onClose,
  onAdded,
}: {
  patient?: PatientSummary | null;
  typeId?: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const practice = usePractice();
  const tz = practice.tz;
  const action = useAction();
  const [patient, setPatient] = useState<PatientSummary | null>(
    initialPatient ?? null,
  );
  const [typeId, setTypeId] = useState(initialType);
  const [practitionerId, setPractitionerId] = useState("");
  const [earliest, setEarliest] = useState(todayIn(tz));
  const [latest, setLatest] = useState(shiftDate(todayIn(tz), 30));
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [priority, setPriority] = useState(false);
  const [referralId, setReferralId] = useState("");
  const type = practice.type(typeId);
  const referrals = useLoad(
    async () =>
      patient && type?.requires_referral && practice.can("referral.read")
        ? (
            await practice.client.get<{ items: Referral[] }>("/referrals", {
              patient_id: patient.id,
              limit: 50,
            })
          ).items.filter(
            (r) =>
              (r.status === "RECEIVED" || r.status === "VERIFIED") &&
              (!r.appointment_type || r.appointment_type.id === typeId),
          )
        : [],
    [patient?.id, typeId],
  );
  return (
    <Dialog title="Add to waitlist" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const start = from ? parseClock(from) : null;
          const end = until ? parseClock(until) : null;
          void action
            .run(() =>
              practice.client.send("POST", "/waitlist", {
                patient_id: patient!.id,
                appointment_type_id: typeId,
                practitioner_id: practitionerId || null,
                earliest_date: earliest,
                latest_date: latest,
                preferred_weekdays: weekdays,
                preferred_start_minute: start,
                preferred_end_minute: end,
                priority: priority ? 1 : 0,
                referral_id: referralId || null,
                channel: "PHONE",
              }),
            )
            .then((ok) => {
              if (ok) {
                practice.changed();
                onAdded();
              }
            });
        }}
      >
        <div className="field">
          <span className="label">Patient</span>
          {patient ? (
            <p>
              <strong>{patient.display_name}</strong>{" "}
              <span className="mono muted">{patient.patient_number}</span>{" "}
              {!initialPatient && (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => setPatient(null)}
                >
                  Change
                </button>
              )}
            </p>
          ) : (
            <PatientPicker onPick={setPatient} />
          )}
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="wl-type">Appointment type</label>
            <select
              id="wl-type"
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              required
            >
              <option value="">Choose…</option>
              {practice.data.appointment_types
                .filter((t) => t.active)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="wl-practitioner">Practitioner</label>
            <select
              id="wl-practitioner"
              value={practitionerId}
              onChange={(e) => setPractitionerId(e.target.value)}
            >
              <option value="">Anyone who offers it</option>
              {practice.data.practitioners
                .filter(
                  (p) =>
                    p.active && (!type || type.practitioner_ids.includes(p.id)),
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        {type?.requires_referral && (
          <div className="field">
            <label htmlFor="wl-referral">Referral</label>
            <select
              id="wl-referral"
              value={referralId}
              onChange={(e) => setReferralId(e.target.value)}
              required
            >
              <option value="">Choose…</option>
              {(referrals.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.referring_practitioner_name} · {label(r.status)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="form-row">
          <div className="field">
            <label htmlFor="wl-earliest">Available from</label>
            <input
              id="wl-earliest"
              type="date"
              value={earliest}
              onChange={(e) => setEarliest(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="wl-latest">Until</label>
            <input
              id="wl-latest"
              type="date"
              value={latest}
              min={earliest}
              onChange={(e) => setLatest(e.target.value)}
              required
            />
          </div>
        </div>
        <fieldset className="field">
          <legend className="label">
            Days the patient can come (none ticked: any day)
          </legend>
          <div className="weekday-picks">
            {WEEKDAYS.map((d, i) => (
              <label key={d} className="check">
                <input
                  type="checkbox"
                  checked={weekdays.includes(i + 1)}
                  onChange={(e) =>
                    setWeekdays(
                      e.target.checked
                        ? [...weekdays, i + 1]
                        : weekdays.filter((w) => w !== i + 1),
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
            <label htmlFor="wl-from">
              Earliest start <span className="optional">(optional)</span>
            </label>
            <input
              id="wl-from"
              type="time"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="wl-until">
              Latest start <span className="optional">(optional)</span>
            </label>
            <input
              id="wl-until"
              type="time"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={priority}
            onChange={(e) => setPriority(e.target.checked)}
          />
          Raise priority (administrative only, e.g. already waiting long)
        </label>
        <ErrorNote error={action.error} />
        <div className="form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={!patient || !typeId || action.busy}>
            Add to waitlist
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AnnounceSlotDialog({ onClose }: { onClose: () => void }) {
  const practice = usePractice();
  const tz = practice.tz;
  const action = useAction();
  const active = practice.data.practitioners.filter((p) => p.active);
  const [practitionerId, setPractitionerId] = useState(active[0]?.id ?? "");
  const practitioner = practice.practitioner(practitionerId);
  const [locationId, setLocationId] = useState(
    practitioner?.location_ids[0] ?? "",
  );
  const [day, setDay] = useState(todayIn(tz));
  const [time, setTime] = useState("10:00");
  const [sent, setSent] = useState(false);
  return (
    <Dialog title="Offer a free time to the waitlist" onClose={onClose}>
      {sent ? (
        <>
          <p className="note">
            The waitlist will offer this time to the first matching patient who
            can be reached. Their offer appears here once it is made.
          </p>
          <div className="form__actions">
            <button type="button" className="btn" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            const minute = parseClock(time);
            if (minute === null)
              return action.setError("Enter the time as HH:MM.");
            void action
              .run(() =>
                practice.client.send("POST", "/waitlist/announce-slot", {
                  practitioner_id: practitionerId,
                  location_id: locationId,
                  start: atMinute(day, minute, tz),
                }),
              )
              .then((ok) => ok && setSent(true));
          }}
        >
          <p className="field-hint">
            Use this when you free time outside a cancellation (for example
            after removing a block). Cancellations are offered automatically.
          </p>
          <div className="form-row">
            <div className="field">
              <label htmlFor="ann-who">Practitioner</label>
              <select
                id="ann-who"
                value={practitionerId}
                onChange={(e) => {
                  setPractitionerId(e.target.value);
                  setLocationId(
                    practice.practitioner(e.target.value)?.location_ids[0] ??
                      "",
                  );
                }}
              >
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ann-where">Location</label>
              <select
                id="ann-where"
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
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor="ann-day">Date</label>
              <input
                id="ann-day"
                type="date"
                value={day}
                min={todayIn(tz)}
                onChange={(e) => setDay(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="ann-time">Start</label>
              <input
                id="ann-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </div>
          </div>
          <ErrorNote error={action.error} />
          <div className="form__actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
            >
              Close
            </button>
            <button className="btn" disabled={action.busy || !locationId}>
              Offer to the waitlist
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

const STATUS_TONE: Record<
  WaitlistEntry["status"],
  "progress" | "attention" | "booked" | "closed"
> = {
  ACTIVE: "progress",
  OFFERED: "attention",
  BOOKED: "booked",
  CANCELLED: "closed",
  EXPIRED: "closed",
};

export function Waitlist({ route }: ViewProps) {
  const practice = usePractice();
  const link = useLink();
  const [status, setStatus] = useState(route.query.get("status") ?? "");
  const [typeId, setTypeId] = useState("");
  const [adding, setAdding] = useState(false);
  const [announcing, setAnnouncing] = useState(false);
  const list = useLoad(
    () =>
      practice.client.get<{ items: WaitlistEntry[] }>("/waitlist", {
        status: status || undefined,
        appointment_type_id: typeId || undefined,
        limit: 200,
      }),
    [status, typeId, practice.tick],
  );
  const action = useAction();
  const manage = practice.can("waitlist.manage");
  const answer = (entry: WaitlistEntry, accept: boolean) =>
    void action.run(async () => {
      await practice.client.send(
        "POST",
        `/waitlist-offers/${entry.pending_offer!.id}/${accept ? "accept" : "decline"}`,
        {
          channel: "PHONE",
        },
      );
      practice.changed();
    });
  return (
    <>
      <PageHeader
        title="Waitlist"
        context="Patients waiting for a time. Freed times are offered in queue order; nothing is booked without the patient's answer."
        actions={
          manage && (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setAnnouncing(true)}
              >
                Offer a free time
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setAdding(true)}
              >
                <Icon name="plus" size={18} />
                Add patient
              </button>
            </>
          )
        }
      >
        <div className="toolbar">
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Waiting and offered</option>
            <option value="OFFERED">Offer pending</option>
            <option value="BOOKED">Booked from the waitlist</option>
            <option value="CANCELLED">Removed</option>
            <option value="EXPIRED">Expired</option>
          </select>
          <select
            aria-label="Appointment type"
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
          >
            <option value="">All types</option>
            {practice.data.appointment_types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </PageHeader>
      <ErrorNote error={list.error || action.error} />
      {!list.data && !list.error && <Loading what="the waitlist" />}
      {list.data && !list.data.items.length && (
        <Empty title="Nobody is waiting" />
      )}
      {list.data && list.data.items.length > 0 && (
        <div
          className={`panel table-wrap${list.loading ? " is-refreshing" : ""}`}
        >
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Patient</th>
                <th scope="col">For</th>
                <th scope="col">Can come</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="vh">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((w) => (
                <tr key={w.id}>
                  <td>
                    <a href={link("patient", w.patient.id)}>
                      {w.patient.display_name}
                    </a>{" "}
                    <span className="mono muted small">
                      {w.patient.patient_number}
                    </span>
                    {w.priority > 0 && (
                      <>
                        {" "}
                        <Tone tone="attention">Priority</Tone>
                      </>
                    )}
                  </td>
                  <td>
                    {w.appointment_type.name}
                    {w.practitioner && (
                      <span className="muted small">
                        {" "}
                        · {w.practitioner.display_name}
                      </span>
                    )}
                  </td>
                  <td className="small">
                    {fmt.shortDate(w.earliest_date)} –{" "}
                    {fmt.shortDate(w.latest_date)}
                    {w.preferred_weekdays.length > 0 && (
                      <span className="muted">
                        {" "}
                        ·{" "}
                        {w.preferred_weekdays
                          .map((d) => WEEKDAYS[d - 1]!.slice(0, 3))
                          .join(", ")}
                      </span>
                    )}
                    {(w.preferred_start_minute !== null ||
                      w.preferred_end_minute !== null) && (
                      <span className="muted">
                        {" "}
                        ·{" "}
                        {w.preferred_start_minute !== null
                          ? fmt.minute(w.preferred_start_minute)
                          : "any"}
                        –
                        {w.preferred_end_minute !== null
                          ? fmt.minute(w.preferred_end_minute)
                          : "any"}
                      </span>
                    )}
                  </td>
                  <td>
                    <Tone tone={STATUS_TONE[w.status]}>{label(w.status)}</Tone>
                    {w.pending_offer && (
                      <span className="small muted">
                        {" "}
                        {fmt.when(w.pending_offer.starts_at, practice.tz)}{" "}
                        offered, answer by{" "}
                        {fmt.time(w.pending_offer.expires_at, practice.tz)}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="button-row button-row--compact">
                      {w.pending_offer && practice.can("appointment.book") && (
                        <button
                          type="button"
                          className="btn"
                          disabled={action.busy}
                          onClick={() => answer(w, true)}
                        >
                          Book it
                        </button>
                      )}
                      {w.pending_offer && manage && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={action.busy}
                          onClick={() => answer(w, false)}
                        >
                          Declined
                        </button>
                      )}
                      {manage &&
                        (w.status === "ACTIVE" || w.status === "OFFERED") && (
                          <ConfirmButton
                            label="Remove"
                            question="Take off the waitlist?"
                            disabled={action.busy}
                            onConfirm={() =>
                              void action.run(async () => {
                                await practice.client.send(
                                  "POST",
                                  `/waitlist/${w.id}/cancel`,
                                  { expected_version: w.version },
                                );
                                practice.changed();
                              })
                            }
                          />
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <AddToWaitlistDialog
          onClose={() => setAdding(false)}
          onAdded={() => setAdding(false)}
        />
      )}
      {announcing && (
        <AnnounceSlotDialog onClose={() => setAnnouncing(false)} />
      )}
    </>
  );
}
