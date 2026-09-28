import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { PageHeader } from "../../layout/PageHeader";
import { errorCode } from "../api";
import { usePractice } from "../context";
import { useLink, type ViewProps } from "../PracticeApp";
import { dt, fmt, startOfDay, todayIn } from "../time";
import {
  CHANNEL_LABELS,
  CHANNELS,
  type Appointment,
  type Channel,
  type Hold,
  type PatientDetail,
  type PatientSummary,
  type Referral,
  type Slot,
} from "../types";
import {
  ChannelSelect,
  ErrorNote,
  PatientPicker,
  SlotPicker,
  Tone,
  useAction,
  useLoad,
} from "../ui";
import { RegisterPatientDialog } from "./Patients";
import { AddToWaitlistDialog } from "./Waitlist";

function useCountdown(until: string | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.floor((Date.parse(until) - now) / 1000)) : 0;
}

/**
 * Booking for phone calls, walk-ins and every other channel staff handle:
 * find (or register) the patient, choose the appointment type (and the
 * referral it needs), pick one of the times the Scheduling Core offers, hold
 * it while the details are confirmed with the patient, then confirm. The
 * channel records how the request reached the practice; the signed-in
 * staff member is recorded as the one who booked it.
 */
export function Book({ route, go }: ViewProps) {
  const practice = usePractice();
  const link = useLink();
  const tz = practice.tz;
  const q = route.query;
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [registering, setRegistering] = useState(false);
  const [waitlisting, setWaitlisting] = useState(false);
  const [typeId, setTypeId] = useState(q.get("type") ?? "");
  const [referralId, setReferralId] = useState("");
  const [practitionerId, setPractitionerId] = useState(
    q.get("practitioner") ?? "",
  );
  const [locationId, setLocationId] = useState(q.get("location") ?? "");
  const hinted = q.get("start");
  const [fromDate, setFromDate] = useState(
    hinted ? dt(hinted, tz).toISODate()! : todayIn(tz),
  );
  const initialChannel = q.get("channel");
  const [channel, setChannel] = useState<Channel>(
    (CHANNELS as readonly string[]).includes(initialChannel ?? "")
      ? (initialChannel as Channel)
      : "PHONE",
  );
  const [slot, setSlot] = useState<Slot | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [notes, setNotes] = useState("");
  const [booked, setBooked] = useState<Appointment | null>(null);
  const action = useAction();
  const remaining = useCountdown(hold?.expires_at ?? null);

  // A patient chosen elsewhere (their record, the calendar).
  const preselected = q.get("patient");
  useEffect(() => {
    if (!preselected || patient) return;
    void practice.client
      .get<{ patient: PatientDetail }>(`/patients/${preselected}`)
      .then((r) => setPatient(r.patient))
      .catch(() => undefined);
  }, [preselected, patient, practice.client]);
  // The availability window starts now (today) or at the chosen day's start;
  // fixed per choice so the list is not re-queried on every render.
  const windowStart = useMemo(
    () =>
      fromDate === todayIn(tz)
        ? new Date().toISOString()
        : startOfDay(fromDate, tz).toISO()!,
    [fromDate, tz],
  );

  const types = practice.data.appointment_types.filter((t) => t.active);
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
              (r.status === "VERIFIED" ||
                (r.status === "RECEIVED" &&
                  !practice.data.practice.referral_verification_required)) &&
              (!r.appointment_type || r.appointment_type.id === typeId),
          )
        : [],
    [patient?.id, typeId, practice.tick],
  );
  useEffect(() => {
    const first = referrals.data?.[0];
    if (first && !referralId) setReferralId(first.id);
  }, [referrals.data, referralId]);
  const allowedPractitioners = useMemo(
    () =>
      practice.data.practitioners.filter(
        (p) => p.active && (!type || type.practitioner_ids.includes(p.id)),
      ),
    [practice.data.practitioners, type],
  );
  const allowedLocations = practice.data.locations.filter(
    (l) => l.active && (!type || type.location_ids.includes(l.id)),
  );
  const needsReferral = Boolean(type?.requires_referral);
  const referralReady = !needsReferral || Boolean(referralId);

  const release = async () => {
    if (!hold) return;
    const h = hold;
    setHold(null);
    await practice.client
      .send("POST", `/slot-holds/${h.id}/release`, {})
      .catch(() => undefined);
    practice.changed();
  };
  const reserve = (s: Slot) =>
    void action.run(async () => {
      if (hold) await release();
      setSlot(s);
      try {
        const r = await practice.client.send<{ hold: Hold }>(
          "POST",
          "/slot-holds",
          {
            patient_id: patient!.id,
            appointment_type_id: typeId,
            practitioner_id: s.practitioner_id,
            location_id: s.location_id,
            start: s.start,
            source_channel: channel,
            referral_id: referralId || null,
          },
        );
        setHold(r.hold);
        practice.changed();
      } catch (e) {
        setSlot(null);
        if (errorCode(e) === "SLOT_UNAVAILABLE") practice.changed();
        throw e;
      }
    });
  const confirm = () =>
    void action.run(async () => {
      const r = await practice.client.send<{ appointment: Appointment }>(
        "POST",
        `/slot-holds/${hold!.id}/confirm`,
        { notes: notes.trim() || null },
      );
      setBooked(r.appointment);
      setHold(null);
      practice.changed();
    });
  useEffect(() => {
    if (hold && remaining === 0) {
      setHold(null);
      setSlot(null);
      action.setError(
        "The reservation lapsed before it was confirmed. Choose the time again.",
      );
    }
  }, [remaining, hold, action]);
  // Leaving the page gives a still-held time back.
  const held = useRef<Hold | null>(null);
  held.current = hold;
  useEffect(
    () => () => {
      const h = held.current;
      if (h)
        void practice.client
          .send("POST", `/slot-holds/${h.id}/release`, {})
          .catch(() => undefined);
    },
    [practice.client],
  );

  if (booked)
    return (
      <>
        <PageHeader title="Booked" />
        <section className="panel booked">
          <div className="panel__body">
            <p className="booked__line">
              <Icon name="check" />
              <strong>{booked.patient.display_name}</strong> is booked for{" "}
              {fmt.when(booked.starts_at, booked.timezone)} with{" "}
              {booked.practitioner.display_name} at {booked.location.name}.
            </p>
            <p className="muted">
              {booked.appointment_type.name} · booked by{" "}
              {CHANNEL_LABELS[booked.source_channel].toLowerCase()}. A
              confirmation goes to the patient if they have agreed to messages.
            </p>
            <div className="form__actions">
              <a
                className="btn btn-secondary"
                href={link("appointment", booked.id)}
              >
                Open the appointment
              </a>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setBooked(null);
                  setPatient(null);
                  setSlot(null);
                  setNotes("");
                  go(link("book", null, { channel }));
                }}
              >
                Book another
              </button>
            </div>
          </div>
        </section>
      </>
    );

  return (
    <>
      <PageHeader
        title="Book appointment"
        context="Times come from the practice's live schedule. A chosen time is held for the patient while you confirm."
      />
      <ol className="steps">
        <li className="panel step">
          <div className="panel__head">
            <h2 className="section-title">1. Patient</h2>
            {patient && (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  void release();
                  setPatient(null);
                  setSlot(null);
                }}
              >
                Change
              </button>
            )}
          </div>
          <div className="panel__body">
            {patient ? (
              <p>
                <strong>{patient.display_name}</strong>{" "}
                <span className="mono muted">{patient.patient_number}</span>
                {patient.date_of_birth && (
                  <span className="muted"> · born {patient.date_of_birth}</span>
                )}
                {patient.identity_verification === "UNVERIFIED" && (
                  <>
                    {" "}
                    <Tone tone="attention">Identity not verified</Tone>
                  </>
                )}
              </p>
            ) : (
              <>
                <PatientPicker onPick={setPatient} autoFocus />
                {practice.can("patient.write") && (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => setRegistering(true)}
                  >
                    <Icon name="plus" size={18} />
                    Register a new patient
                  </button>
                )}
              </>
            )}
          </div>
        </li>

        <li className="panel step" aria-disabled={!patient}>
          <div className="panel__head">
            <h2 className="section-title">2. Appointment</h2>
          </div>
          <div className="panel__body form">
            <div className="form-row">
              <div className="field">
                <label htmlFor="book-type">Type</label>
                <select
                  id="book-type"
                  value={typeId}
                  disabled={!patient}
                  onChange={(e) => {
                    void release();
                    setTypeId(e.target.value);
                    setReferralId("");
                    setSlot(null);
                  }}
                >
                  <option value="">Choose…</option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.duration_minutes} min)
                      {t.requires_referral ? " · referral needed" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <ChannelSelect
                id="book-channel"
                value={channel}
                onChange={setChannel}
              />
            </div>
            {needsReferral && patient && (
              <div className="field">
                <label htmlFor="book-referral">Referral</label>
                {referrals.data && referrals.data.length > 0 ? (
                  <select
                    id="book-referral"
                    value={referralId}
                    onChange={(e) => setReferralId(e.target.value)}
                  >
                    {referrals.data.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.referring_practitioner_name}
                        {r.valid_until ? ` · valid until ${r.valid_until}` : ""}
                        {r.max_appointments !== null
                          ? ` · ${r.max_appointments - r.appointments_used} visit(s) left`
                          : ""}
                        {r.status === "RECEIVED" ? " · not yet verified" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="note small">
                    {type?.name} needs a{" "}
                    {practice.data.practice.referral_verification_required
                      ? "verified "
                      : ""}
                    referral, and this patient has none that covers it.{" "}
                    {practice.can("referral.register") && (
                      <a
                        href={link("referrals", null, { register: patient.id })}
                      >
                        Register the referral
                      </a>
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        </li>

        <li
          className="panel step"
          aria-disabled={!patient || !typeId || !referralReady}
        >
          <div className="panel__head">
            <h2 className="section-title">3. Time</h2>
            {patient && typeId && practice.can("waitlist.manage") && (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setWaitlisting(true)}
              >
                <Icon name="waitlist" size={18} />
                Add to waitlist instead
              </button>
            )}
          </div>
          <div className="panel__body">
            {patient && typeId && referralReady ? (
              <>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="book-practitioner">Practitioner</label>
                    <select
                      id="book-practitioner"
                      value={practitionerId}
                      onChange={(e) => setPractitionerId(e.target.value)}
                    >
                      <option value="">Anyone who offers it</option>
                      {allowedPractitioners.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.display_name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {allowedLocations.length > 1 && (
                    <div className="field">
                      <label htmlFor="book-location">Location</label>
                      <select
                        id="book-location"
                        value={locationId}
                        onChange={(e) => setLocationId(e.target.value)}
                      >
                        <option value="">Any</option>
                        {allowedLocations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="field">
                    <label htmlFor="book-from">From</label>
                    <input
                      id="book-from"
                      type="date"
                      value={fromDate}
                      min={todayIn(tz)}
                      onChange={(e) =>
                        e.target.value && setFromDate(e.target.value)
                      }
                    />
                  </div>
                </div>
                <SlotPicker
                  typeId={typeId}
                  practitionerId={practitionerId || undefined}
                  locationId={locationId || undefined}
                  from={windowStart}
                  days={7}
                  selected={slot}
                  onPick={reserve}
                />
              </>
            ) : (
              <p className="muted">
                Choose the patient and the appointment first.
              </p>
            )}
          </div>
        </li>

        <li className="panel step" aria-disabled={!hold}>
          <div className="panel__head">
            <h2 className="section-title">4. Confirm</h2>
          </div>
          <div className="panel__body form">
            {hold && slot ? (
              <>
                <p>
                  <strong>{fmt.when(slot.start, slot.timezone)}</strong> with{" "}
                  {slot.practitioner_name} at {slot.location_name} is held for{" "}
                  {patient?.display_name}.{" "}
                  <span className="hold-timer" role="timer" aria-live="off">
                    {Math.floor(remaining / 60)}:
                    {String(remaining % 60).padStart(2, "0")} left
                  </span>
                </p>
                <div className="field">
                  <label htmlFor="book-notes">
                    Administrative note{" "}
                    <span className="optional">(optional)</span>
                  </label>
                  <input
                    id="book-notes"
                    value={notes}
                    maxLength={500}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g. needs wheelchair access"
                  />
                </div>
                <div className="form__actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      void release();
                      setSlot(null);
                    }}
                  >
                    Choose another time
                  </button>
                  <button
                    type="button"
                    className="btn btn-lg"
                    disabled={action.busy}
                    onClick={confirm}
                  >
                    Confirm booking
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">Pick a time to hold it for the patient.</p>
            )}
            <ErrorNote error={action.error} />
          </div>
        </li>
      </ol>
      {registering && (
        <RegisterPatientDialog
          channel={channel}
          onClose={() => setRegistering(false)}
          onCreated={(p) => {
            setRegistering(false);
            setPatient(p);
          }}
        />
      )}
      {waitlisting && patient && (
        <AddToWaitlistDialog
          patient={patient}
          typeId={typeId}
          onClose={() => setWaitlisting(false)}
          onAdded={() => {
            setWaitlisting(false);
            go(link("waitlist"));
          }}
        />
      )}
    </>
  );
}
