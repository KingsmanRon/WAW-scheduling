import React, { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { label } from "../../format";
import { PageHeader } from "../../layout/PageHeader";
import { usePractice } from "../context";
import { useLink, type ViewProps } from "../PracticeApp";
import { fmt } from "../time";
import type {
  Appointment,
  NotificationPreferences,
  PatientDetail as Patient,
  Referral,
  WaitlistEntry,
} from "../types";
import {
  Dialog,
  Empty,
  ErrorNote,
  Loading,
  StatusBadge,
  Tone,
  useAction,
  useLoad,
} from "../ui";

export function PatientDetail({ route }: ViewProps) {
  const practice = usePractice();
  const link = useLink();
  const id = route.id!;
  const patient = useLoad(
    async () =>
      (await practice.client.get<{ patient: Patient }>(`/patients/${id}`))
        .patient,
    [id, practice.tick],
  );
  const [since] = useState(() =>
    new Date(Date.now() - 365 * 86_400_000).toISOString(),
  );
  const appointments = useLoad(
    async () =>
      (
        await practice.client.get<{ items: Appointment[] }>("/appointments", {
          patient_id: id,
          from: since,
          limit: 100,
        })
      ).items,
    [id, since, practice.tick],
  );
  const waitlist = useLoad(
    async () =>
      practice.can("waitlist.read")
        ? (
            await practice.client.get<{ items: WaitlistEntry[] }>("/waitlist", {
              patient_id: id,
              limit: 20,
            })
          ).items
        : null,
    [id, practice.tick],
  );
  const referrals = useLoad(
    async () =>
      practice.can("referral.read")
        ? (
            await practice.client.get<{ items: Referral[] }>("/referrals", {
              patient_id: id,
              limit: 20,
            })
          ).items
        : null,
    [id, practice.tick],
  );
  const [dialog, setDialog] = useState<
    null | "edit" | "contact" | "identifier"
  >(null);
  const remove = useAction();
  if (patient.error && !patient.data)
    return <ErrorNote error={patient.error} />;
  if (!patient.data) return <Loading what="the patient" />;
  const p = patient.data;
  const now = Date.now();
  const upcoming = (appointments.data ?? []).filter(
    (a) =>
      Date.parse(a.ends_at) >= now &&
      ["HELD", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"].includes(a.status),
  );
  const past = (appointments.data ?? [])
    .filter((a) => !upcoming.includes(a))
    .reverse();
  const canWrite = practice.can("patient.write");
  return (
    <>
      <PageHeader
        title={
          <>
            {p.display_name}
            <span className="title-meta mono"> {p.patient_number}</span>
          </>
        }
        context={[
          p.date_of_birth && `Born ${p.date_of_birth}`,
          p.status === "ARCHIVED" && "Archived record",
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            {p.identity_verification === "UNVERIFIED" ? (
              <Tone tone="attention">Identity not verified</Tone>
            ) : (
              <Tone tone="booked">Identity verified</Tone>
            )}
            {practice.can("appointment.book") && p.status === "ACTIVE" && (
              <a className="btn" href={link("book", null, { patient: p.id })}>
                <Icon name="plus" size={18} />
                Book appointment
              </a>
            )}
          </>
        }
      />
      {p.possible_duplicates.length > 0 && (
        <p className="note">
          This record may belong to the same person as{" "}
          {p.possible_duplicates.map((d, i) => (
            <React.Fragment key={d.id}>
              {i > 0 && ", "}
              <a href={link("patient", d.other_patient_id)}>another record</a>
            </React.Fragment>
          ))}
          . Check before booking; records are never merged automatically.
        </p>
      )}
      <div className="detail-grid">
        <section className="panel">
          <div className="panel__head">
            <h2 className="section-title">Details</h2>
            {canWrite && (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setDialog("edit")}
              >
                Edit
              </button>
            )}
          </div>
          <div className="panel__body">
            <dl className="facts">
              <dt>Name</dt>
              <dd>
                {p.given_name} {p.family_name}
                {p.preferred_name && (
                  <span className="muted"> (known as {p.preferred_name})</span>
                )}
              </dd>
              <dt>Date of birth</dt>
              <dd>
                {p.date_of_birth ?? <span className="muted">Not recorded</span>}
              </dd>
              <dt>Registered through</dt>
              <dd>{label(p.source_channel)}</dd>
              {p.identifiers.map((i) => (
                <React.Fragment key={i.id}>
                  <dt>
                    {i.system === "NATIONAL_ID" ? "ID number" : label(i.system)}
                  </dt>
                  <dd className="mono">{i.value ?? i.hint ?? "Recorded"}</dd>
                </React.Fragment>
              ))}
            </dl>
            {canWrite && (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setDialog("identifier")}
              >
                Add an identifier
              </button>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel__head">
            <h2 className="section-title">Contact</h2>
            {canWrite && (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setDialog("contact")}
              >
                Add
              </button>
            )}
          </div>
          <div className="panel__body">
            {p.contacts.length ? (
              <ul className="events">
                {p.contacts.map((c) => (
                  <li key={c.id}>
                    <span>
                      <span className="mono">{c.value}</span>
                      <span className="muted small">
                        {" "}
                        · {label(c.kind)}
                        {c.is_primary && " · primary"}
                        {c.whatsapp_capable && " · WhatsApp"}
                        {c.verification_method &&
                          ` · confirmed (${label(c.verification_method)})`}
                      </span>
                    </span>
                    {canWrite && (
                      <button
                        type="button"
                        className="btn btn-quiet"
                        disabled={remove.busy}
                        onClick={() =>
                          void remove.run(async () => {
                            await practice.client.send(
                              "POST",
                              `/patients/${p.id}/contacts/${c.id}/remove`,
                              {},
                            );
                            await patient.reload();
                          })
                        }
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                No contact details. The patient cannot be sent confirmations or
                reminders.
              </p>
            )}
            <ErrorNote error={remove.error} />
          </div>
        </section>

        {practice.can("notification.read") && <ConsentPanel patientId={p.id} />}

        <section className="panel">
          <div className="panel__head">
            <h2 className="section-title">Appointments</h2>
            <a
              className="btn btn-quiet"
              href={link("appointments", null, { patient: p.id })}
            >
              Search all
            </a>
          </div>
          <div className="panel__body">
            {!appointments.data ? (
              <Loading what="appointments" />
            ) : !appointments.data.length ? (
              <Empty title="No appointments in the last year" />
            ) : (
              <>
                {upcoming.length > 0 && <h3 className="caps">Upcoming</h3>}
                <AppointmentList items={upcoming} />
                {past.length > 0 && <h3 className="caps">Earlier</h3>}
                <AppointmentList items={past.slice(0, 10)} />
              </>
            )}
          </div>
        </section>

        {waitlist.data && waitlist.data.length > 0 && (
          <section className="panel">
            <div className="panel__head">
              <h2 className="section-title">Waitlist</h2>
            </div>
            <div className="panel__body">
              <ul className="events">
                {waitlist.data.map((w) => (
                  <li key={w.id}>
                    <span>
                      {w.appointment_type.name} · {w.earliest_date} to{" "}
                      {w.latest_date}
                    </span>
                    <span>{label(w.status)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {referrals.data && referrals.data.length > 0 && (
          <section className="panel">
            <div className="panel__head">
              <h2 className="section-title">Referrals</h2>
            </div>
            <div className="panel__body">
              <ul className="events">
                {referrals.data.map((r) => (
                  <li key={r.id}>
                    <a href={link("referrals", null, { open: r.id })}>
                      From {r.referring_practitioner_name}
                      {r.appointment_type && ` · ${r.appointment_type.name}`}
                    </a>
                    <span>{label(r.status)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </div>
      {dialog === "edit" && (
        <EditPatientDialog
          patient={p}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void patient.reload();
          }}
        />
      )}
      {dialog === "contact" && (
        <AddContactDialog
          patientId={p.id}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void patient.reload();
          }}
        />
      )}
      {dialog === "identifier" && (
        <AddIdentifierDialog
          patientId={p.id}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void patient.reload();
          }}
        />
      )}
    </>
  );
}

function AppointmentList({ items }: { items: Appointment[] }) {
  const link = useLink();
  if (!items.length) return null;
  return (
    <ul className="events">
      {items.map((a) => (
        <li key={a.id}>
          <a href={link("appointment", a.id)}>
            {fmt.when(a.starts_at, a.timezone)} · {a.appointment_type.name}
          </a>
          <StatusBadge status={a.status} />
          <small>
            {a.practitioner.display_name} · {a.location.name}
          </small>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the patient agreed to be sent, and how. Staff record consent the
 * patient gives in person or on the phone; consent given (or withdrawn with
 * STOP) in WhatsApp appears here too. Every change is audited.
 */
function ConsentPanel({ patientId }: { patientId: string }) {
  const practice = usePractice();
  const prefs = useLoad(
    async () =>
      (
        await practice.client.get<{ preferences: NotificationPreferences }>(
          `/patients/${patientId}/notification-preferences`,
        )
      ).preferences,
    [patientId, practice.tick],
  );
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);
  useEffect(() => {
    if (prefs.data) setDraft(prefs.data);
  }, [prefs.data]);
  const save = useAction();
  const editable = practice.can("notification.preferences.manage");
  if (!prefs.data || !draft) return null;
  const p = prefs.data;
  const changed =
    draft.whatsapp_opt_in !== p.whatsapp_opt_in ||
    draft.email_opt_in !== p.email_opt_in ||
    draft.reminders_enabled !== p.reminders_enabled ||
    draft.preferred_channel !== p.preferred_channel;
  const source = (s: string | null, at: string | null) =>
    s ? `${label(s)}${at ? `, ${fmt.when(at, practice.tz)}` : ""}` : "";
  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="section-title">Messages and consent</h2>
      </div>
      <form
        className="panel__body form"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run(async () => {
            await practice.client.send(
              "PUT",
              `/patients/${patientId}/notification-preferences`,
              {
                whatsapp_opt_in: draft.whatsapp_opt_in,
                email_opt_in: draft.email_opt_in,
                reminders_enabled: draft.reminders_enabled,
                preferred_channel: draft.preferred_channel,
                ...(p.version !== null ? { expected_version: p.version } : {}),
              },
            );
            await prefs.reload();
          });
        }}
      >
        <p className="field-hint">
          Ask the patient before recording consent. Messages cover appointment
          confirmations, changes, reminders and waitlist offers only.
        </p>
        <label className="check">
          <input
            type="checkbox"
            disabled={!editable}
            checked={draft.whatsapp_opt_in}
            onChange={(e) =>
              setDraft({
                ...draft,
                whatsapp_opt_in: e.target.checked,
                preferred_channel:
                  !e.target.checked && draft.preferred_channel === "WHATSAPP"
                    ? null
                    : draft.preferred_channel,
              })
            }
          />
          <span>
            The patient agrees to receive appointment messages on WhatsApp
            {p.whatsapp_opt_in && (
              <span className="muted small">
                {" "}
                ({source(p.whatsapp_consent_source, p.whatsapp_consent_at)})
              </span>
            )}
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            disabled={!editable}
            checked={draft.email_opt_in}
            onChange={(e) =>
              setDraft({
                ...draft,
                email_opt_in: e.target.checked,
                preferred_channel:
                  !e.target.checked && draft.preferred_channel === "EMAIL"
                    ? null
                    : draft.preferred_channel,
              })
            }
          />
          <span>
            The patient agrees to receive appointment messages by e-mail
            {p.email_opt_in && (
              <span className="muted small">
                {" "}
                ({source(p.email_consent_source, p.email_consent_at)})
              </span>
            )}
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            disabled={!editable}
            checked={draft.reminders_enabled}
            onChange={(e) =>
              setDraft({ ...draft, reminders_enabled: e.target.checked })
            }
          />
          Send reminders before appointments
        </label>
        <div className="field">
          <label htmlFor="pref-channel">Preferred channel</label>
          <select
            id="pref-channel"
            disabled={!editable}
            value={draft.preferred_channel ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                preferred_channel: (e.target.value ||
                  null) as NotificationPreferences["preferred_channel"],
              })
            }
          >
            <option value="">No preference</option>
            {draft.whatsapp_opt_in && (
              <option value="WHATSAPP">WhatsApp</option>
            )}
            {draft.email_opt_in && <option value="EMAIL">E-mail</option>}
          </select>
        </div>
        <ErrorNote error={save.error} />
        {editable && (
          <div className="form__actions">
            <button className="btn" disabled={!changed || save.busy}>
              Record consent
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

function EditPatientDialog({
  patient: p,
  onClose,
  onSaved,
}: {
  patient: Patient;
  onClose: () => void;
  onSaved: () => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [given, setGiven] = useState(p.given_name);
  const [family, setFamily] = useState(p.family_name);
  const [preferred, setPreferred] = useState(p.preferred_name ?? "");
  const [dob, setDob] = useState(p.date_of_birth ?? "");
  const [verified, setVerified] = useState(
    p.identity_verification !== "UNVERIFIED",
  );
  return (
    <Dialog title="Edit details" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void action
            .run(() =>
              practice.client.send("PATCH", `/patients/${p.id}`, {
                given_name: given.trim(),
                family_name: family.trim(),
                preferred_name: preferred.trim() || null,
                date_of_birth: dob || null,
                identity_verified: verified,
                expected_version: p.version,
              }),
            )
            .then((ok) => ok && onSaved());
        }}
      >
        <div className="form-row">
          <div className="field">
            <label htmlFor="edit-given">Given name(s)</label>
            <input
              id="edit-given"
              value={given}
              onChange={(e) => setGiven(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="edit-family">Family name</label>
            <input
              id="edit-family"
              value={family}
              onChange={(e) => setFamily(e.target.value)}
              required
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="edit-preferred">
              Preferred name <span className="optional">(optional)</span>
            </label>
            <input
              id="edit-preferred"
              value={preferred}
              onChange={(e) => setPreferred(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="edit-dob">Date of birth</label>
            <input
              id="edit-dob"
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
          />
          I have checked the patient&rsquo;s identity document
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

function AddContactDialog({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [kind, setKind] = useState<"MOBILE" | "EMAIL" | "LANDLINE">("MOBILE");
  const [value, setValue] = useState("");
  const [primary, setPrimary] = useState(false);
  const [whatsapp, setWhatsapp] = useState(false);
  return (
    <Dialog title="Add contact" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void action
            .run(() =>
              practice.client.send("POST", `/patients/${patientId}/contacts`, {
                kind,
                value: value.trim(),
                is_primary: primary,
                ...(kind === "MOBILE" ? { whatsapp_capable: whatsapp } : {}),
              }),
            )
            .then((ok) => ok && onSaved());
        }}
      >
        <div className="form-row">
          <div className="field">
            <label htmlFor="contact-kind">Kind</label>
            <select
              id="contact-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="MOBILE">Mobile</option>
              <option value="LANDLINE">Landline</option>
              <option value="EMAIL">E-mail</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="contact-value">
              {kind === "EMAIL" ? "Address" : "Number"}
            </label>
            <input
              id="contact-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={primary}
            onChange={(e) => setPrimary(e.target.checked)}
          />
          Make this the primary {kind === "EMAIL" ? "address" : "number"}
        </label>
        {kind === "MOBILE" && (
          <label className="check">
            <input
              type="checkbox"
              checked={whatsapp}
              onChange={(e) => setWhatsapp(e.target.checked)}
            />
            The patient uses WhatsApp on this number
          </label>
        )}
        <ErrorNote error={action.error} />
        <div className="form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={action.busy}>
            Add
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AddIdentifierDialog({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [system, setSystem] = useState<"NATIONAL_ID" | "PASSPORT" | "EXTERNAL">(
    "NATIONAL_ID",
  );
  const [issuer, setIssuer] = useState("ZA");
  const [value, setValue] = useState("");
  return (
    <Dialog title="Add an identifier" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void action
            .run(() =>
              practice.client.send(
                "POST",
                `/patients/${patientId}/identifiers`,
                {
                  system,
                  issuer: issuer.trim().toUpperCase(),
                  value: value.trim(),
                },
              ),
            )
            .then((ok) => ok && onSaved());
        }}
      >
        <div className="form-row">
          <div className="field">
            <label htmlFor="ident-system">Kind</label>
            <select
              id="ident-system"
              value={system}
              onChange={(e) => {
                const s = e.target.value as typeof system;
                setSystem(s);
                setIssuer(s === "NATIONAL_ID" ? "ZA" : "");
              }}
            >
              <option value="NATIONAL_ID">SA ID number</option>
              <option value="PASSPORT">Passport</option>
              <option value="EXTERNAL">Other system (e.g. EMR number)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ident-issuer">
              {system === "EXTERNAL" ? "System" : "Issuing country"}
            </label>
            <input
              id="ident-issuer"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              required
              disabled={system === "NATIONAL_ID"}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="ident-value">Number</label>
          <input
            id="ident-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            autoComplete="off"
          />
          {system !== "EXTERNAL" && (
            <span className="field-hint">
              Stored only as a keyed hash; staff see a hint.
            </span>
          )}
        </div>
        <ErrorNote error={action.error} />
        <div className="form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={action.busy}>
            Add
          </button>
        </div>
      </form>
    </Dialog>
  );
}
