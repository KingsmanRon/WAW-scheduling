import React, { useEffect, useState } from "react";
import { api, newIds } from "../api";
import { Icon } from "../components/Icon";
import { label, roleLabel, STATE_LABELS, when } from "../format";
import { PageHeader } from "../layout/PageHeader";
import { useSession } from "../session";
import type { RuleDefinition, RuleSet } from "../types";

type Window = "in-force" | "scheduled" | "ended" | "draft" | "retired";
function windowOf(s: RuleSet, now = Date.now()): Window {
  if (s.status === "DRAFT") return "draft";
  if (s.status === "RETIRED") return "retired";
  const from = s.effective_from ? new Date(s.effective_from).getTime() : 0;
  const to = s.effective_to ? new Date(s.effective_to).getTime() : Infinity;
  if (from > now) return "scheduled";
  return to > now ? "in-force" : "ended";
}
const WINDOW_TEXT: Record<Window, string> = {
  "in-force": "In force now",
  scheduled: "Scheduled",
  ended: "Superseded",
  draft: "Not published",
  retired: "Retired",
};
const fieldLabel = (path: string) =>
  path
    .split(".")
    .map(label)
    .join(" ")
    .replace(/ (\w)/g, (m) => m.toLowerCase());

export function Rules() {
  const session = useSession();
  const [sets, setSets] = useState<RuleSet[] | null>(null);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const load = () =>
    api<RuleSet[]>(session.headers, "/v1/rule-sets")
      .then(setSets)
      .catch((e: Error) => setMessage(e.message));
  useEffect(() => {
    void load();
  }, []);
  const admin = session.me?.role === "ADMIN";
  const publish = async (s: RuleSet) => {
    try {
      await api(session.headers, `/v1/rule-sets/${s.id}/publish`, {
        method: "POST",
        body: { command_id: newIds().command_id },
      });
      await load();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };
  const current = sets?.find((s) => windowOf(s) === "in-force");
  const others = sets?.filter((s) => s !== current) ?? [];

  return (
    <div className="rules">
      <PageHeader
        title="Rules"
        context="Administrative rule sets are versioned and immutable once published. Every case records the version and hash it was decided under. Rule sets cannot express clinical triage, urgency or diagnosis."
      />
      {message && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      {!sets ? (
        !message && <p className="loading">Loading rule sets…</p>
      ) : (
        <>
          {current ? (
            <section
              className="ruleset ruleset--current panel"
              aria-labelledby="ruleset-current"
            >
              <VersionHeader set={current} id="ruleset-current" />
              <Definition definition={current.definition} />
              <RawDefinition set={current} />
            </section>
          ) : (
            <p className="panel empty">
              <strong>No rule set is in force.</strong>
              <span>
                New referrals cannot be evaluated until a version is published.
              </span>
            </p>
          )}
          {others.length > 0 && (
            <section className="versions" aria-labelledby="versions-title">
              <h2 className="section-title" id="versions-title">
                Other versions
              </h2>
              {others.map((s) => (
                <article className="ruleset panel" key={s.id}>
                  <VersionHeader
                    set={s}
                    action={
                      s.status === "DRAFT" && admin ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => void publish(s)}
                        >
                          Publish now
                        </button>
                      ) : undefined
                    }
                  />
                  <details className="disclosure ruleset__more">
                    <summary>
                      Show configuration
                      <Icon
                        name="chevron"
                        size={18}
                        className="disclosure__caret"
                      />
                    </summary>
                    <Definition definition={s.definition} />
                    <RawDefinition set={s} />
                  </details>
                </article>
              ))}
            </section>
          )}
        </>
      )}
      {admin && (
        <form
          className="panel draft"
          onSubmit={async (e) => {
            e.preventDefault();
            setMessage("");
            try {
              await api(session.headers, "/v1/rule-sets", {
                method: "POST",
                body: {
                  command_id: newIds().command_id,
                  definition: JSON.parse(draft),
                },
              });
              setDraft("");
              await load();
            } catch (err) {
              setMessage((err as Error).message);
            }
          }}
        >
          <h2 className="section-title">New draft version</h2>
          <p className="muted small">
            Paste an access-rules.v1 definition. It is validated, normalised and
            hashed; publishing is a separate step.
          </p>
          <label htmlFor="draft-definition" className="vh">
            Rule set definition (JSON)
          </label>
          <textarea
            id="draft-definition"
            className="mono"
            rows={14}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste an access-rules.v1 definition (JSON)"
          />
          <button className="btn">Validate and save draft</button>
        </form>
      )}
    </div>
  );
}

