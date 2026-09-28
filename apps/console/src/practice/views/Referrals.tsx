import React, { useEffect, useState } from "react";
import { fileToBase64 } from "../../api";
import { Icon } from "../../components/Icon";
import { label } from "../../format";
import { PageHeader } from "../../layout/PageHeader";
import { usePractice } from "../context";
import { useLink, type ViewProps } from "../PracticeApp";
import { fmt } from "../time";
import type { PatientDetail, PatientSummary, Referral } from "../types";
import {
  Dialog,
  Empty,
  ErrorNote,
  Loading,
  PatientPicker,
  Tone,
  useAction,
  useLoad,
} from "../ui";

const STATUS_TONE: Record<
  Referral["status"],
  "attention" | "booked" | "exception" | "closed"
> = {
  RECEIVED: "attention",
  VERIFIED: "booked",
  REJECTED: "exception",
  CANCELLED: "closed",
};
const REJECT_REASONS = [
  "EXPIRED",
  "INCOMPLETE",
  "WRONG_PATIENT",
  "NOT_APPLICABLE",
  "OTHER",
] as const;
const MEDIA: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPEG image",
  "image/png": "PNG image",
  "text/plain": "Text",
};

/**
 * The referral register: what the practice received, whether staff have
 * verified it, what it covers and how much of it is used. Letters are
 * private: receptionists can file them but only clinicians and
 * administrators can open them, through a one-minute link.
 */
