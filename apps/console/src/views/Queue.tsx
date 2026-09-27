import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { StateBadge, StationTrack } from "../components/AccessLine";
import { Icon } from "../components/Icon";
import {
  duration,
  label,
  reasonLabel,
  RESOLUTION_LABELS,
  roleLabel,
} from "../format";
import { PageHeader } from "../layout/PageHeader";
import { lastOpenedCase, queueCache as cache } from "../queueCache";
import { useSession } from "../session";
import type { QueueItem } from "../types";

const ATTENTION: [string, string] = ["needs_attention", "Needs attention"];
/** Stage lenses in the order a referral travels the line. */
const STAGES: [string, string][] = [
  ["identity_pending", "Identity pending"],
  ["information_missing", "Information missing"],
  ["ready", "Ready"],
  ["ready_for_booking", "Ready for booking"],
  ["waiting", "Waiting"],
  ["booked", "Booked"],
  ["closed", "Closed"],
];
const OTHER: [string, string][] = [
  ["exceptions", "Exceptions"],
  ["all", "All"],
];
const NAMES = Object.fromEntries([ATTENTION, ...STAGES, ...OTHER]);
const LIMIT = 200;

/** Plain words for the machine codes that appear inside API strings. */
const words = (text: string) => text.replace(/_/g, " ");
function outcomeText(status: string): string {
  if (status === "BOOKED") return "Booked";
  const closed = /^CLOSED: (.+)$/.exec(status);
  if (closed)
    return `Closed: ${RESOLUTION_LABELS[closed[1]!] ?? label(closed[1]!)}`;
  return status;
}
function destinationTone(status: string): string {
  if (status.startsWith("Committed")) return "done";
  if (status === "Manual entry required") return "attention";
  if (status.startsWith("Unknown")) return "exception";
  return "";
}
const followUpDue = (item: QueueItem) =>
  (item.state === "READY_FOR_BOOKING" || item.state === "WAITING") &&
  !!item.follow_up_due_at &&
  new Date(item.follow_up_due_at).getTime() <= Date.now();

