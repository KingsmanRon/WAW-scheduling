import React, { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { PerspectiveGrid } from "../components/PerspectiveGrid";
import { measureInputs, ProvenanceTag } from "../components/Provenance";
import {
  duration,
  kindLabel,
  label,
  percent,
  RESOLUTION_LABELS,
  STATE_LABELS,
} from "../format";
import { PageHeader } from "../layout/PageHeader";
import { useReducedMotion } from "../motion/reducedMotion";
import { Reveal } from "../motion/Reveal";
import { usePointerDepth } from "../motion/usePointerDepth";
import { useScrollProgress } from "../motion/useScrollProgress";
import { useSession } from "../session";
import type { BookingMetrics, Cohort, Measure } from "../types";

const PERIODS: [string, number][] = [
  ["Last 7 days", 7],
  ["Last 30 days", 30],
  ["Last 90 days", 90],
];
const CHAPTERS = [
  { id: "flow", title: "Flow" },
  { id: "conversion", title: "Conversion" },
  { id: "booking", title: "Booking" },
  { id: "delay", title: "Delay" },
  { id: "exceptions", title: "Exceptions" },
  { id: "work", title: "Work" },
] as const;
type ChapterId = (typeof CHAPTERS)[number]["id"];

const ratio = (v: number) => v.toFixed(2);

export function Dashboard() {
  const session = useSession();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Cohort | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const to = new Date(Date.now() + 60_000);
    const from = new Date(to.getTime() - days * 86_400_000);
    setLoading(true);
    setError("");
    api<Cohort>(
      session.headers,
      `/v1/metrics/cohort?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    )
      .then((d) => !cancelled && setData(d))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days, session.headers]);

  const period = data
    ? `${new Date(data.period.from).toLocaleDateString([], { day: "numeric", month: "short" })} to ${new Date(data.period.to).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}`
    : "";
  return (
    <div className="dashboard">
      <PageHeader
        title="Dashboard"
        context={
          <>
            Referrals received in the period, followed along the line.
            {period && <span className="dashboard__period"> {period}.</span>}
          </>
        }
        actions={
          <div className="segmented" role="group" aria-label="Period">
            {PERIODS.map(([text, d]) => (
              <button
                key={d}
                type="button"
                aria-pressed={d === days}
                onClick={() => setDays(d)}
              >
                {text}
              </button>
            ))}
          </div>
        }
      />
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        !error && <p className="loading">Loading measures…</p>
      ) : (
        <Story data={data} loading={loading} />
      )}
    </div>
  );
}

function Story({ data, loading }: { data: Cohort; loading: boolean }) {
  const [active, setActive] = useState<ChapterId>("flow");
  const reduced = useReducedMotion();
  const sections = useRef<Partial<Record<ChapterId, HTMLElement | null>>>({});
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (hit)
          setActive(hit.target.getAttribute("data-chapter") as ChapterId);
      },
      { rootMargin: "-35% 0px -60% 0px" },
    );
    Object.values(sections.current).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);
  const go = (id: ChapterId) => {
    const el = sections.current[id];
    if (!el) return;
    el.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
    el.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  };
  const keep = (id: ChapterId) => (el: HTMLElement | null) => {
    sections.current[id] = el;
  };
  const index = CHAPTERS.findIndex((c) => c.id === active);
  return (
    <div className={`story${loading ? " is-loading" : ""}`} aria-busy={loading}>
      <nav className="chapters" aria-label="Dashboard chapters">
        <ol
          className="chapters__line"
          style={
            {
              "--progress": index / (CHAPTERS.length - 1),
            } as React.CSSProperties
          }
        >
          {CHAPTERS.map((c, i) => (
            <li
              key={c.id}
              className={
                i < index ? "is-passed" : i === index ? "is-active" : ""
              }
            >
              <button
                type="button"
                aria-current={c.id === active ? "true" : undefined}
                onClick={() => go(c.id)}
              >
                <span className="chapters__node" aria-hidden />
                {c.title}
              </button>
            </li>
          ))}
        </ol>
        <Legend />
      </nav>
      <div className="story__body">
        <section
          ref={keep("flow")}
          data-chapter="flow"
          className="chapter chapter--flow"
          aria-labelledby="chapter-flow"
        >
          <FlowStage data={data} />
        </section>
        <Chapter
          id="conversion"
          keep={keep}
          title="Conversion"
          lede="Of referrals that reached an outcome, how many were booked, and why the rest closed."
        >
          <div className="figures figures--pair">
            <Figure
              label="Booking conversion (known outcomes)"
              m={data.booking_conversion_rate}
              format={percent}
              lead
            />
            <Figure
              label="Booked of all received (to date)"
              m={data.cohort_booking_rate}
              format={percent}
            />
          </div>
          <BarList
            title="Top closure reasons"
            empty="No referral from this period has closed."
            rows={data.top_closure_reasons.map((r) => [
              RESOLUTION_LABELS[r.code] ?? label(r.code),
              r.count,
              String(r.count),
            ])}
          />
        </Chapter>
        {data.booking && <BookingChapter keep={keep} b={data.booking} />}
        <Chapter
          id="delay"
          keep={keep}
          title="Delay"
          lede="How long referrals take to move along the line, measured from recorded timestamps."
        >
          <ol className="ledger ledger--time">
            <LedgerRow
              label="Received to verified (median)"
              m={data.median_received_to_verified_seconds}
              format={duration}
            />
            <LedgerRow
              label="Received to ready for booking (median)"
              m={data.median_received_to_ready_seconds}
              format={duration}
            />
            <LedgerRow
              label="Received to ready for booking (95th percentile)"
              m={data.p95_received_to_ready_seconds}
              format={duration}
            />
            <LedgerRow
              label="Received to booked (median)"
              m={data.median_received_to_booked_seconds}
              format={duration}
            />
          </ol>
          <BarList
            title="Where referrals wait (median time in stage)"
            empty="No time in stage recorded for this period."
            rows={data.median_seconds_in_state.map((r) => [
              STATE_LABELS[r.state] ?? r.state,
              r.median_seconds,
              `${duration(r.median_seconds)} (n=${r.samples})`,
            ])}
          />
        </Chapter>
        <Chapter
          id="exceptions"
          keep={keep}
          title="Exceptions"
          lede="Referrals that left the line for a person to review."
        >
          <div className="figures figures--pair">
            <Figure
              label="Exception rate"
              m={data.exception_rate}
              format={percent}
              lead
            />
            <Figure
              label="Outcomes awaiting review"
              m={data.outcomes_awaiting_review}
            />
          </div>
          <BarList
            title="Top exception reasons"
            empty="No exceptions raised for this period."
            rows={data.top_exception_reasons.map((r) => [
              kindLabel(r.kind),
              r.count,
              String(r.count),
            ])}
          />
        </Chapter>
        <Chapter
          id="work"
          keep={keep}
          title="Work"
          lede="The human effort behind the line. Staff time is self-reported and stays unknown until every touch is timed."
        >
          <ol className="ledger">
            <LedgerRow
              label="Referrals touched by staff"
              m={data.human_touch_rate}
              format={percent}
            />
            <LedgerRow
              label="Human touches per referral"
              m={data.human_touches_per_referral}
              format={ratio}
            />
            <LedgerRow
              label="Status enquiries per referral"
              m={data.status_contacts_per_referral}
              format={ratio}
            />
            <LedgerRow
              label="Staff time per referral"
              m={data.staff_seconds_per_referral}
              format={duration}
            />
          </ol>
        </Chapter>
        <Legend compact />
      </div>
    </div>
  );
}

/** The Booking stage: from ready for booking to a booked appointment. */
function BookingChapter({
  keep,
  b,
}: {
  keep: (id: ChapterId) => (el: HTMLElement | null) => void;
  b: BookingMetrics;
}) {
  return (
    <Chapter
      id="booking"
      keep={keep}
      title="Booking"
      lede="What happened between ready for booking and a booked appointment, including the bookings ACCESS made with the destination system."
    >
      <div className="figures figures--pair">
        <Figure
          label="Ready for booking to booked (known outcomes)"
          m={b.ready_to_booked_conversion}
          format={percent}
          lead
        />
        <Figure label="Booked by ACCESS" m={b.booked_by_access} />
      </div>
      <ol className="ledger ledger--time">
        <LedgerRow
          label="Ready for booking to booked (median)"
          m={b.median_ready_to_booked_seconds}
          format={duration}
        />
        <LedgerRow
          label="Ready for booking to booked (95th percentile)"
          m={b.p95_ready_to_booked_seconds}
          format={duration}
        />
      </ol>
      <ol className="ledger">
        <LedgerRow label="Booking requests" m={b.booking_requests} />
        <LedgerRow
          label="Booking attempts per booked appointment"
          m={b.booking_attempts_per_booked}
          format={ratio}
        />
        <LedgerRow
          label="Availability searches per booked appointment"
          m={b.availability_searches_per_booked}
          format={ratio}
        />
        <LedgerRow
          label="Selected slot to booked"
          m={b.selection_to_booking_success}
          format={percent}
        />
        <LedgerRow
          label="Booking requests withdrawn"
          m={b.abandoned_booking_requests}
        />
        <LedgerRow label="Reschedules completed" m={b.reschedules_completed} />
        <LedgerRow
          label="Cancellations completed"
          m={b.cancellations_completed}
        />
        <LedgerRow
          label="Writes the destination did not confirm at first"
          m={b.ambiguous_appointment_writes}
        />
        <LedgerRow
          label="Staff interventions per booking request"
          m={b.interventions_per_booking_request}
          format={ratio}
        />
      </ol>
    </Chapter>
  );
}

function Chapter({
  id,
  keep,
  title,
  lede,
  children,
}: {
  id: ChapterId;
  keep: (id: ChapterId) => (el: HTMLElement | null) => void;
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section
      ref={keep(id)}
      data-chapter={id}
      className={`chapter chapter--${id}`}
      aria-labelledby={`chapter-${id}`}
    >
      <Reveal className="chapter__inner">
        <header className="chapter__head">
          <h2 id={`chapter-${id}`} tabIndex={-1}>
            {title}
          </h2>
          <p>{lede}</p>
        </header>
        <div className="chapter__body">{children}</div>
      </Reveal>
    </section>
  );
}

function Legend({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "legend legend--foot" : "legend"}>
      <p className="legend__title">Every figure is labelled</p>
      <dl>
        <div>
          <dt>
            <ProvenanceTag value="OBSERVED" />
          </dt>
          <dd>Counted from records</dd>
        </div>
        <div>
          <dt>
            <ProvenanceTag value="DERIVED" />
          </dt>
          <dd>Calculated from recorded timestamps</dd>
        </div>
        <div>
          <dt>
            <ProvenanceTag value="ESTIMATED" />
          </dt>
          <dd>Self-reported</dd>
        </div>
        <div>
          <dt>
            <ProvenanceTag value="UNKNOWN" />
          </dt>
          <dd>Not enough data; never shown as zero</dd>
        </div>
      </dl>
    </div>
  );
}

function Value({
  m,
  format,
}: {
  m: Measure;
  format?: ((v: number) => string) | undefined;
}) {
  if (m.value === null) return <span className="unknown-value">Unknown</span>;
  return <>{format ? format(m.value) : String(m.value)}</>;
}

function Figure({
  label: text,
  m,
  format,
  lead = false,
}: {
  label: string;
  m: Measure;
  format?: (v: number) => string;
  lead?: boolean;
}) {
  const inputs = measureInputs(m);
  return (
    <div className={`figure${lead ? " figure--lead" : ""}`}>
      <p className="figure__label">{text}</p>
      <p className={`figure__value${m.value === null ? " is-unknown" : ""}`}>
        <Value m={m} format={format} />
      </p>
      <p className="figure__meta">
        <ProvenanceTag value={m.provenance} />
        {inputs && <span>{inputs}</span>}
      </p>
      <p className="figure__basis">{m.basis}</p>
    </div>
  );
}

function LedgerRow({
  label: text,
  m,
  format,
}: {
  label: string;
  m: Measure;
  format?: (v: number) => string;
}) {
  const inputs = measureInputs(m);
  return (
    <li className="ledger__row">
      <span className="ledger__label">
        {text}
        <span className="ledger__basis">{m.basis}</span>
      </span>
      <span className={`ledger__value${m.value === null ? " is-unknown" : ""}`}>
        <Value m={m} format={format} />
      </span>
      <span className="ledger__meta">
        <ProvenanceTag value={m.provenance} />
        {inputs && <span>{inputs}</span>}
      </span>
    </li>
  );
}

function BarList({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: [string, number, string][];
  empty: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <figure className="bars">
      <figcaption className="bars__title">{title}</figcaption>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <table className="bars__table">
          <thead className="vh">
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, value, text]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>
                  <div className="bars__cell">
                    <span className="bars__track" aria-hidden>
                      <span
                        className="bars__fill"
                        style={{ "--w": value / max } as React.CSSProperties}
                      />
                    </span>
                    <span className="bars__value">{text}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}

/* ---------------------------------------------------------------------------
 * Flow: the cohort drawn on the Access Line. Layered like the login stage,
 * but the figures (focal plane) never move; only the far planes respond.
 * ------------------------------------------------------------------------- */
const LINE = [
  "Received",
  "Identity",
  "Information",
  "Destination",
  "Booking",
  "Outcome",
];
const WAITING_AT: Record<string, number> = {
  RECEIVED: 0,
  IDENTITY_PENDING: 1,
  INFORMATION_MISSING: 2,
  READY: 3,
  DESTINATION_PENDING: 3,
  READY_FOR_BOOKING: 4,
  WAITING: 4,
};

function FlowStage({ data }: { data: Cohort }) {
  const stage = useRef<HTMLDivElement>(null);
  usePointerDepth(stage);
  useScrollProgress(stage);
  const received = data.referrals_received.value ?? 0;
  // Milestones reached, placed at the station where they are reached.
  const milestones: (null | { m: Measure; noun: string })[] = [
    { m: data.referrals_received, noun: "received" },
    { m: data.verified, noun: "verified" },
    null,
    { m: data.ready_for_booking, noun: "ready for booking" },
    null,
    { m: data.booked, noun: "booked" },
  ];
  const waiting = LINE.map(() => 0);
  let held = 0;
  for (const row of data.open_by_state) {
    if (row.state === "EXCEPTION") held += row.count;
    else if (row.state in WAITING_AT)
      waiting[WAITING_AT[row.state]!]! += row.count;
  }
  // Band thickness per station: the last milestone reached so far.
  const share: number[] = [];
  let last = 1;
  milestones.forEach((ms) => {
    if (ms && ms.m.value !== null && received > 0) last = ms.m.value / received;
    share.push(received > 0 ? last : 0);
  });
  const W = 1200;
  const H = 140;
  const mid = 70;
  const x = (i: number) => ((i + 0.5) / LINE.length) * W;
  const t = (s: number) => 6 + s * 84;
  let top = `M ${x(0) - 40} ${mid - t(share[0]!) / 2}`;
  let bottom = "";
  for (let i = 0; i < LINE.length; i++) {
    const th = t(share[i]!);
    if (i > 0) {
      const prev = t(share[i - 1]!);
      const x0 = x(i) - 70;
      top += ` L ${x0} ${mid - prev / 2} C ${x0 + 40} ${mid - prev / 2}, ${x(i) - 30} ${mid - th / 2}, ${x(i)} ${mid - th / 2}`;
    }
  }
  top += ` L ${x(LINE.length - 1) + 40} ${mid - t(share[LINE.length - 1]!) / 2}`;
  bottom = ` L ${x(LINE.length - 1) + 40} ${mid + t(share[LINE.length - 1]!) / 2}`;
  for (let i = LINE.length - 1; i >= 0; i--) {
    const th = t(share[i]!);
    if (i > 0) {
      const prev = t(share[i - 1]!);
      const x0 = x(i) - 70;
      bottom += ` L ${x(i)} ${mid + th / 2} C ${x(i) - 30} ${mid + th / 2}, ${x0 + 40} ${mid + prev / 2}, ${x0} ${mid + prev / 2}`;
    }
  }
  bottom += ` L ${x(0) - 40} ${mid + t(share[0]!) / 2} Z`;
  const count = (m: Measure) =>
    m.value === null ? "an unknown number" : m.value;
  const unknownOutcome = data.closed_unknown_outcome.value;
  return (
    <div className="flow night" ref={stage}>
      <div className="flow__far" aria-hidden>
        <PerspectiveGrid />
      </div>
      <div className="flow__atmos" aria-hidden />
      <header className="flow__head">
        <h2 id="chapter-flow" tabIndex={-1}>
          Flow
        </h2>
        <p>
          {received === 0
            ? "No referrals were received in this period."
            : `${received} ${received === 1 ? "referral" : "referrals"} received: ${count(data.booked)} booked, ${count(data.closed_without_booking)} closed without a booking${unknownOutcome ? `, ${unknownOutcome} closed with the outcome unknown` : ""}, ${count(data.still_open)} still open.`}
        </p>
      </header>
      <div className="flow__plot">
        <svg
          className="flow__band"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          aria-hidden
          focusable="false"
        >
          <defs>
            <linearGradient id="flow-ramp" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0.08" className="flow__stop-1" />
              <stop offset="0.25" className="flow__stop-2" />
              <stop offset="0.58" className="flow__stop-3" />
              <stop offset="0.92" className="flow__stop-4" />
            </linearGradient>
          </defs>
          {received > 0 && <path className="flow__fill" d={top + bottom} />}
          <line
            className="flow__spine"
            x1={x(0) - 40}
            x2={x(LINE.length - 1) + 40}
            y1={mid}
            y2={mid}
          />
        </svg>
        <div className="flow__near" aria-hidden>
          <div className="flow__gate" />
        </div>
        <ol className="flow__stations">
          {LINE.map((name, i) => {
            const ms = milestones[i];
            return (
              <li
                key={name}
                className="flow__station"
                style={{ "--i": i, "--share": share[i] } as React.CSSProperties}
              >
                <span className="flow__name">{name}</span>
                <span className="flow__node" aria-hidden />
                {ms ? (
                  <span className="flow__figure">
                    <span
                      className={`flow__count${ms.m.value === null ? " is-unknown" : ""}`}
                    >
                      {ms.m.value ?? "Unknown"}
                    </span>
                    <span className="flow__noun">{ms.noun}</span>
                    <ProvenanceTag value={ms.m.provenance} />
                  </span>
                ) : (
                  <span className="flow__figure flow__figure--none">
                    <span className="vh">
                      No milestone recorded at this station
                    </span>
                  </span>
                )}
                <span className="flow__waiting">
                  {i === LINE.length - 1 ? (
                    <>
                      <span>
                        <strong>
                          {data.closed_without_booking.value ?? "Unknown"}
                        </strong>{" "}
                        closed without booking
                      </span>
                      <span>
                        <strong>
                          {data.closed_unknown_outcome.value ?? "Unknown"}
                        </strong>{" "}
                        closed, outcome unknown
                      </span>
                    </>
                  ) : waiting[i] ? (
                    <span>
                      <strong>{waiting[i]}</strong> waiting here
                    </span>
                  ) : (
                    <span className="flow__quiet">None waiting</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="flow__note">
        {held > 0 && (
          <span className="flow__held">
            <Icon name="alert" size={16} />
            {held} held for review
          </span>
        )}
        Band width is the share of this period's referrals that have reached
        each milestone. Open referrals are counted at the stage where they wait
        now.
      </p>
    </div>
  );
}
