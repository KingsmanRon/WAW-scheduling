import React from "react";
import { label, reasonLabel, stamp, STATE_LABELS } from "../format";
import type { CaseState, CaseView } from "../types";

/**
 * The Access Line: the one pathway every referral travels. Stations are a
 * presentation of the existing case states; nothing here decides anything.
 */
export const STATIONS = [
  "Received",
  "Identity",
  "Information",
  "Destination",
  "Booking",
  "Outcome",
] as const;
const LAST = STATIONS.length - 1;

const TERMINAL: readonly string[] = ["BOOKED", "CLOSED", "REJECTED"];
export const isTerminal = (state: string) => TERMINAL.includes(state);

/** Station of a non-exception state. */
export function stationOf(state: string): number {
  switch (state) {
    case "IDENTITY_PENDING":
      return 1;
    case "INFORMATION_MISSING":
      return 2;
    case "READY":
    case "DESTINATION_PENDING":
      return 3;
    case "READY_FOR_BOOKING":
    case "WAITING":
      return 4;
    case "BOOKED":
    case "CLOSED":
    case "REJECTED":
      return LAST;
    default:
      return 0;
  }
}

/** Where an exception holds a case, from the kind of work that holds it. */
export function heldStation(workKinds: readonly string[]): number {
  const has = (...kinds: string[]) => kinds.some((k) => workKinds.includes(k));
  if (has("SAFETY", "FILE_SAFETY")) return 0;
  if (has("IDENTITY")) return 1;
  if (has("COMPLETENESS")) return 2;
  if (has("CONNECTOR", "MANUAL_DESTINATION")) return 3;
  if (has("FOLLOW_UP")) return 4;
  if (has("OUTCOME_REVIEW")) return LAST;
  return 0;
}

export type Tone =
  "system" | "attention" | "progress" | "booked" | "exception" | "closed";
export function toneOf(state: string): Tone {
  switch (state) {
    case "IDENTITY_PENDING":
    case "INFORMATION_MISSING":
    case "READY":
      return "attention";
    case "READY_FOR_BOOKING":
    case "WAITING":
      return "progress";
    case "BOOKED":
      return "booked";
    case "EXCEPTION":
      return "exception";
    case "CLOSED":
    case "REJECTED":
      return "closed";
    default:
      return "system";
  }
}

/** True when the next step belongs to a person rather than the system. */
export function needsPerson(
  state: string,
  destinationMode?: string | null,
): boolean {
  if (isTerminal(state)) return false;
  if (state === "RECEIVED" || state === "DESTINATION_PENDING") return false;
  if (state === "READY") return destinationMode !== "CONNECTOR";
  return true;
}

function Glyph({ tone }: { tone: Tone }) {
  if (tone === "exception")
    return <span className="glyph glyph--square" aria-hidden />;
  if (tone === "booked")
    return (
      <svg className="glyph" viewBox="0 0 10 10" aria-hidden>
        <path d="M2 5.3 4.1 7.4 8 3" />
      </svg>
    );
  if (tone === "closed")
    return <span className="glyph glyph--bar" aria-hidden />;
  if (tone === "system")
    return <span className="glyph glyph--ring" aria-hidden />;
  return <span className="glyph glyph--dot" aria-hidden />;
}

export function StateBadge({
  state,
  large = false,
}: {
  state: CaseState | string;
  large?: boolean;
}) {
  const tone = toneOf(state);
  return (
    <span className={`state state--${tone}${large ? " state--lg" : ""}`}>
      <Glyph tone={tone} />
      {STATE_LABELS[state] ?? label(state)}
    </span>
  );
}

/**
 * Six-node track for a queue row. Decorative: the state is always printed
 * beside it, so it is hidden from assistive technology.
 */
