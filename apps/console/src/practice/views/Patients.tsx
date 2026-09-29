import React, { useState } from "react";
import { Icon } from "../../components/Icon";
import { PageHeader } from "../../layout/PageHeader";
import { usePractice } from "../context";
import { useLink, type ViewProps } from "../PracticeApp";
import type { Channel, PatientSummary } from "../types";
import {
  ChannelSelect,
  Dialog,
  Empty,
  ErrorNote,
  PatientPicker,
  Tone,
  useAction,
  useLoad,
} from "../ui";

/**
 * Register a patient. Identity is "not verified" unless staff have checked
 * a document; the mobile number is marked as WhatsApp-capable only when the
 * patient says so. Nothing is merged: if the details look like an existing
 * patient, the API records a possible duplicate for review.
 */
export function RegisterPatientDialog({
  channel: initialChannel = "PHONE",
  onClose,
  onCreated,
}: {
  channel?: Channel;
  onClose: () => void;
  onCreated: (p: PatientSummary) => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [given, setGiven] = useState("");
  const [family, setFamily] = useState("");
  const [preferred, setPreferred] = useState("");
  const [dob, setDob] = useState("");
  const [mobile, setMobile] = useState("");
  const [whatsapp, setWhatsapp] = useState(true);
  const [email, setEmail] = useState("");
  const [nationalId, setNationalId] = useState("");
  const [verified, setVerified] = useState(false);
  const [channel, setChannel] = useState<Channel>(initialChannel);
  return (
    <Dialog title="Register a patient" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const contacts = [
              ...(mobile.trim()
                ? [
                    {
                      kind: "MOBILE",
                      value: mobile.trim(),
                      is_primary: true,
                      whatsapp_capable: whatsapp,
                    },
                  ]
                : []),
              ...(email.trim()
                ? [{ kind: "EMAIL", value: email.trim(), is_primary: true }]
                : []),
            ];
            const r = await practice.client.send<{
              patient: PatientSummary;
              possible_duplicates?: unknown[];
            }>("POST", "/patients", {
              given_name: given.trim(),
              family_name: family.trim(),
              preferred_name: preferred.trim() || null,
              date_of_birth: dob || null,
              source_channel: channel,
              identity_verified: verified,
              contacts,
              identifiers: nationalId.trim()
                ? [
                    {
                      system: "NATIONAL_ID",
                      issuer: "ZA",
                      value: nationalId.trim(),
                    },
                  ]
                : [],
            });
            onCreated(r.patient);
          });
        }}
      >
        <div className="form-row">
          <div className="field">
            <label htmlFor="reg-given">Given name(s)</label>
            <input
              id="reg-given"
              value={given}
              onChange={(e) => setGiven(e.target.value)}
              required
              maxLength={100}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="reg-family">Family name</label>
            <input
              id="reg-family"
              value={family}
              onChange={(e) => setFamily(e.target.value)}
              required
              maxLength={100}
              autoComplete="off"
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="reg-preferred">
              Preferred name <span className="optional">(optional)</span>
            </label>
            <input
              id="reg-preferred"
              value={preferred}
              onChange={(e) => setPreferred(e.target.value)}
              maxLength={100}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="reg-dob">Date of birth</label>
            <input
              id="reg-dob"
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="reg-mobile">Mobile number</label>
            <input
              id="reg-mobile"
              type="tel"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              placeholder="082 123 4567"
              autoComplete="off"
            />
            <label className="check">
              <input
                type="checkbox"
                checked={whatsapp}
                onChange={(e) => setWhatsapp(e.target.checked)}
              />
              The patient uses WhatsApp on this number
            </label>
          </div>
          <div className="field">
            <label htmlFor="reg-email">
              E-mail <span className="optional">(optional)</span>
            </label>
            <input
              id="reg-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="reg-id">
              SA ID number <span className="optional">(optional)</span>
            </label>
            <input
              id="reg-id"
              inputMode="numeric"
              value={nationalId}
              onChange={(e) => setNationalId(e.target.value)}
              autoComplete="off"
            />
            <span className="field-hint">
              Stored only as a keyed hash; shown later as a hint.
            </span>
          </div>
          <ChannelSelect
            id="reg-channel"
            value={channel}
            onChange={setChannel}
            label="Registered through"
          />
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
            Register patient
          </button>
        </div>
      </form>
    </Dialog>
  );
}

interface DuplicatePair {
  id: string;
  reasons: string[];
  patients: {
    id: string;
    patient_number: string;
    display_name: string;
    date_of_birth: string | null;
  }[];
}

export function Patients({ go }: ViewProps) {
  const practice = usePractice();
  const link = useLink();
  const [registering, setRegistering] = useState(false);
  const duplicates = useLoad(
    async () =>
      practice.can("patient.duplicates.review")
        ? (
            await practice.client.get<{ items: DuplicatePair[] }>(
              "/patient-duplicates",
              { status: "OPEN", limit: 50 },
            )
          ).items
        : null,
    [practice.tick],
  );
  const review = useAction();
  return (
    <>
      <PageHeader
        title="Patients"
        context="Search by mobile number, e-mail, patient number, ID number or name."
        actions={
          practice.can("patient.write") && (
            <button
              type="button"
              className="btn"
              onClick={() => setRegistering(true)}
            >
              <Icon name="plus" size={18} />
              Register patient
            </button>
          )
        }
      />
      <section className="panel">
        <div className="panel__body">
          <PatientPicker autoFocus onPick={(p) => go(link("patient", p.id))} />
        </div>
      </section>
      {duplicates.data && (
        <section className="panel section-gap">
          <div className="panel__head">
            <h2 className="section-title">Possible duplicates to review</h2>
            <span className="muted small">Never merged automatically</span>
          </div>
          <div className="panel__body">
            {duplicates.data.length ? (
              <ul className="events">
                {duplicates.data.map((d) => (
                  <li key={d.id}>
                    <span>
                      {d.patients.map((p, i) => (
                        <React.Fragment key={p.id}>
                          {i > 0 && " and "}
                          <a href={link("patient", p.id)}>
                            {p.display_name}
                          </a>{" "}
                          <span className="mono muted">{p.patient_number}</span>
                          {p.date_of_birth && (
                            <span className="muted">
                              {" "}
                              (born {p.date_of_birth})
                            </span>
                          )}
                        </React.Fragment>
                      ))}
                    </span>
                    <span className="button-row button-row--compact">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={review.busy}
                        onClick={() =>
                          void review.run(async () => {
                            await practice.client.send(
                              "POST",
                              `/patient-duplicates/${d.id}/review`,
                              { decision: "DISMISSED" },
                            );
                            await duplicates.reload();
                          })
                        }
                      >
                        Different people
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={review.busy}
                        onClick={() =>
                          void review.run(async () => {
                            await practice.client.send(
                              "POST",
                              `/patient-duplicates/${d.id}/review`,
                              { decision: "CONFIRMED" },
                            );
                            await duplicates.reload();
                          })
                        }
                      >
                        Same person
                      </button>
                    </span>
                    <small>
                      {d.reasons
                        .map((r) => r.toLowerCase().replace(/_/g, " "))
                        .join(", ")}
                      {" · "}
                      <Tone tone="system">
                        Confirming records it for follow-up; records are not
                        merged here
                      </Tone>
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="Nothing to review" />
            )}
            <ErrorNote error={review.error || duplicates.error} />
          </div>
        </section>
      )}
      {registering && (
        <RegisterPatientDialog
          onClose={() => setRegistering(false)}
          onCreated={(p) => {
            setRegistering(false);
            go(link("patient", p.id));
          }}
        />
      )}
    </>
  );
}
