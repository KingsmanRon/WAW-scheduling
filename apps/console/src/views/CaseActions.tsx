import React, { useState } from "react";
import { api, fileToBase64, newIds } from "../api";
import { Icon } from "../components/Icon";
import { label, RESOLUTION_LABELS, when } from "../format";
import { useSession } from "../session";

/* eslint-disable @typescript-eslint/no-explicit-any -- the case view renders an API document */
type View = any;
const DOCUMENTS = [
  "referral_letter",
  "insurance",
  "demographics",
  "medical_aid_card",
  "identity_document",
  "consent_form",
  "prior_results",
];
const CLOSE_CODES = [
  "PATIENT_UNREACHABLE",
  "PATIENT_DECLINED",
  "PROVIDER_DECLINED",
  "DUPLICATE_REFERRAL",
  "INVALID_REFERRAL",
  "MISSING_INFORMATION",
  "REFERRED_ELSEWHERE",
  "CANCELLED",
  "UNKNOWN",
];
/** Presentation only: which available action matches the next step. */
const SUGGESTED: Record<string, string> = {
  IDENTITY_PENDING: "confirm_identity",
  INFORMATION_MISSING: "provide_information",
  READY: "record_destination_reference",
  READY_FOR_BOOKING: "record_booking",
  WAITING: "record_booking",
  EXCEPTION: "resolve_exception",
};
const GROUPS: [string, string[]][] = [
  [
    "Resolve",
    [
      "confirm_identity",
      "provide_information",
      "upload",
      "record_destination_reference",
      "resolve_exception",
    ],
  ],
  [
    "Booking",
    [
      "record_booking",
      "record_follow_up",
      "record_patient_unreachable",
      "record_patient_declined",
      "record_provider_declined",
    ],
  ],
  ["Close", ["close", "reject", "correct_outcome"]],
  ["Record", ["status_contact"]],
];

/**
 * Staff actions available for the case's state and the user's role. The
 * availability rules and request payloads are unchanged from the previous
 * console; only the presentation differs.
 */