export function StationTrack({
  state,
  workKinds = [],
}: {
  state: string;
  workKinds?: readonly string[];
}) {
  const exception = state === "EXCEPTION";
  const at = exception ? heldStation(workKinds) : stationOf(state);
  const tone = toneOf(state);
  const step = 13;
  const x = (i: number) => 5 + i * step;
  const end = x(LAST);
  return (
    <svg
      className={`track track--${tone}`}
      width={end + 5}
      height={14}
      viewBox={`0 0 ${end + 5} 14`}
      aria-hidden
      focusable="false"
    >
      <line className="track__rail" x1={x(0)} x2={end} y1={7} y2={7} />
      {at > 0 && (
        <line className="track__done" x1={x(0)} x2={x(at)} y1={7} y2={7} />
      )}
      {STATIONS.map((_, i) => {
        if (i === at)
          return exception ? (
            <rect
              key={i}
              className="track__now"
              x={x(i) - 4}
              y={3}
              width={8}
              height={8}
              rx={1.5}
            />
          ) : (
            <circle key={i} className="track__now" cx={x(i)} cy={7} r={4.3} />
          );
        return (
          <circle
            key={i}
            className={i < at ? "track__past" : "track__next"}
            cx={x(i)}
            cy={7}
            r={i < at ? 2.5 : 2.3}
          />
        );
      })}
    </svg>
  );
}

interface StationModel {
  name: string;
  status: "passed" | "reached" | "current" | "held" | "skipped" | "ahead";
  at: string | null;
  detail: string;
}

/** The path this case actually took, derived from its transition history. */
export function caseLineModel(view: CaseView): StationModel[] {
  const state = view.case.current_state;
  const entered: (string | null)[] = STATIONS.map(() => null);
  let furthest = 0;
  let held: { station: number; at: string } | null = null;
  let last = 0;
  for (const t of view.transitions) {
    if (t.to_state === "EXCEPTION") {
      held = {
        station: t.from_state ? stationOf(t.from_state) : last,
        at: t.occurred_at,
      };
      continue;
    }
    const s = stationOf(t.to_state);
    entered[s] ??= t.occurred_at;
    if (s !== LAST) furthest = Math.max(furthest, s);
    last = s;
  }
  const terminal = isTerminal(state);
  const current =
    state === "EXCEPTION" ? (held?.station ?? last) : stationOf(state);
  if (!terminal) furthest = Math.max(furthest, current);
  const reason = view.case.exception_reason;
  return STATIONS.map((station, i) => {
    const name =
      i === LAST && terminal ? (STATE_LABELS[state] ?? station) : station;
    if (state === "EXCEPTION" && i === current)
      return {
        name,
        status: "held",
        at: held?.at ?? null,
        detail: reason ? `Held: ${reasonLabel(reason)}` : "Held for review",
      };
    if (i === LAST && terminal)
      return {
        name,
        status: "current",
        at: view.case.outcome_at ?? entered[i] ?? null,
        detail: "",
      };
    if (!terminal && i === current)
      return { name, status: "current", at: entered[i] ?? null, detail: "Now" };
    if (i < furthest || (i === furthest && terminal))
      return {
        name,
        status: entered[i] ? "reached" : "passed",
        at: entered[i] ?? null,
        detail: entered[i] ? "" : "Passed",
      };
    return {
      name,
      status: terminal ? "skipped" : "ahead",
      at: null,
      detail: terminal ? "Not reached" : "",
    };
  });
}

export function CaseLine({ view }: { view: CaseView }) {
  const model = caseLineModel(view);
  const state = view.case.current_state;
  const person = needsPerson(state, view.referral?.destination_mode);
  return (
    <ol
      className={`case-line case-line--${toneOf(state)}${person ? " case-line--person" : ""}`}
      aria-label="Referral pathway"
    >
      {model.map((s, i) => (
        <li
          key={i}
          className={`case-line__station is-${s.status}`}
          aria-current={
            s.status === "current" || s.status === "held" ? "step" : undefined
          }
        >
          <span className="case-line__node" aria-hidden />
          <span className="case-line__name">{s.name}</span>
          <span className="case-line__detail">
            {s.at && <time dateTime={s.at}>{stamp(s.at)}</time>}
            {s.at && s.detail && " · "}
            {s.detail}
            {!s.at && !s.detail && <span className="vh">Not yet reached</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
