import React, { useState } from "react";
import { api, fileToBase64, newIds } from "../api";
import { Icon } from "../components/Icon";
import { label } from "../format";
import { PageHeader } from "../layout/PageHeader";
import { prefersReducedMotion } from "../motion/reducedMotion";
import { useSession } from "../session";

const DOCUMENTS = [
  "referral_letter",
  "insurance",
  "demographics",
  "medical_aid_card",
  "identity_document",
  "consent_form",
];

/**
 * Staff intake: upload the referral document and key in the administrative
 * fields. Nothing here classifies clinical content; the safety flag routes the
 * case to a person. The request payload is unchanged from the previous console.
 */
export function NewReferral({ open }: { open: (caseId: string) => void }) {
  const session = useSession();
  const synthetic =
    session.me?.data_mode === "SYNTHETIC" &&
    session.me.auth_mode === "synthetic";
  const [file, setFile] = useState<File | null>(null);
  const [fixture, setFixture] = useState("");
  const [f, setF] = useState<Record<string, string>>({});
  const [documents, setDocuments] = useState<string[]>(["referral_letter"]);
  const [safety, setSafety] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set =
    (k: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setError("Choose the referral document");
    setBusy(true);
    setError("");
    try {
      const structured = fixture
        ? undefined
        : {
            patient: {
              given_name: f.given_name,
              family_name: f.family_name,
              date_of_birth: f.date_of_birth,
              ...(f.external_id ? { external_id: f.external_id } : {}),
            },
            referrer: { name: f.referrer },
            ...(f.requested_service
              ? { requested_service: f.requested_service }
              : {}),
            ...(f.referral_date ? { referral_date: f.referral_date } : {}),
            ...(f.funding_type
              ? {
                  funding: {
                    type: f.funding_type,
                    ...(f.scheme ? { scheme: f.scheme } : {}),
                  },
                }
              : {}),
            documents,
            safety_flag: safety,
          };
      const result = await api<{ case_id: string }>(
        session.headers,
        "/v1/referrals",
        {
          method: "POST",
          body: {
            ...newIds(),
            referral_id: crypto.randomUUID(),
            expected_version: 0,
            channel: "STAFF_UPLOAD",
            filename: file.name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120),
            media_type:
              file.type === "application/pdf"
                ? "application/pdf"
                : "text/plain",
            content_base64: await fileToBase64(file),
            ...(fixture ? { fixture } : { structured }),
          },
        },
      );
      open(result.case_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const filled = (...keys: string[]) => keys.every((k) => f[k]?.trim());
  const steps: { id: string; name: string; status: string; done: boolean }[] = [
    {
      id: "intake-document",
      name: "Document",
      status: file ? file.name : "Required",
      done: Boolean(file),
    },
    ...(fixture
      ? []
      : [
          {
            id: "intake-patient",
            name: "Patient identity",
            status: filled("given_name", "family_name", "date_of_birth")
              ? "Complete"
              : "Name and date of birth required",
            done: filled("given_name", "family_name", "date_of_birth"),
          },
          {
            id: "intake-referral",
            name: "Referral details",
            status: filled("referrer")
              ? "Complete"
              : "Referring provider required",
            done: filled("referrer"),
          },
          {
            id: "intake-funding",
            name: "Funding",
            status: f.funding_type ? label(f.funding_type) : "Optional",
            done: Boolean(f.funding_type),
          },
          {
            id: "intake-documents",
            name: "Documents received",
            status: `${documents.length} marked`,
            done: documents.length > 0,
          },
          {
            id: "intake-safety",
            name: "Safety check",
            status: safety ? "Flagged for review" : "Not flagged",
            done: false,
          },
        ]),
    { id: "intake-submit", name: "Submit", status: "", done: false },
  ];
  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    el.querySelector<HTMLElement>("input, select, button")?.focus({
      preventScroll: true,
    });
  };

  return (
    <div className="intake-page">
      <PageHeader
        title="New referral"
        context="Upload the referral document and record its administrative details. Nothing here classifies clinical content."
      />
      <form className="intake" onSubmit={submit}>
        <nav className="intake-steps" aria-label="Intake sections">
          <ol>
            {steps.map((s) => (
              <li
                key={s.id}
                className={
                  s.id === "intake-safety" && safety
                    ? "is-flagged"
                    : s.done
                      ? "is-done"
                      : ""
                }
              >
                <button type="button" onClick={() => jump(s.id)}>
                  <span className="intake-steps__node" aria-hidden />
                  <span className="intake-steps__name">{s.name}</span>
                  {s.status && (
                    <span className="intake-steps__status">{s.status}</span>
                  )}
                </button>
              </li>
            ))}
          </ol>
          {fixture && (
            <p className="intake-steps__note">
              With a synthetic fixture the administrative fields come from the
              fixture, so the other sections are not needed.
            </p>
          )}
        </nav>

        <div className="intake-body">
          <fieldset className="intake-section" id="intake-document">
            <legend>Document</legend>
            <div className="intake-grid">
              <div className="field field--wide">
                <label htmlFor="intake-file">
                  Referral document (PDF or text, max 10 MB)
                </label>
                <input
                  id="intake-file"
                  type="file"
                  accept="application/pdf,text/plain"
                  required
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </div>
              {synthetic && (
                <div className="field field--wide">
                  <label htmlFor="intake-fixture">
                    Synthetic fixture{" "}
                    <span className="optional">(development only)</span>
                  </label>
                  <select
                    id="intake-fixture"
                    value={fixture}
                    onChange={(e) => setFixture(e.target.value)}
                  >
                    <option value="">Enter the fields below</option>
                    <option value="complete">complete</option>
                    <option value="missing-insurance">missing-insurance</option>
                    <option value="ambiguous-identity">
                      ambiguous-identity
                    </option>
                    <option value="urgent">urgent</option>
                  </select>
                </div>
              )}
            </div>
          </fieldset>

          {!fixture && (
            <>
              <fieldset className="intake-section" id="intake-patient">
                <legend>Patient identity</legend>
                <div className="intake-grid">
                  <div className="field">
                    <label htmlFor="intake-given">Patient given name</label>
                    <input
                      id="intake-given"
                      required
                      value={f.given_name ?? ""}
                      onChange={set("given_name")}
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="intake-family">Patient family name</label>
                    <input
                      id="intake-family"
                      required
                      value={f.family_name ?? ""}
                      onChange={set("family_name")}
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="intake-dob">Date of birth</label>
                    <input
                      id="intake-dob"
                      required
                      type="date"
                      value={f.date_of_birth ?? ""}
                      onChange={set("date_of_birth")}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="intake-external">
                      Patient record ID in the destination system{" "}
                      <span className="optional">(if matched)</span>
                    </label>
                    <input
                      id="intake-external"
                      className="mono"
                      value={f.external_id ?? ""}
                      onChange={set("external_id")}
                      autoComplete="off"
                    />
                  </div>
                </div>
              </fieldset>

              <fieldset className="intake-section" id="intake-referral">
                <legend>Referral details</legend>
                <div className="intake-grid">
                  <div className="field">
                    <label htmlFor="intake-referrer">Referring provider</label>
                    <input
                      id="intake-referrer"
                      required
                      value={f.referrer ?? ""}
                      onChange={set("referrer")}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="intake-service">
                      Requested service code{" "}
                      <span className="optional">(optional)</span>
                    </label>
                    <input
                      id="intake-service"
                      className="mono"
                      value={f.requested_service ?? ""}
                      onChange={set("requested_service")}
                      placeholder="e.g. ORTHO_CONSULT"
                      pattern="[A-Z0-9_]{2,64}"
                      aria-describedby="intake-service-hint"
                    />
                    <span className="field-hint" id="intake-service-hint">
                      Capital letters, digits and underscores.
                    </span>
                  </div>
                  <div className="field">
                    <label htmlFor="intake-referral-date">
                      Referral date <span className="optional">(optional)</span>
                    </label>
                    <input
                      id="intake-referral-date"
                      type="date"
                      value={f.referral_date ?? ""}
                      onChange={set("referral_date")}
                    />
                  </div>
                </div>
              </fieldset>

              <fieldset className="intake-section" id="intake-funding">
                <legend>Funding</legend>
                <div className="intake-grid">
                  <div className="field">
                    <label htmlFor="intake-funding-type">
                      Funding <span className="optional">(optional)</span>
                    </label>
                    <select
                      id="intake-funding-type"
                      value={f.funding_type ?? ""}
                      onChange={set("funding_type")}
                    >
                      <option value="">Not recorded</option>
                      <option value="MEDICAL_AID">Medical aid</option>
                      <option value="SELF_PAY">Self pay</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>
                  {f.funding_type === "MEDICAL_AID" && (
                    <div className="field">
                      <label htmlFor="intake-scheme">
                        Medical aid scheme name
                      </label>
                      <input
                        id="intake-scheme"
                        value={f.scheme ?? ""}
                        onChange={set("scheme")}
                      />
                    </div>
                  )}
                </div>
              </fieldset>

              <fieldset className="intake-section" id="intake-documents">
                <legend>Documents received</legend>
                <div className="checks__grid">
                  {DOCUMENTS.map((d) => (
                    <label key={d} className="check">
                      <input
                        type="checkbox"
                        checked={documents.includes(d)}
                        onChange={(e) =>
                          setDocuments(
                            e.target.checked
                              ? [...documents, d]
                              : documents.filter((x) => x !== d),
                          )
                        }
                      />
                      {label(d)}
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset
                className={`intake-section safety-check${safety ? " is-flagged" : ""}`}
                id="intake-safety"
              >
                <legend>Safety check</legend>
                <label className="check safety-check__control">
                  <input
                    type="checkbox"
                    checked={safety}
                    onChange={(e) => setSafety(e.target.checked)}
                  />
                  <span>
                    This referral looks urgent or clinically concerning. Route
                    it to the clinical safety review (ACCESS will not process
                    it).
                  </span>
                </label>
                <p className="safety-check__note">
                  <Icon name="shield" size={18} />
                  {safety
                    ? "Flagged. On submit the referral is held for a person to review; ACCESS will not extract or send it anywhere."
                    : "ACCESS does not read clinical content. If anything in the referral looks urgent or clinical, flag it here and a person will review it."}
                </p>
              </fieldset>
            </>
          )}

          <section className="intake-section intake-submit" id="intake-submit">
            <h2 className="vh">Submit</h2>
            <p className="intake-summary">
              {fixture
                ? `Synthetic fixture "${fixture}"`
                : `Structured intake · ${documents.length} ${documents.length === 1 ? "document" : "documents"} marked`}
              {!fixture && (
                <>
                  {" · "}
                  <strong className={safety ? "intake-summary__flag" : ""}>
                    {safety ? "Safety flag on" : "Safety flag off"}
                  </strong>
                </>
              )}
            </p>
            <button className="btn btn-lg" disabled={busy}>
              {busy ? "Submitting…" : "Submit referral"}
            </button>
            {error && (
              <p className="alert" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      </form>
    </div>
  );
}
