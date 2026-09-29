import React, { useState } from "react";
import { label } from "../../format";
import { PageHeader } from "../../layout/PageHeader";
import { usePractice } from "../context";
import { useLink, type ViewProps } from "../PracticeApp";
import { fmt } from "../time";
import type { AuditEvent } from "../types";
import { Empty, ErrorNote, Loading, useLoad } from "../ui";
import { actorText } from "./AppointmentDetail";

const RESOURCES: [string, string][] = [
  ["appointment", "Appointments"],
  ["slot_hold", "Slot holds"],
  ["patient", "Patients"],
  ["patient_duplicate", "Duplicate reviews"],
  ["referral", "Referrals"],
  ["referral_document", "Referral documents"],
  ["waitlist_entry", "Waitlist entries"],
  ["waitlist_offer", "Waitlist offers"],
  ["conversation", "Conversations"],
  ["practitioner", "Practitioners"],
  ["location", "Locations"],
  ["appointment_type", "Appointment types"],
  ["availability_rule", "Working hours"],
  ["availability_exception", "Leave and exceptions"],
  ["schedule_block", "Blocked time"],
  ["practice", "Practice settings"],
  ["user", "Staff access"],
  ["integration_connection", "Integrations"],
];
const PAGE = 100;

interface Member {
  user_id: string;
  display_name: string;
}

/**
 * The practice's immutable audit trail: who did what, when, through which
 * channel, with the administrative fields that changed. Practice
 * administrators only; entries cannot be edited or removed.
 */
export function Audit({ route, go }: ViewProps) {
  const practice = usePractice();
  const link = useLink();
  const type = route.query.get("resource_type") ?? "";
  const id = route.query.get("resource_id");
  const [before, setBefore] = useState<string | null>(null);
  const list = useLoad(
    () =>
      practice.client.get<{
        items: AuditEvent[];
        next_before_id: string | null;
      }>("/audit-events", {
        resource_type: type || undefined,
        resource_id: id ?? undefined,
        before_id: before ?? undefined,
        limit: PAGE,
      }),
    [type, id, before, practice.tick],
  );
  const members = useLoad(
    async () =>
      practice.can("staff.manage")
        ? new Map(
            (
              await practice.client.get<{ items: Member[] }>("/memberships")
            ).items.map((m) => [m.user_id, m.display_name]),
          )
        : new Map<string, string>(),
    [],
  );
  const filter = (next: {
    resource_type?: string | null;
    resource_id?: string | null;
  }) => {
    setBefore(null);
    go(
      link("audit", null, {
        resource_type:
          next.resource_type === undefined ? type || null : next.resource_type,
        resource_id: next.resource_id === undefined ? id : next.resource_id,
      }),
    );
  };
  const who = (e: AuditEvent) => {
    const name =
      e.actor_type === "STAFF" ? members.data?.get(e.actor_id) : undefined;
    return name
      ? `${name}${e.actor_role ? ` · ${label(e.actor_role)}` : ""}`
      : actorText(e.actor_type, e.actor_id, e.actor_role);
  };
  return (
    <>
      <PageHeader
        title="Audit"
        context="Every change to appointments, patients, referrals and schedule settings, with who made it. Entries cannot be changed."
      >
        <div className="toolbar">
          <select
            aria-label="Record type"
            value={type}
            onChange={(e) =>
              filter({
                resource_type: e.target.value || null,
                resource_id: null,
              })
            }
          >
            <option value="">All records</option>
            {RESOURCES.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>
      </PageHeader>
      {id && (
        <p className="note small">
          Showing the history of one {label(type || "record").toLowerCase()} (
          <span className="mono">{id}</span>).{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => filter({ resource_id: null })}
          >
            Show all
          </button>
        </p>
      )}
      <ErrorNote error={list.error} />
      {!list.data && !list.error && <Loading what="the audit trail" />}
      {list.data && !list.data.items.length && (
        <Empty title="No audit entries match" />
      )}
      {list.data && list.data.items.length > 0 && (
        <div
          className={`panel table-wrap${list.loading ? " is-refreshing" : ""}`}
        >
          <table className="table audit">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col">Record</th>
                <th scope="col">Who</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((e) => (
                <tr key={e.id}>
                  <td className="num small">
                    {fmt.when(e.occurred_at, practice.tz)}
                  </td>
                  <td>
                    <span className="mono small">{e.action}</span>
                    {e.reason && (
                      <div className="small">Reason: {e.reason}</div>
                    )}
                    <Changes changes={e.changes} />
                  </td>
                  <td>
                    <RecordLink type={e.resource_type} id={e.resource_id} />
                    {!id && (
                      <div>
                        <button
                          type="button"
                          className="link-button small"
                          onClick={() =>
                            filter({
                              resource_type: e.resource_type,
                              resource_id: e.resource_id,
                            })
                          }
                        >
                          History of this record
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="small">
                    {who(e)}
                    {e.channel && (
                      <div className="muted">via {label(e.channel)}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="load-more">
        {before && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => setBefore(null)}
          >
            Newest entries
          </button>
        )}
        {list.data?.next_before_id && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setBefore(list.data!.next_before_id)}
          >
            Older entries
          </button>
        )}
      </p>
    </>
  );
}

/** A link to the record an entry is about, where the console shows it. */
function RecordLink({ type, id }: { type: string; id: string }) {
  const practice = usePractice();
  const link = useLink();
  const text = label(type);
  const href =
    type === "appointment"
      ? link("appointment", id)
      : type === "patient"
        ? link("patient", id)
        : type === "referral"
          ? link("referrals", null, { open: id })
          : type === "conversation" && practice.can("conversation.manage")
            ? link("conversations", id)
            : type === "waitlist_entry" || type === "waitlist_offer"
              ? link("waitlist")
              : type === "practitioner"
                ? link("setup", null, { tab: "practitioners" })
                : type === "location"
                  ? link("setup", null, { tab: "locations" })
                  : type === "appointment_type"
                    ? link("setup", null, { tab: "types" })
                    : type === "availability_rule"
                      ? link("setup", null, { tab: "hours" })
                      : type === "availability_exception"
                        ? link("setup", null, { tab: "leave" })
                        : null;
  return (
    <>
      {href ? <a href={href}>{text}</a> : text}
      <div className="mono muted small" title={id}>
        {id.length > 13 ? `${id.slice(0, 8)}…` : id}
      </div>
    </>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
function fields(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The administrative fields an entry changed, before and after. */
function Changes({ changes }: { changes: Record<string, unknown> }) {
  const before = fields(changes.before);
  const after = fields(changes.after);
  const keys = [
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ].filter(
    (k) =>
      !before ||
      !after ||
      JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  if (!keys.length) return null;
  return (
    <details className="audit__changes">
      <summary className="small">
        {keys.length} field{keys.length === 1 ? "" : "s"}
      </summary>
      <table className="table table--compact">
        <thead>
          <tr>
            <th scope="col">Field</th>
            {before && <th scope="col">Before</th>}
            {after && <th scope="col">After</th>}
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <th scope="row" className="mono small">
                {k}
              </th>
              {before && <td className="mono small">{show(before[k])}</td>}
              {after && <td className="mono small">{show(after[k])}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