export function Referrals({ route }: ViewProps) {
  const practice = usePractice();
  const link = useLink();
  const [status, setStatus] = useState(route.query.get("status") ?? "");
  const [open, setOpen] = useState<string | null>(route.query.get("open"));
  const registerFor = route.query.get("register");
  const [registering, setRegistering] = useState(Boolean(registerFor));
  const list = useLoad(
    () =>
      practice.client.get<{ items: Referral[] }>("/referrals", {
        status: status || undefined,
        limit: 200,
      }),
    [status, practice.tick],
  );
  return (
    <>
      <PageHeader
        title="Referrals"
        context={
          practice.data.practice.referral_verification_required
            ? "Appointment types that need a referral can only be booked against a verified one."
            : "Appointment types that need a referral can be booked against any open referral."
        }
        actions={
          practice.can("referral.register") && (
            <button
              type="button"
              className="btn"
              onClick={() => setRegistering(true)}
            >
              <Icon name="plus" size={18} />
              Register referral
            </button>
          )
        }
      >
        <div className="toolbar">
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            <option value="RECEIVED">To verify</option>
            <option value="VERIFIED">Verified</option>
            <option value="REJECTED">Rejected</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
      </PageHeader>
      <ErrorNote error={list.error} />
      {!list.data && !list.error && <Loading what="referrals" />}
      {list.data && !list.data.items.length && <Empty title="No referrals" />}
      {list.data && list.data.items.length > 0 && (
        <div
          className={`panel table-wrap${list.loading ? " is-refreshing" : ""}`}
        >
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Patient</th>
                <th scope="col">From</th>
                <th scope="col">Covers</th>
                <th scope="col">Valid until</th>
                <th scope="col">Used</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setOpen(r.id)}
                    >
                      {r.patient.display_name}
                    </button>{" "}
                    <span className="mono muted small">
                      {r.patient.patient_number}
                    </span>
                  </td>
                  <td>
                    {r.referring_practitioner_name}
                    {r.referring_practice_name && (
                      <span className="muted small">
                        {" "}
                        · {r.referring_practice_name}
                      </span>
                    )}
                  </td>
                  <td>
                    {r.appointment_type?.name ?? (
                      <span className="muted">Any type</span>
                    )}
                  </td>
                  <td>
                    {r.valid_until ?? (
                      <span className="muted">No end date</span>
                    )}
                  </td>
                  <td className="num">
                    {r.appointments_used}
                    {r.max_appointments !== null && ` of ${r.max_appointments}`}
                  </td>
                  <td>
                    <Tone tone={STATUS_TONE[r.status]}>
                      {r.status === "RECEIVED" ? "To verify" : label(r.status)}
                    </Tone>
                    {r.document_count > 0 && (
                      <span className="muted small">
                        {" "}
                        · {r.document_count} document
                        {r.document_count === 1 ? "" : "s"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <ReferralDialog id={open} onClose={() => setOpen(null)} />}
      {registering && (
        <RegisterReferralDialog
          patientId={registerFor}
          onClose={() => setRegistering(false)}
          onCreated={(id) => {
            setRegistering(false);
            setOpen(id);
          }}
        />
      )}
      <p className="muted small">
        Booking checks referrals itself;{" "}
        <a href={link("book")}>book an appointment</a> and choose the referral
        there.
      </p>
    </>
  );
}

function RegisterReferralDialog({
  patientId,
  onClose,
  onCreated,
}: {
  patientId: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const practice = usePractice();
  const action = useAction();
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [doctor, setDoctor] = useState("");
  const [practiceName, setPracticeName] = useState("");
  const [practiceNumber, setPracticeNumber] = useState("");
  const [issued, setIssued] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [typeId, setTypeId] = useState("");
  const [visits, setVisits] = useState("");
  useEffect(() => {
    if (!patientId) return;
    void practice.client
      .get<{ patient: PatientDetail }>(`/patients/${patientId}`)
      .then((r) => setPatient(r.patient))
      .catch(() => undefined);
  }, [patientId, practice.client]);
  return (
    <Dialog title="Register referral" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const r = await practice.client.send<Referral>(
              "POST",
              "/referrals",
              {
                patient_id: patient!.id,
                referring_practitioner_name: doctor.trim(),
                referring_practice_name: practiceName.trim() || null,
                referring_practice_number: practiceNumber.trim() || null,
                referral_date: issued || null,
                valid_until: validUntil || null,
                appointment_type_id: typeId || null,
                max_appointments: visits ? Number(visits) : null,
              },
            );
            practice.changed();
            onCreated(r.id);
          });
        }}
      >
        <div className="field">
          <span className="label">Patient</span>
          {patient ? (
            <p>
              <strong>{patient.display_name}</strong>{" "}
              <span className="mono muted">{patient.patient_number}</span>{" "}
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setPatient(null)}
              >
                Change
              </button>
            </p>
          ) : (
            <PatientPicker onPick={setPatient} />
          )}
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="ref-doctor">Referring practitioner</label>
            <input
              id="ref-doctor"
              value={doctor}
              onChange={(e) => setDoctor(e.target.value)}
              required
              maxLength={120}
            />
          </div>
          <div className="field">
            <label htmlFor="ref-practice">
              Their practice <span className="optional">(optional)</span>
            </label>
            <input
              id="ref-practice"
              value={practiceName}
              onChange={(e) => setPracticeName(e.target.value)}
              maxLength={120}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="ref-number">
              Practice number <span className="optional">(optional)</span>
            </label>
            <input
              id="ref-number"
              value={practiceNumber}
              onChange={(e) => setPracticeNumber(e.target.value)}
              maxLength={30}
            />
          </div>
          <div className="field">
            <label htmlFor="ref-issued">Issued on</label>
            <input
              id="ref-issued"
              type="date"
              value={issued}
              onChange={(e) => setIssued(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ref-valid">Valid until</label>
            <input
              id="ref-valid"
              type="date"
              value={validUntil}
              min={issued || undefined}
              onChange={(e) => setValidUntil(e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="ref-type">For</label>
            <select
              id="ref-type"
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
            >
              <option value="">Any appointment type</option>
              {practice.data.appointment_types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ref-visits">
              Number of visits <span className="optional">(optional)</span>
            </label>
            <input
              id="ref-visits"
              type="number"
              min={1}
              max={100}
              value={visits}
              onChange={(e) => setVisits(e.target.value)}
            />
          </div>
        </div>
        <ErrorNote error={action.error} />
        <div className="form__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={!patient || action.busy}>
            Register
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ReferralDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const practice = usePractice();
  const link = useLink();
  const referral = useLoad(
    () => practice.client.get<Referral>(`/referrals/${id}`),
    [id, practice.tick],
  );
  const action = useAction();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] =
    useState<(typeof REJECT_REASONS)[number]>("INCOMPLETE");
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<
    "REFERRAL_LETTER" | "SUPPORTING_DOCUMENT"
  >("REFERRAL_LETTER");
  const decide = (path: string, body: Record<string, unknown>) =>
    void action.run(async () => {
      await practice.client.send("POST", `/referrals/${id}/${path}`, body);
      practice.changed();
      await referral.reload();
    });
  const r = referral.data;
  return (
    <Dialog title="Referral" onClose={onClose} wide>
      <ErrorNote error={referral.error} />
      {!r ? (
        <Loading what="the referral" />
      ) : (
        <>
          <dl className="facts">
            <dt>Patient</dt>
            <dd>
              <a href={link("patient", r.patient.id)}>
                {r.patient.display_name}
              </a>{" "}
              <span className="mono muted">{r.patient.patient_number}</span>
            </dd>
            <dt>Status</dt>
            <dd>
              <Tone tone={STATUS_TONE[r.status]}>
                {r.status === "RECEIVED" ? "To verify" : label(r.status)}
              </Tone>
              {r.rejection_reason_code && (
                <span className="muted">
                  {" "}
                  · {label(r.rejection_reason_code)}
                </span>
              )}
            </dd>
            <dt>From</dt>
            <dd>
              {r.referring_practitioner_name}
              {r.referring_practice_name && `, ${r.referring_practice_name}`}
              {r.referring_practice_number && (
                <span className="mono muted">
                  {" "}
                  {r.referring_practice_number}
                </span>
              )}
            </dd>
            <dt>Issued</dt>
            <dd>
              {r.referral_date ?? <span className="muted">Not recorded</span>}
            </dd>
            <dt>Valid until</dt>
            <dd>
              {r.valid_until ?? <span className="muted">No end date</span>}
            </dd>
            <dt>Covers</dt>
            <dd>
              {r.appointment_type?.name ?? "Any appointment type"} ·{" "}
              {r.appointments_used} visit
              {r.appointments_used === 1 ? "" : "s"} used
              {r.max_appointments !== null && ` of ${r.max_appointments}`}
            </dd>
            <dt>Received</dt>
            <dd>
              {fmt.when(r.received_at, practice.tz)} · {label(r.source_channel)}
            </dd>
          </dl>
          <h3 className="caps section-gap">Documents</h3>
          {r.documents && r.documents.length ? (
            <ul className="events">
              {r.documents.map((d) => (
                <li key={d.id}>
                  <span>
                    {label(d.document_type)} ·{" "}
                    {MEDIA[d.media_type] ?? d.media_type} ·{" "}
                    {Math.max(1, Math.round(d.size_bytes / 1024))} KB
                  </span>
                  {practice.can("referral.document.read") ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          // A one-minute link for this user and this document;
                          // issuing and opening it are audited. The API sends
                          // it as an attachment, so the page stays put.
                          const l = await practice.client.send<{ url: string }>(
                            "POST",
                            `/referrals/${r.id}/documents/${d.id}/link`,
                            {},
                          );
                          window.location.assign(practice.client.url(l.url));
                        })
                      }
                    >
                      <Icon name="document" size={18} />
                      Open
                    </button>
                  ) : (
                    <span className="muted small">Clinical staff only</span>
                  )}
                  <small>Filed {fmt.when(d.created_at, practice.tz)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No documents filed.</p>
          )}
          {practice.can("referral.register") &&
            (r.status === "RECEIVED" || r.status === "VERIFIED") && (
              <form
                className="form-row upload"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!file) return;
                  void action.run(async () => {
                    if (file.size > 10 * 1024 * 1024)
                      throw new Error("Files are limited to 10 MB.");
                    await practice.client.send(
                      "POST",
                      `/referrals/${r.id}/documents`,
                      {
                        document_type: docType,
                        media_type: file.type || "application/octet-stream",
                        content_base64: await fileToBase64(file),
                      },
                    );
                    setFile(null);
                    await referral.reload();
                  });
                }}
              >
                <div className="field">
                  <label htmlFor="ref-file">
                    File a document (PDF, JPEG, PNG or text, up to 10 MB)
                  </label>
                  <input
                    id="ref-file"
                    type="file"
                    accept="application/pdf,image/jpeg,image/png,text/plain"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ref-doctype">Kind</label>
                  <select
                    id="ref-doctype"
                    value={docType}
                    onChange={(e) =>
                      setDocType(e.target.value as typeof docType)
                    }
                  >
                    <option value="REFERRAL_LETTER">Referral letter</option>
                    <option value="SUPPORTING_DOCUMENT">
                      Supporting document
                    </option>
                  </select>
                </div>
                <button
                  className="btn btn-secondary"
                  disabled={!file || action.busy}
                >
                  Upload
                </button>
              </form>
            )}
          <ErrorNote error={action.error} />
          {practice.can("referral.verify") && (
            <div className="form__actions">
              {r.status === "RECEIVED" && !rejecting && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setRejecting(true)}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={action.busy}
                    onClick={() =>
                      decide("verify", { expected_version: r.version })
                    }
                  >
                    Verify
                  </button>
                </>
              )}
              {rejecting && (
                <>
                  <select
                    aria-label="Reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value as typeof reason)}
                  >
                    {REJECT_REASONS.map((x) => (
                      <option key={x} value={x}>
                        {label(x)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setRejecting(false)}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={action.busy}
                    onClick={() => {
                      setRejecting(false);
                      decide("reject", {
                        expected_version: r.version,
                        reason_code: reason,
                      });
                    }}
                  >
                    Reject referral
                  </button>
                </>
              )}
              {(r.status === "RECEIVED" || r.status === "VERIFIED") &&
                !rejecting && (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={action.busy}
                    onClick={() =>
                      decide("cancel", { expected_version: r.version })
                    }
                  >
                    Withdraw
                  </button>
                )}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
