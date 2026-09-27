import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { CaseLine, isTerminal, StateBadge } from "../components/AccessLine";
import { Icon } from "../components/Icon";
import { measureText, ProvenanceTag } from "../components/Provenance";
import {
  CASE_TYPE_LABELS,
  duration,
  kindLabel,
  label,
  reasonLabel,
  RESOLUTION_LABELS,
  roleLabel,
  sourceLabel,
  STATE_LABELS,
  stamp,
  when,
  WORKFLOW_LABELS,
} from "../format";
import { useSession } from "../session";
import type { CaseView, Measure, WorkItem } from "../types";
import { BookingPanel, ReferralBooking, stepRunning } from "./Booking";
import { Actions } from "./CaseActions";

/** What the state means, in plain administrative words. */
const SITUATION: Record<string, string> = {
  RECEIVED: "ACCESS is processing this referral.",
  IDENTITY_PENDING: "The patient has not been matched with enough confidence.",
  INFORMATION_MISSING: "Information that the rule set requires is missing.",
  READY: "Administratively complete and ready for the destination system.",
  DESTINATION_PENDING: "Being written to the destination system.",
  READY_FOR_BOOKING: "In the destination system and ready to book.",
  WAITING: "Booking requested; waiting for a booking or the patient's reply.",
  BOOKED: "An appointment is booked.",
  CLOSED: "Closed without a booking.",
  EXCEPTION: "Held for a person to review.",
  REJECTED: "Rejected.",
};
/** Appointment operations cases: what the request is for. */
const REQUEST_SITUATION: Record<string, string> = {
  APPOINTMENT_REQUEST:
    "Booking an appointment for a referral. Each step is sent to the destination system by ACCESS.",
  RESCHEDULING_REQUEST:
    "Moving a booked appointment. The new one is booked and checked in the destination system before the original is cancelled.",
  CANCELLATION_REQUEST:
    "Cancelling a booked appointment in the destination system.",
};
const words = (text: string) => text.replace(/_/g, " ");
const TIMELINE_PREVIEW = 8;