function VersionHeader({
  set,
  id,
  action,
}: {
  set: RuleSet;
  id?: string;
  action?: React.ReactNode;
}) {
  const w = windowOf(set);
  return (
    <header className="ruleset__head">
      <div className="ruleset__title">
        <h2 id={id}>Version {set.version}</h2>
        <span
          className={`rule-status rule-status--${set.status.toLowerCase()}`}
        >
          {set.status}
        </span>
        <span className={`rule-window rule-window--${w}`}>
          {WINDOW_TEXT[w]}
        </span>
      </div>
      <dl className="ruleset__meta">
        <div>
          <dt>Effective</dt>
          <dd>
            {when(set.effective_from)} to{" "}
            {set.effective_to ? when(set.effective_to) : "open"}
          </dd>
        </div>
        <div>
          <dt>Published by</dt>
          <dd>{set.published_by ?? "Not published"}</dd>
        </div>
        <div>
          <dt>Definition hash</dt>
          <dd>
            <code title={set.definition_hash}>
              {set.definition_hash.slice(0, 12)}
            </code>
          </dd>
        </div>
      </dl>
      {action && <div className="ruleset__action">{action}</div>}
    </header>
  );
}

function List({ items, empty = "None" }: { items: string[]; empty?: string }) {
  if (!items.length) return <span className="muted">{empty}</span>;
  return (
    <ul className="rule-list">
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

function Definition({ definition: d }: { definition: RuleDefinition }) {
  const services = d.services ?? [];
  const prerequisites = d.administrative_prerequisites ?? [];
  const escalation = d.escalation ?? [];
  const ownership = Object.entries(d.exception_ownership ?? {});
  return (
    <div className="rule-sections">
      <section className="rule-section">
        <h3>Identity</h3>
        <dl className="facts">
          <dt>Minimum match confidence</dt>
          <dd>
            {d.identity?.min_confidence !== undefined
              ? `${Math.round(d.identity.min_confidence * 100)}%`
              : "Not set"}
          </dd>
          <dt>Patient record ID required</dt>
          <dd>{d.identity?.require_external_id ? "Yes" : "No"}</dd>
        </dl>
      </section>
      <section className="rule-section">
        <h3>Administrative requirements</h3>
        <dl className="facts">
          <dt>Required fields</dt>
          <dd>
            <List items={(d.required_fields ?? []).map(fieldLabel)} />
          </dd>
          <dt>Required documents</dt>
          <dd>
            <List items={(d.required_documents ?? []).map(label)} />
          </dd>
          <dt>Medical aid</dt>
          <dd>
            <List
              items={[
                ...(d.medical_aid?.required_documents ?? []).map(label),
                ...(d.medical_aid?.required_fields ?? []).map(fieldLabel),
              ]}
              empty="No extra requirements"
            />
          </dd>
          <dt>Unknown service</dt>
          <dd>
            {d.unknown_service === "DEFAULT_ROUTE"
              ? "Use the default route"
              : "Hold as information missing"}
            {d.default_route &&
              ` · default route ${d.default_route.destination_queue}${d.default_route.location ? ` (${d.default_route.location})` : ""}`}
          </dd>
        </dl>
        {prerequisites.length > 0 && (
          <table className="rule-table">
            <caption>Administrative prerequisites</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Description</th>
                <th scope="col">Needs</th>
              </tr>
            </thead>
            <tbody>
              {prerequisites.map((p) => (
                <tr key={p.code}>
                  <td className="mono">{p.code}</td>
                  <td>{p.description}</td>
                  <td>
                    {p.document
                      ? label(p.document)
                      : p.field
                        ? fieldLabel(p.field)
                        : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {services.length > 0 && (
          <table className="rule-table">
            <caption>Services and routing</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Service</th>
                <th scope="col">Queue</th>
                <th scope="col">Extra documents</th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.code}>
                  <td className="mono">{s.code}</td>
                  <td>{s.label}</td>
                  <td>
                    {s.destination_queue}
                    {s.location ? ` (${s.location})` : ""}
                  </td>
                  <td>
                    {(s.required_documents ?? []).map(label).join(", ") ||
                      "None"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="rule-section">
        <h3>Booking requirements</h3>
        <dl className="facts">
          <dt>Destination reference before booking</dt>
          <dd>
            {d.booking_prerequisites?.require_destination_reference
              ? "Required"
              : "Not required"}
          </dd>
          <dt>Required fields</dt>
          <dd>
            <List
              items={(d.booking_prerequisites?.required_fields ?? []).map(
                fieldLabel,
              )}
            />
          </dd>
        </dl>
      </section>
      <section className="rule-section">
        <h3>Destination behaviour</h3>
        <dl className="facts">
          <dt>Mode</dt>
          <dd>
            {d.destination?.mode === "CONNECTOR"
              ? "Automated connector writes the referral"
              : d.destination?.mode === "MANUAL"
                ? "Staff enter the referral and record its reference"
                : "Not set"}
          </dd>
          <dt>Outcome polling</dt>
          <dd>
            {d.outcome_polling?.interval_minutes
              ? `Every ${d.outcome_polling.interval_minutes} minutes`
              : "Not set"}
          </dd>
        </dl>
      </section>
      <section className="rule-section">
        <h3>Follow-up and escalation</h3>
        <dl className="facts">
          <dt>Follow up when ready for booking</dt>
          <dd>
            {d.follow_up?.ready_for_booking_hours !== undefined
              ? `After ${d.follow_up.ready_for_booking_hours} hours`
              : "Not set"}
          </dd>
          <dt>Follow up when waiting</dt>
          <dd>
            {d.follow_up?.waiting_hours !== undefined
              ? `After ${d.follow_up.waiting_hours} hours`
              : "Not set"}
          </dd>
          <dt>Maximum follow-ups</dt>
          <dd>{d.follow_up?.max_follow_ups ?? "Not set"}</dd>
        </dl>
        {escalation.length > 0 && (
          <table className="rule-table">
            <caption>Escalation</caption>
            <thead>
              <tr>
                <th scope="col">When a case stays in</th>
                <th scope="col">For</th>
                <th scope="col">Escalate to</th>
              </tr>
            </thead>
            <tbody>
              {escalation.map((e) => (
                <tr key={e.state}>
                  <td>{STATE_LABELS[e.state] ?? label(e.state)}</td>
                  <td>{e.after_hours} hours</td>
                  <td>{roleLabel(e.owner)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {ownership.length > 0 && (
          <table className="rule-table">
            <caption>Exception ownership</caption>
            <thead>
              <tr>
                <th scope="col">Work item</th>
                <th scope="col">Owner</th>
              </tr>
            </thead>
            <tbody>
              {ownership.map(([kind, role]) => (
                <tr key={kind}>
                  <td>{label(kind)}</td>
                  <td>{roleLabel(role)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function RawDefinition({ set }: { set: RuleSet }) {
  return (
    <details className="disclosure raw">
      <summary>
        Raw definition (JSON)
        <Icon name="chevron" size={18} className="disclosure__caret" />
      </summary>
      <pre>{JSON.stringify(set.definition, null, 2)}</pre>
    </details>
  );
}