export function Queue({ open }: { open: (caseId: string) => void }) {
  const session = useSession();
  const me = session.me;
  const [filter, setFilter] = useState(
    () => sessionStorage.getItem("queue-filter") ?? "needs_attention",
  );
  const key = `${me?.tenant_id}|${me?.user_id}|${me?.role}|${filter}`;
  const [items, setItems] = useState<QueueItem[] | null>(
    () => cache.get(key) ?? null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const body = useRef<HTMLTableSectionElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const lensRow = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);

  // The table header sticks just under the lens bar, whatever its height;
  // the lens row fades at its edge only when it actually overflows.
  useEffect(() => {
    const el = bar.current;
    const row = lensRow.current;
    const host = section.current;
    if (!el || !row || !host || typeof ResizeObserver === "undefined") return;
    const edges = () => {
      const overflow = row.scrollWidth > row.clientWidth + 1;
      const left = row.scrollLeft > 1;
      const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
      row.dataset.fade = !overflow
        ? "none"
        : left && right
          ? "both"
          : left
            ? "left"
            : "right";
    };
    const observer = new ResizeObserver(() => {
      host.style.setProperty("--queue-bar-h", `${el.offsetHeight}px`);
      edges();
    });
    observer.observe(el);
    observer.observe(row);
    row.addEventListener("scroll", edges, { passive: true });
    return () => {
      observer.disconnect();
      row.removeEventListener("scroll", edges);
    };
  }, []);
  // Keep the chosen lens visible when the row scrolls (narrow screens).
  useEffect(() => {
    lensRow.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [filter]);

  useEffect(() => {
    sessionStorage.setItem("queue-filter", filter);
    let cancelled = false;
    setItems(cache.get(key) ?? null);
    setRefreshing(true);
    setError("");
    api<{ items: QueueItem[] }>(
      session.headers,
      `/v1/cases?filter=${filter}&limit=${LIMIT}`,
    )
      .then((r) => {
        if (cancelled) return;
        cache.set(key, r.items);
        setItems(r.items);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setRefreshing(false));
    return () => {
      cancelled = true;
    };
  }, [filter, session.headers, key, version]);

  // Returning from a case puts focus back on the row that was opened.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !items || !lastOpenedCase.id) return;
    restored.current = true;
    body.current
      ?.querySelector<HTMLElement>(`[data-case="${lastOpenedCase.id}"]`)
      ?.focus({ preventScroll: true });
    lastOpenedCase.id = null;
  }, [items]);

  const openCase = useCallback(
    (id: string) => {
      lastOpenedCase.id = id;
      open(id);
    },
    [open],
  );
  const onRowKey = (
    e: React.KeyboardEvent<HTMLTableRowElement>,
    id: string,
  ) => {
    if (e.key === "Enter") return openCase(id);
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const next = (
      e.key === "ArrowDown"
        ? e.currentTarget.nextElementSibling
        : e.currentTarget.previousElementSibling
    ) as HTMLElement | null;
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const lens = ([value, text]: [string, string], extra = "") => (
    <button
      key={value}
      type="button"
      className={`lens${extra}`}
      aria-pressed={value === filter}
      onClick={() => setFilter(value)}
    >
      {text}
    </button>
  );
  const count = items?.length ?? 0;

  return (
    <section className="queue" aria-labelledby="queue-title" ref={section}>
      <PageHeader
        title={<span id="queue-title">Queue</span>}
        context="Oldest first. Each row shows where the referral sits on the line, who owns it and the next required action."
        actions={
          <div className="queue-status">
            <span aria-live="polite">
              {items &&
                (count === LIMIT
                  ? `Showing the first ${LIMIT}`
                  : `${count} ${count === 1 ? "case" : "cases"}`)}
              {refreshing && items && <span className="vh"> refreshing</span>}
            </span>
            <button
              type="button"
              className="btn btn-secondary queue-refresh"
              onClick={() => setVersion((v) => v + 1)}
              data-busy={refreshing || undefined}
            >
              <Icon name="refresh" size={16} />
              Refresh
            </button>
          </div>
        }
      />
      <div className="queue-bar" ref={bar}>
        <div
          className="lenses"
          role="group"
          aria-label="Queue view"
          ref={lensRow}
        >
          {lens(ATTENTION, " lens--attention")}
          <ol className="lens-line" aria-label="By stage">
            {STAGES.map((s) => (
              <li key={s[0]}>{lens(s, " lens--station")}</li>
            ))}
          </ol>
          {OTHER.map((o) =>
            lens(o, o[0] === "exceptions" ? " lens--exception" : ""),
          )}
        </div>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!items ? (
        !error && <p className="loading">Loading {NAMES[filter]}…</p>
      ) : items.length === 0 ? (
        <div className="panel empty">
          <strong>No cases in this view.</strong>
          <span>
            {filter === "needs_attention"
              ? "Nothing needs a person right now."
              : `Nothing is at ${NAMES[filter]?.toLowerCase() ?? "this stage"}.`}
          </span>
        </div>
      ) : (
        <div
          className={`queue-table panel${refreshing ? " is-refreshing" : ""}`}
        >
          <table role="table">
            <caption className="vh">
              {NAMES[filter]}: {count} cases, oldest first. Press Enter on a row
              to open the case; arrow keys move between rows.
            </caption>
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col">
                  Case
                </th>
                <th role="columnheader" scope="col">
                  Position
                </th>
                <th role="columnheader" scope="col">
                  Waiting
                </th>
                <th role="columnheader" scope="col">
                  Owner
                </th>
                <th role="columnheader" scope="col">
                  Next required action
                </th>
                <th role="columnheader" scope="col">
                  Destination
                </th>
                <th role="columnheader" scope="col">
                  Booking / outcome
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup" ref={body}>
              {items.map((i) => {
                const due = followUpDue(i);
                return (
                  <tr
                    role="row"
                    key={i.case_id}
                    data-case={i.case_id}
                    className={`row row--${i.state.toLowerCase()}`}
                    onClick={() => openCase(i.case_id)}
                    tabIndex={0}
                    onKeyDown={(e) => onRowKey(e, i.case_id)}
                  >
                    <td role="cell" className="c-case">
                      <span className="ref mono">{i.display_ref}</span>
                      {i.open_work_items.length > 0 && (
                        <span className="work">
                          {i.open_work_items.map(label).join(" · ")}
                        </span>
                      )}
                    </td>
                    <td role="cell" className="c-position">
                      <div className="position">
                        <StationTrack
                          state={i.state}
                          workKinds={i.open_work_items}
                        />
                        <StateBadge state={i.state} />
                      </div>
                      {i.exception_reason && (
                        <span className="reason">
                          {reasonLabel(i.exception_reason)}
                        </span>
                      )}
                    </td>
                    <td role="cell" className="c-age">
                      <span className="num">{duration(i.age_seconds)}</span>
                      {due && <span className="flag">Follow-up due</span>}
                    </td>
                    <td role="cell" className="c-owner" data-label="Owner">
                      {roleLabel(i.owner)}
                    </td>
                    <td role="cell" className="c-action">
                      {i.next_action === "None"
                        ? "No action needed"
                        : words(i.next_action)}
                    </td>
                    <td
                      role="cell"
                      className={`c-destination ${destinationTone(i.destination_status)}`}
                      data-label="Destination"
                    >
                      {i.destination_status}
                    </td>
                    <td role="cell" className="c-outcome" data-label="Outcome">
                      {outcomeText(i.outcome_status)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