export function CaseDetail({
  caseId,
  back,
}: {
  caseId: string;
  back: () => void;
}) {
  const session = useSession();
  const [view, setView] = useState<CaseView | null>(null);
  const [error, setError] = useState("");
  const head = useRef<HTMLElement>(null);
  const [headHidden, setHeadHidden] = useState(false);
  const load = useCallback(
    () =>
      api<CaseView>(session.headers, `/v1/cases/${caseId}`)
        .then(setView)
        .catch((e: Error) => setError(e.message)),
    [caseId, session.headers],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // While ACCESS is working with the destination, the page follows it.
  const request = view?.appointment_request ?? null;
  const running = stepRunning(request);
  const holdEnds =
    request?.workflow_status === "HELD" && request.hold?.status === "ACTIVE"
      ? new Date(request.hold.expires_at).getTime()
      : null;
  useEffect(() => {
    if (!view) return;
    const delay = running
      ? 2000
      : holdEnds
        ? Math.max(2000, holdEnds - Date.now() + 6000)
        : null;
    if (delay === null) return;
    const t = setTimeout(() => void load(), delay);
    return () => clearTimeout(t);
  }, [view, running, holdEnds, load]);
  useEffect(() => {
    if (view) document.title = `${view.case.display_ref} · ACCESS`;
  }, [view]);
  // A compact case bar takes over once the full header scrolls away.
  const hasView = view !== null;
  useEffect(() => {
    const el = head.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setHeadHidden(!entry!.isIntersecting),
      { rootMargin: "-72px 0px 0px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasView]);

  const backButton = (
    <button type="button" className="btn btn-quiet case-back" onClick={back}>
      <Icon name="back" size={18} />
      Back to queue
    </button>
  );
  if (error)
    return (
      <div className="case">
        {backButton}
        <p className="alert" role="alert">
          {error}
        </p>
      </div>
    );
  if (!view)
    return (
      <div className="case">
        {backButton}
        <p className="loading">Loading case…</p>
      </div>
    );

  const c = view.case;
  const r = view.referral;
  const state = c.current_state;
  const req = view.appointment_request;
  const appointmentCase = (c.case_type ?? "REFERRAL") !== "REFERRAL" && !!req;
  const stateText =
    appointmentCase && req
      ? state === "EXCEPTION"
        ? "Needs attention"
        : WORKFLOW_LABELS[req.workflow_status]
      : undefined;
  const openItems = view.work_items.filter((w) => w.status === "OPEN");
  const doneItems = view.work_items.filter((w) => w.status !== "OPEN");
  const hold = openItems.find(
    (w) => w.kind === "SAFETY" || w.kind === "FILE_SAFETY",
  );
  const owners = [
    ...new Set(openItems.map((w) => w.owner_role).filter(Boolean)),
  ] as string[];
  const owner = owners.length
    ? owners.map(roleLabel).join(", ")
    : roleLabel(c.current_owner);
  const terminal = isTerminal(state);

  return (
    <article className="case" aria-labelledby="case-title">
      <div className="case-bar-anchor">
        <div
          className="case-bar"
          data-visible={headHidden}
          aria-hidden={!headHidden}
        >
          <span className="case-bar__ref mono">{c.display_ref}</span>
          <StateBadge state={state} text={stateText} />
          <span className="case-bar__action">
            {terminal ? outcomeSentence(view) : words(view.next_action)}
          </span>
          {!terminal && <span className="case-bar__owner">{owner}</span>}
        </div>
      </div>
      <header className="case-head" ref={head}>
        {backButton}
        <div className="case-head__id">
          <h1 className="case-ref mono" id="case-title">
            {c.display_ref}
          </h1>
          <StateBadge state={state} large text={stateText} />
        </div>
        <p className="case-meta">
          {appointmentCase && req && (
            <span className="case-meta__kind">
              {CASE_TYPE_LABELS[req.case_type]}
              {req.origin_display_ref && (
                <>
                  {" "}
                  for referral{" "}
                  <a
                    className="mono"
                    href={`#/case/${req.origin_referral_case_id}`}
                  >
                    {req.origin_display_ref}
                  </a>
                </>
              )}
            </span>
          )}
          <span>Opened {when(c.opened_at)}</span>
          <span>Case owner {roleLabel(c.current_owner)}</span>
          {!appointmentCase && <span>Via {label(c.source_channel)}</span>}
          {!appointmentCase && view.access_status && (
            <span>Status: {view.access_status.label}</span>
          )}
          <span>Version {c.version}</span>
        </p>
        {hold && <SafetyHold item={hold} />}
        {!appointmentCase && <CaseLine view={view} />}
      </header>

      <div className="case-grid">
        <div className="case-main">
          <section className="panel now o-now" aria-labelledby="now-title">
            <div className="now__lead">
              <p className="caps" id="now-title">
                {terminal ? "Outcome" : "Next required action"}
              </p>
              <p className="now__action">
                {terminal ? outcomeSentence(view) : words(view.next_action)}
              </p>
              <p className="now__situation">
                {appointmentCase && req
                  ? REQUEST_SITUATION[req.case_type]
                  : SITUATION[state]}
              </p>
              {!terminal && (
                <p className="now__owner">
                  <Icon name="account" size={16} />
                  Owner: <strong>{owner}</strong>
                </p>
              )}
            </div>
            {openItems.length > 0 && (
              <div className="blockers">
                <h2 className="blockers__title">
                  Blocking progress ({openItems.length})
                </h2>
                <ul>
                  {openItems.map((w) => (
                    <WorkRow key={w.id} item={w} />
                  ))}
                </ul>
              </div>
            )}
            {!appointmentCase && (
              <div className="now__actions">
                <h2 className="vh">Actions</h2>
                <Actions view={view} onDone={load} />
                <p className="now__boundary">
                  ACCESS records administrative decisions only. Clinical
                  judgements stay with clinicians and are never made here.
                </p>
              </div>
            )}
            {doneItems.length > 0 && (
              <details className="disclosure now__history">
                <summary>
                  Resolved work items ({doneItems.length})
                  <Icon
                    name="chevron"
                    size={18}
                    className="disclosure__caret"
                  />
                </summary>
                <ul>
                  {doneItems.map((w) => (
                    <WorkRow key={w.id} item={w} />
                  ))}
                </ul>
              </details>
            )}
          </section>

          {appointmentCase ? (
            <div className="o-booking">
              <BookingPanel view={view} onDone={load} />
              <p className="now__boundary booking__boundary">
                ACCESS offers the slots the destination system returns and books
                only what staff choose. It never decides clinical urgency,
                priority or suitability.
              </p>
            </div>
          ) : (
            <div className="o-booking">
              <ReferralBooking view={view} onDone={load} />
            </div>
          )}

          {!appointmentCase && (
            <div className="case-facts o-facts">
              <Panel title="Referral">
                {r ? (
                  <dl className="facts">
                    <dt>Patient</dt>
                    <dd>
                      {typeof r.extraction?.patient === "object" ? (
                        <span className="patient">
                          <strong>
                            {r.extraction.patient.given_name}{" "}
                            {r.extraction.patient.family_name}
                          </strong>
                          <span>Born {r.extraction.patient.date_of_birth}</span>
                          <span>
                            {r.extraction.patient.external_id
                              ? `Record ID ${r.extraction.patient.external_id}`
                              : "No patient record ID"}
                          </span>
                        </span>
                      ) : r.extraction ? (
                        "Restricted for your role"
                      ) : (
                        "Not yet captured"
                      )}
                    </dd>
                    <dt>Referring provider</dt>
                    <dd>{r.referring_provider ?? "Not recorded"}</dd>
                    <dt>Requested service</dt>
                    <dd>
                      {(r.requested_service ??
                      r.rule_decision?.service?.code) ? (
                        <code>
                          {r.requested_service ??
                            r.rule_decision?.service?.code}
                        </code>
                      ) : (
                        "Not recorded"
                      )}
                    </dd>
                    <dt>Identity</dt>
                    <dd>
                      {r.identity_status
                        ? label(r.identity_status)
                        : "Not evaluated"}
                      {r.identity_confirmed_by && " (confirmed by staff)"}
                    </dd>
                    <dt>Completeness</dt>
                    <dd>{label(r.completeness_status)}</dd>
                    <dt>Documents held</dt>
                    <dd>
                      <Documents
                        list={[
                          ...new Set([
                            ...(r.extraction?.documents ?? []),
                            ...(r.supplied_documents ?? []),
                          ]),
                        ]}
                      />
                    </dd>
                    {r.extraction?.provenance === "STAFF_ENTERED" && (
                      <>
                        <dt>Field provenance</dt>
                        <dd>Entered by staff (human-attested)</dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <p className="muted">No referral details.</p>
                )}
              </Panel>
              <Panel title="Administrative rule decision">
                {r?.rule_decision ? (
                  <dl className="facts">
                    <dt>Rule set</dt>
                    <dd>
                      Version {r.rule_set_version} ·{" "}
                      <code>
                        {r.rule_decision.definition_hash.slice(0, 12)}
                      </code>
                    </dd>
                    <dt>Outcome</dt>
                    <dd>{label(r.rule_decision.outcome)}</dd>
                    <dt>Identity</dt>
                    <dd>{label(r.rule_decision.identity.reason)}</dd>
                    <dt>Missing</dt>
                    <dd>
                      {[
                        ...r.rule_decision.missing_documents,
                        ...r.rule_decision.missing_fields,
                        ...r.rule_decision.unmet_prerequisites,
                      ]
                        .map(label)
                        .join(", ") || "Nothing"}
                    </dd>
                    <dt>Routing</dt>
                    <dd>
                      {r.rule_decision.routing
                        ? `${r.rule_decision.routing.destination_queue} ${r.rule_decision.routing.location ?? ""}`
                        : "Default"}
                    </dd>
                    <dt>Decision hash</dt>
                    <dd>
                      <code>{r.rule_decision.decision_hash.slice(0, 16)}</code>
                    </dd>
                  </dl>
                ) : (
                  <p className="muted">
                    No rule decision (held for review before evaluation).
                  </p>
                )}
              </Panel>
            </div>
          )}

          <Timeline view={view} />

          <details
            className="panel disclosure evidence o-evidence"
            open={!view.evidence.verification.valid}
          >
            <summary>
              <span className="section-title">Evidence chain</span>
              <span
                className={
                  view.evidence.verification.valid
                    ? "evidence__status"
                    : "evidence__status evidence__status--failed"
                }
              >
                {view.evidence.verification.valid
                  ? "Verified"
                  : "VERIFICATION FAILED"}
              </span>
              <span className="muted small">
                {view.evidence.verification.events} events
              </span>
              <Icon name="chevron" size={18} className="disclosure__caret" />
            </summary>
            <ol className="events evidence__list">
              {view.evidence.events.map((e) => (
                <li key={e.sequence}>
                  <span>
                    <span className="evidence__seq mono">#{e.sequence}</span>{" "}
                    {label(e.event_type)}
                  </span>
                  <time dateTime={e.created_at}>{when(e.created_at)}</time>
                  <small>
                    {e.actor_type
                      ? `${label(e.actor_type)} ${e.actor_id}`
                      : "legacy"}{" "}
                    · v{e.aggregate_version} ·{" "}
                    <code>{e.hash.slice(0, 12)}</code>
                  </small>
                </li>
              ))}
            </ol>
          </details>
        </div>

        <aside
          className="case-side"
          aria-label="Destination, outcome and measures"
        >
          {appointmentCase ? (
            <DestinationActivity view={view} />
          ) : (
            <>
              <Destination view={view} />
              <Outcome view={view} />
              <Measures view={view} />
            </>
          )}
        </aside>
      </div>
    </article>
  );
}

const FINISHED_FLOWS = ["BOOKED", "COMPLETED", "CANCELLED", "WITHDRAWN"];
function outcomeSentence(view: CaseView): string {
  const c = view.case;
  if (!c.resolution_code)
    return STATE_LABELS[c.current_state] ?? c.current_state;
  // A finished appointment request says what happened to the appointment
  // ("Rescheduled"), not only how the case resolved ("Booked").
  const flow = view.appointment_request?.workflow_status;
  const done =
    flow && FINISHED_FLOWS.includes(flow) ? WORKFLOW_LABELS[flow] : undefined;
  return `${done ?? RESOLUTION_LABELS[c.resolution_code] ?? label(c.resolution_code)}${
    c.outcome_at ? `, ${stamp(c.outcome_at)}` : ""
  }`;
}

function SafetyHold({ item }: { item: WorkItem }) {
  const clinical = item.kind === "SAFETY";
  return (
    <section className="safety" aria-labelledby="safety-title">
      <Icon name={clinical ? "shield" : "alert"} size={22} />
      <div>
        <h2 id="safety-title">
          {clinical ? "Clinical safety hold" : "File held by the safety scan"}
        </h2>
        <p>
          {clinical
            ? "Flagged as possibly urgent or clinical. ACCESS has not processed this referral and does not assess clinical content. A clinician must review it before the hold is released."
            : "An uploaded file was rejected by the malware scan and has not been processed. Review the rejected file before continuing."}
        </p>
        <p className="safety__meta">
          Owner {roleLabel(item.owner_role)} · raised {when(item.created_at)} ·{" "}
          {reasonLabel(item.reason)}
        </p>
      </div>
    </section>
  );
}

function WorkRow({ item }: { item: WorkItem }) {
  const open = item.status === "OPEN";
  return (
    <li className={`work-row${open ? " work-row--open" : ""}`}>
      <span className="work-row__kind">{kindLabel(item.kind)}</span>
      <span className="work-row__reason">{reasonLabel(item.reason)}</span>
      <span className="work-row__meta">
        {open
          ? `Owner ${roleLabel(item.owner_role)} · opened ${stamp(item.created_at)}${item.due_at ? ` · due ${stamp(item.due_at)}` : ""}`
          : `Resolved ${stamp(item.resolved_at)}${item.resolved_by ? ` by ${item.resolved_by}` : ""}`}
      </span>
    </li>
  );
}

function Documents({ list }: { list: string[] }) {
  if (!list.length) return <>None recorded</>;
  return (
    <ul className="docs">
      {list.map((d) => (
        <li key={d}>
          <Icon name="document" size={16} />
          {label(d)}
        </li>
      ))}
    </ul>
  );
}

function Destination({ view }: { view: CaseView }) {
  const r = view.referral;
  return (
    <Panel title="Destination" className="o-destination">
      <dl className="facts facts--stacked">
        <dt>Mode</dt>
        <dd>
          {r?.destination_mode === "CONNECTOR"
            ? "Automated connector"
            : r?.destination_mode === "MANUAL"
              ? "Manual entry by staff"
              : "Not decided yet"}
        </dd>
        <dt>Reference</dt>
        <dd>
          {r?.destination_reference ? (
            <>
              <code>{r.destination_reference}</code>{" "}
              <span className="muted">
                (
                {r.destination_reference_source === "MANUAL"
                  ? "manual entry"
                  : "connector"}
                )
              </span>
            </>
          ) : (
            "Not committed yet"
          )}
        </dd>
      </dl>
      {view.executions.length > 0 && (
        <ul className="executions">
          {view.executions.map((x) => (
            <li key={x.id}>
              <span className="executions__op">
                {x.operation} · {x.status}
                {x.escalated_at && " (escalated to staff)"}
                {x.superseded_at &&
                  ` (settled by staff: ${label(x.superseded_reason ?? "")})`}
              </span>
              <span className="muted small">
                Execution <code>{x.id.slice(0, 8)}</code> · attempts{" "}
                {x.attempts} · reconciliations {x.reconcile_attempts}
                {x.last_error && ` · ${x.last_error}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {view.executions.length === 0 && (
        <p className="muted small">No automated destination action.</p>
      )}
    </Panel>
  );
}

/** Destination steps of an appointment request, in plain words. */
const OPERATION_WORDS: Record<string, string> = {
  "appointment.availability.read": "Availability search",
  "appointment.hold": "Hold",
  "appointment.hold.release": "Hold let go",
  "appointment.create": "Booking",
  "appointment.verify": "Booking check",
  "appointment.reschedule": "New appointment",
  "appointment.reschedule.cancel_original": "Cancel original",
  "appointment.cancel": "Cancellation",
};
function stepStatus(x: CaseView["executions"][number]): string {
  if (x.planned) return "Planned: waits for the step before";
  if (x.superseded_at)
    return x.superseded_reason === "plan_cancelled"
      ? "Not needed"
      : "Settled by staff";
  switch (x.status) {
    case "SUCCEEDED":
      return "Done";
    case "PENDING":
    case "LEASED":
      return "Sending";
    case "RETRYABLE":
      return "Retrying (known not sent)";
    case "RECONCILING":
      return "Checking with the destination";
    case "AMBIGUOUS":
      return x.escalated_at
        ? "Unconfirmed: staff check needed"
        : "Unconfirmed: checking";
    case "PERMANENT":
      return x.last_error === "NOT_ATTEMPTED"
        ? "Not needed"
        : x.last_error === "CONFIRMED_NOT_COMMITTED"
          ? "Confirmed not done"
          : "Refused";
    case "POISON":
      return "Failed after retries";
    default:
      return label(x.status);
  }
}
function DestinationActivity({ view }: { view: CaseView }) {
  const steps = view.executions;
  return (
    <Panel title="Destination system" className="o-destination">
      {steps.length === 0 ? (
        <p className="muted small">Nothing sent yet.</p>
      ) : (
        <ol className="executions">
          {steps.map((x) => (
            <li key={x.id}>
              <span className="executions__op">
                {OPERATION_WORDS[x.operation] ?? label(x.operation)}
              </span>
              <span className="muted small">
                {stepStatus(x)} · {stamp(x.created_at)}
                {x.attempts > 1 && ` · ${x.attempts} attempts`}
                {x.reconcile_attempts > 0 &&
                  ` · checked ${x.reconcile_attempts}×`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function Outcome({ view }: { view: CaseView }) {
  const c = view.case;
  const r = view.referral;
  const due =
    r?.follow_up_due_at && !isTerminal(c.current_state)
      ? r.follow_up_due_at
      : null;
  return (
    <Panel title="Booking and outcome" className="o-outcome">
      <dl className="facts facts--stacked">
        {view.access_status && (
          <>
            <dt>Status</dt>
            <dd>{view.access_status.label}</dd>
          </>
        )}
        <dt>Outcome</dt>
        <dd>
          {c.resolution_code ? (
            <>
              <strong>{RESOLUTION_LABELS[c.resolution_code]}</strong>{" "}
              <span className="muted">
                ({sourceLabel(c.resolution_source ?? "unknown")},{" "}
                {when(c.outcome_at)})
              </span>
            </>
          ) : (
            "Not yet booked or closed"
          )}
        </dd>
        <dt>Follow-ups</dt>
        <dd>
          {r?.follow_up_count ?? 0} recorded
          {due &&
            ` · next due ${stamp(due)}${new Date(due).getTime() <= Date.now() ? " (overdue)" : ""}`}
        </dd>
      </dl>
    </Panel>
  );
}

const MEASURE_NAMES: Record<string, string> = {
  received_to_verified_seconds: "Received to verified",
  verified_to_destination_seconds: "Verified to destination",
  received_to_ready_for_booking_seconds: "Received to ready for booking",
  received_to_booked_seconds: "Received to booked",
  staff_seconds: "Staff time",
  human_touch_count: "Human touches",
  status_enquiry_count: "Status enquiries",
  follow_up_count: "Follow-ups",
  correction_count: "Corrections",
  exception_count: "Exceptions",
  booking_conversion: "Booked",
  closure_reason: "Closure reason",
};

function Measures({ view }: { view: CaseView }) {
  const rows = Object.entries(view.metrics).filter(
    ([k, m]) => k !== "case_id" && typeof m === "object",
  ) as [string, Measure<number | boolean | string>][];
  return (
    <Panel title="Business measures" className="o-measures">
      <ul className="measures">
        {rows.map(([k, m]) => (
          <li key={k} title={m.basis}>
            <span className="measures__name">
              {MEASURE_NAMES[k] ?? label(k)}
            </span>
            <span
              className={
                m.value === null
                  ? "measures__value unknown-value"
                  : "measures__value"
              }
            >
              {k.endsWith("_seconds")
                ? m.value === null
                  ? "Unknown"
                  : duration(m.value as number)
                : k === "closure_reason" && typeof m.value === "string"
                  ? (RESOLUTION_LABELS[m.value] ?? m.value)
                  : measureText(m)}
            </span>
            <ProvenanceTag value={m.provenance} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Who acted, in staff words: the destination system, ACCESS, or a person. */
function actorLabel(id: string): string {
  if (id.startsWith("connector:")) return "the destination system";
  if (id === "access-worker") return "ACCESS";
  return id;
}
function Timeline({ view }: { view: CaseView }) {
  const entries = [
    ...view.interactions.map((i) => ({
      at: i.received_at,
      kind: "Interaction",
      text: `${label(i.intent)} via ${label(i.channel)} (${label(i.actor_type)})`,
    })),
    ...view.observations.map((o) => ({
      at: o.occurred_at,
      kind: "Observation",
      text: `${label(o.observation_type)} · ${sourceLabel(o.source_type)} · ${o.verification_level.replace("_", "-").toLowerCase()} · ${o.disposition.toLowerCase()}${o.disposition_reason ? ` (${label(o.disposition_reason)})` : ""}`,
    })),
    ...view.transitions.map((t) => ({
      at: t.occurred_at,
      kind: "State",
      text: `${t.from_state ? STATE_LABELS[t.from_state] : "Opened"} → ${STATE_LABELS[t.to_state]} (${label(t.reason)}) by ${actorLabel(t.actor_id)}`,
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const row = (e: (typeof entries)[number], i: number) => (
    <li
      key={i}
      className={`timeline__entry timeline__entry--${e.kind.toLowerCase()}`}
    >
      <span className="timeline__kind">{e.kind}</span>
      <span className="timeline__text">{e.text}</span>
      <time dateTime={e.at}>{when(e.at)}</time>
    </li>
  );
  const recent = entries.slice(0, TIMELINE_PREVIEW);
  const earlier = entries.slice(TIMELINE_PREVIEW);
  return (
    <Panel title="History" note="Latest first" className="o-history">
      <ol className="events timeline">{recent.map(row)}</ol>
      {earlier.length > 0 && (
        <details className="disclosure timeline__more">
          <summary>
            Show {earlier.length} earlier{" "}
            {earlier.length === 1 ? "entry" : "entries"}
            <Icon name="chevron" size={18} className="disclosure__caret" />
          </summary>
          <ol className="events timeline">
            {earlier.map((e, i) => row(e, i + TIMELINE_PREVIEW))}
          </ol>
        </details>
      )}
    </Panel>
  );
}

function Panel(p: {
  title: string;
  note?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`panel case-panel ${p.className ?? ""}`}>
      <div className="panel__head">
        <h2 className="section-title">{p.title}</h2>
        {p.note && <span className="muted small">{p.note}</span>}
      </div>
      <div className="panel__body">{p.children}</div>
    </section>
  );
}