export function Actions({ view, onDone }: { view: View; onDone: () => void }) {
  const session = useSession();
  const role = session.me?.role ?? "READ_ONLY";
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [seconds, setSeconds] = useState("");
  const [extra, setExtra] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (role === "READ_ONLY")
    return (
      <p className="actions__readonly">
        <Icon name="lock" size={18} />
        Read-only access: no actions available.
      </p>
    );
  const c = view.case;
  const state: string = c.current_state;
  const items = view.work_items.filter((w: any) => w.status === "OPEN");
  const kinds = new Set(items.map((w: any) => w.kind));
  const reviewObservations = view.observations.filter(
    (o: any) => o.disposition === "REVIEW",
  );
  const available: [string, string][] = [];
  if (
    state === "IDENTITY_PENDING" ||
    (state === "EXCEPTION" && kinds.has("IDENTITY"))
  )
    available.push(["confirm_identity", "Confirm identity"]);
  if (
    ["IDENTITY_PENDING", "INFORMATION_MISSING", "EXCEPTION"].includes(state)
  ) {
    available.push(["provide_information", "Provide / confirm information"]);
    available.push(["upload", "Upload supplementary document"]);
  }
  if (
    (state === "READY" && view.referral?.destination_mode !== "CONNECTOR") ||
    (state === "EXCEPTION" &&
      (kinds.has("CONNECTOR") || kinds.has("MANUAL_DESTINATION")))
  )
    available.push([
      "record_destination_reference",
      "Record destination entry",
    ]);
  if (
    items.some(
      (w: any) =>
        w.kind !== "IDENTITY" &&
        w.kind !== "COMPLETENESS" &&
        // In EXCEPTION a destination item can be retried once the connector is back.
        !(w.kind === "MANUAL_DESTINATION" && state !== "EXCEPTION"),
    )
  )
    available.push(["resolve_exception", "Resolve work item"]);
  if (["READY_FOR_BOOKING", "WAITING"].includes(state)) {
    available.push(["record_booking", "Record booking"]);
    available.push(["record_follow_up", "Record follow-up attempt"]);
    available.push(["record_patient_unreachable", "Patient unreachable"]);
    available.push(["record_patient_declined", "Patient declined"]);
    available.push(["record_provider_declined", "Provider declined"]);
  }
  if (
    ![
      "BOOKED",
      "CLOSED",
      "REJECTED",
      "DESTINATION_PENDING",
      "RECEIVED",
    ].includes(state)
  )
    available.push(["close", "Close with reason"]);
  if (["IDENTITY_PENDING", "INFORMATION_MISSING", "EXCEPTION"].includes(state))
    available.push(["reject", "Reject referral"]);
  if (
    ["BOOKED", "CLOSED"].includes(state) &&
    reviewObservations.length &&
    ["PRACTICE_MANAGER", "ADMIN"].includes(role)
  )
    available.push(["correct_outcome", "Correct outcome"]);
  available.push(["status_contact", "Record status enquiry"]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const base = {
        ...newIds(),
        note,
        ...(seconds ? { staff_seconds: Number(seconds) } : {}),
      };
      if (open === "status_contact")
        await api(session.headers, `/v1/cases/${c.id}/interactions`, {
          method: "POST",
          body: {
            ...newIds(),
            intent: "STATUS_ENQUIRY",
            actor_type: extra.actor_type ?? "PATIENT",
            note,
            ...(seconds ? { staff_seconds: Number(seconds) } : {}),
          },
        });
      else if (open === "upload") {
        const file: File | undefined = extra.file;
        if (!file) throw new Error("Choose a file");
        await api(session.headers, `/v1/cases/${c.id}/interactions`, {
          method: "POST",
          body: {
            ...newIds(),
            intent: "MISSING_INFORMATION",
            actor_type: extra.actor_type ?? "STAFF",
            expected_version: c.version,
            note,
            ...(seconds ? { staff_seconds: Number(seconds) } : {}),
            artifact: {
              filename: file.name
                .replace(/[^a-zA-Z0-9_.-]/g, "_")
                .slice(0, 120),
              media_type:
                file.type === "application/pdf"
                  ? "application/pdf"
                  : "text/plain",
              content_base64: await fileToBase64(file),
              document_types: extra.documents ?? [],
            },
          },
        });
      } else {
        const body: Record<string, unknown> = {
          action: open,
          ...base,
          expected_version: c.version,
        };
        if (open === "provide_information") {
          body.documents = extra.documents ?? [];
          const fields: Record<string, unknown> = {};
          if (extra.requested_service)
            fields.requested_service = extra.requested_service;
          if (extra.referral_date) fields.referral_date = extra.referral_date;
          if (extra.patient_external_id)
            fields.patient_external_id = extra.patient_external_id;
          if (Object.keys(fields).length) body.fields = fields;
        }
        if (open === "record_destination_reference")
          body.destination_reference = extra.destination_reference;
        if (open === "record_booking") {
          body.occurred_at = new Date(
            extra.occurred_at ?? Date.now(),
          ).toISOString();
          if (extra.appointment_reference)
            body.appointment_reference = extra.appointment_reference;
        }
        if (open === "close" || open === "reject")
          body.resolution_code = extra.resolution_code;
        if (open === "resolve_exception") {
          body.work_item_id = extra.work_item_id;
          body.resolution = extra.resolution;
          body.attest_not_committed = Boolean(extra.attest_not_committed);
        }
        if (open === "correct_outcome")
          body.observation_id = extra.observation_id;
        await api(session.headers, `/v1/cases/${c.id}/actions`, {
          method: "POST",
          body,
        });
      }
      setOpen(null);
      setNote("");
      setSeconds("");
      setExtra({});
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const set =
    (k: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setExtra({ ...extra, [k]: e.target.value });
  const docs = (
    <fieldset className="checks">
      <legend>Documents now held</legend>
      <div className="checks__grid">
        {DOCUMENTS.map((d) => (
          <label key={d} className="check">
            <input
              type="checkbox"
              checked={(extra.documents ?? []).includes(d)}
              onChange={(e) =>
                setExtra({
                  ...extra,
                  documents: e.target.checked
                    ? [...(extra.documents ?? []), d]
                    : (extra.documents ?? []).filter((x: string) => x !== d),
                })
              }
            />
            {label(d)}
          </label>
        ))}
      </div>
    </fieldset>
  );
  const names = Object.fromEntries(available);
  const suggested = SUGGESTED[state];
  const field = (
    id: string,
    text: React.ReactNode,
    control: React.ReactNode,
  ) => (
    <div className="field">
      <label htmlFor={id}>{text}</label>
      {control}
    </div>
  );
  return (
    <div className="actions">
      <div className="actions__groups">
        {GROUPS.map(([group, keys]) => {
          const present = keys.filter((k) => names[k]);
          if (!present.length) return null;
          return (
            <div className="actions__group" key={group}>
              <span className="caps">{group}</span>
              <div className="actions__buttons">
                {present.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`action${key === suggested ? " action--suggested" : ""}`}
                    aria-pressed={open === key}
                    aria-expanded={open === key}
                    aria-controls={open === key ? "action-form" : undefined}
                    onClick={() => setOpen(open === key ? null : key)}
                  >
                    {names[key]}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {open && (
        <form
          onSubmit={submit}
          className="action-form"
          id="action-form"
          aria-label={names[open]}
        >
          <p className="action-form__title">{names[open]}</p>
          {open === "provide_information" && (
            <>
              {docs}
              <div className="action-form__row">
                {field(
                  "act-external-id",
                  "Patient record ID in destination system",
                  <input
                    id="act-external-id"
                    value={extra.patient_external_id ?? ""}
                    onChange={set("patient_external_id")}
                  />,
                )}
                {field(
                  "act-service",
                  "Requested service code",
                  <input
                    id="act-service"
                    className="mono"
                    value={extra.requested_service ?? ""}
                    onChange={set("requested_service")}
                    placeholder="e.g. ORTHO_CONSULT"
                  />,
                )}
                {field(
                  "act-referral-date",
                  "Referral date",
                  <input
                    id="act-referral-date"
                    type="date"
                    value={extra.referral_date ?? ""}
                    onChange={set("referral_date")}
                  />,
                )}
              </div>
            </>
          )}
          {open === "upload" && (
            <>
              {field(
                "act-file",
                "File (PDF or text)",
                <input
                  id="act-file"
                  type="file"
                  accept="application/pdf,text/plain"
                  onChange={(e) =>
                    setExtra({ ...extra, file: e.target.files?.[0] })
                  }
                />,
              )}
              {docs}
              {field(
                "act-supplied-by",
                "Supplied by",
                <select
                  id="act-supplied-by"
                  value={extra.actor_type ?? "STAFF"}
                  onChange={set("actor_type")}
                >
                  <option value="STAFF">Staff</option>
                  <option value="PATIENT">Patient</option>
                  <option value="PROVIDER">Referring provider</option>
                </select>,
              )}
            </>
          )}
          {open === "status_contact" &&
            field(
              "act-enquiry-from",
              "Enquiry from",
              <select
                id="act-enquiry-from"
                value={extra.actor_type ?? "PATIENT"}
                onChange={set("actor_type")}
              >
                <option value="PATIENT">Patient</option>
                <option value="PROVIDER">Referring provider</option>
              </select>,
            )}
          {open === "record_destination_reference" &&
            field(
              "act-destination-ref",
              "Reference in the destination system (after you entered the referral there)",
              <input
                id="act-destination-ref"
                className="mono"
                required
                value={extra.destination_reference ?? ""}
                onChange={set("destination_reference")}
              />,
            )}
          {open === "record_booking" && (
            <div className="action-form__row">
              {field(
                "act-booked-at",
                "Appointment booked at (when the booking was made)",
                <input
                  id="act-booked-at"
                  type="datetime-local"
                  step={1}
                  required
                  value={extra.occurred_at ?? ""}
                  onChange={set("occurred_at")}
                />,
              )}
              {field(
                "act-appointment-ref",
                <>
                  Appointment reference{" "}
                  <span className="optional">(optional)</span>
                </>,
                <input
                  id="act-appointment-ref"
                  className="mono"
                  value={extra.appointment_reference ?? ""}
                  onChange={set("appointment_reference")}
                />,
              )}
            </div>
          )}
          {(open === "close" || open === "reject") &&
            field(
              "act-resolution-code",
              "Resolution code",
              <select
                id="act-resolution-code"
                required
                value={extra.resolution_code ?? ""}
                onChange={set("resolution_code")}
              >
                <option value="" disabled>
                  Choose…
                </option>
                {(open === "reject"
                  ? ["INVALID_REFERRAL", "DUPLICATE_REFERRAL"]
                  : CLOSE_CODES
                ).map((code) => (
                  <option key={code} value={code}>
                    {RESOLUTION_LABELS[code]}
                  </option>
                ))}
              </select>,
            )}
          {open === "resolve_exception" && (
            <>
              {field(
                "act-work-item",
                "Work item",
                <select
                  id="act-work-item"
                  required
                  value={extra.work_item_id ?? ""}
                  onChange={set("work_item_id")}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  {items.map((w: any) => (
                    <option key={w.id} value={w.id}>
                      {label(w.kind)}: {w.reason}
                    </option>
                  ))}
                </select>,
              )}
              {field(
                "act-resolution",
                "Resolution",
                <select
                  id="act-resolution"
                  required
                  value={extra.resolution ?? ""}
                  onChange={set("resolution")}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="safety_reviewed">
                    Safety review completed by clinician (hold released)
                  </option>
                  <option value="file_reviewed">Rejected file reviewed</option>
                  <option value="acknowledge">
                    Acknowledge (review, follow-up, escalation)
                  </option>
                  <option value="retry_destination">
                    Retry automated destination
                  </option>
                </select>,
              )}
              {extra.resolution === "retry_destination" && (
                <label className="check check--attest">
                  <input
                    type="checkbox"
                    checked={Boolean(extra.attest_not_committed)}
                    onChange={(e) =>
                      setExtra({
                        ...extra,
                        attest_not_committed: e.target.checked,
                      })
                    }
                  />
                  I checked the destination system and this referral is NOT
                  already there
                </label>
              )}
            </>
          )}
          {open === "correct_outcome" &&
            field(
              "act-observation",
              "Observation that establishes the correct outcome",
              <select
                id="act-observation"
                required
                value={extra.observation_id ?? ""}
                onChange={set("observation_id")}
              >
                <option value="" disabled>
                  Choose…
                </option>
                {reviewObservations.map((o: any) => (
                  <option key={o.id} value={o.id}>
                    {label(o.observation_type)} · {label(o.source_type)} ·{" "}
                    {when(o.occurred_at)}
                  </option>
                ))}
              </select>,
            )}
          {field(
            "act-note",
            "Note (required)",
            <textarea
              id="act-note"
              required
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
            />,
          )}
          {field(
            "act-seconds",
            <>
              Handling time in seconds{" "}
              <span className="optional">
                (optional; left blank it stays unknown)
              </span>
            </>,
            <input
              id="act-seconds"
              className="action-form__seconds"
              type="number"
              min={1}
              max={86400}
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
            />,
          )}
          <div className="action-form__submit">
            <button className="btn" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setOpen(null)}
            >
              Cancel
            </button>
          </div>
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
