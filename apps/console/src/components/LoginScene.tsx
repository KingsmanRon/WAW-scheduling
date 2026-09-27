import React, { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../motion/reducedMotion";
import { usePointerDepth } from "../motion/usePointerDepth";
import { useScrollProgress } from "../motion/useScrollProgress";
import { PerspectiveGrid } from "./PerspectiveGrid";

/*
 * The login stage. Planes move by different small amounts and share one
 * aspect-locked box, so the line, the referral object and the gate stay in
 * register at every width:
 *   far         perspective floor grid           smallest shift
 *   atmosphere  light from the upper left         slow, small
 *   mid         the Access Line and its stations  carries the contact shadow
 *   focal       one anonymous referral object    travels the line once
 *   near        the destination gate             strongest shift; occludes
 * No patient data, counts or claims appear here.
 */
const W = 1000;
const H = 600;
const PATH = "M 70 468 H 300 L 362 406 H 628 L 690 344 H 950";
const STATIONS: { name: string; x: number; y: number }[] = [
  { name: "Received", x: 110, y: 468 },
  { name: "Identity", x: 250, y: 468 },
  { name: "Information", x: 430, y: 406 },
  { name: "Destination", x: 575, y: 406 },
  { name: "Booking", x: 770, y: 344 },
  { name: "Booked", x: 900, y: 344 },
];
const LAST = STATIONS.length - 1;
const TRAVEL_MS = 2600;
const START_DELAY_MS = 500;

const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export function LoginScene() {
  const stage = useRef<HTMLDivElement>(null);
  const rail = useRef<SVGPathElement>(null);
  const token = useRef<SVGGElement>(null);
  const shadow = useRef<SVGEllipseElement>(null);
  const stations = useRef<(HTMLElement | SVGGElement | null)[][]>([]);
  usePointerDepth(stage);
  useScrollProgress(stage);

  useEffect(() => {
    const path = rail.current;
    const el = stage.current;
    if (!path || !el) return;
    const total = path.getTotalLength();
    // Each station's position along the line, measured once.
    const marks = STATIONS.map((s) => {
      let best = 0;
      let bestDistance = Infinity;
      for (let l = 0; l <= total; l += 2) {
        const p = path.getPointAtLength(l);
        const d = Math.hypot(p.x - s.x, p.y - s.y);
        if (d < bestDistance) [best, bestDistance] = [l, d];
      }
      return best / total;
    });
    const from = marks[0]!;
    const to = marks[LAST]!;
    const place = (t: number) => {
      const at = from + (to - from) * t;
      const p = path.getPointAtLength(total * at);
      token.current?.setAttribute(
        "transform",
        `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`,
      );
      shadow.current?.setAttribute("cx", p.x.toFixed(1));
      shadow.current?.setAttribute("cy", (p.y + 3).toFixed(1));
      stations.current.forEach((parts, i) =>
        parts.forEach((part) =>
          part?.classList.toggle("is-passed", marks[i]! <= at + 0.002),
        ),
      );
    };
    if (prefersReducedMotion()) {
      place(1);
      el.dataset.phase = "resolved";
      return;
    }
    place(0);
    el.dataset.phase = "opening";
    let frame = 0;
    let started = 0;
    const tick = (now: number) => {
      started ||= now;
      const t = Math.min(
        1,
        Math.max(0, (now - started - START_DELAY_MS) / TRAVEL_MS),
      );
      place(easeInOut(t));
      if (t > 0.42 && el.dataset.phase === "opening")
        el.dataset.phase = "midpoint";
      if (t < 1) frame = requestAnimationFrame(tick);
      else el.dataset.phase = "resolved";
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const keep =
    (i: number, part: 0 | 1) => (node: HTMLElement | SVGGElement | null) => {
      (stations.current[i] ??= [])[part] = node;
    };
  return (
    <div className="scene" ref={stage} aria-hidden="true">
      <div className="scene__far">
        <PerspectiveGrid />
      </div>
      <div className="scene__atmos" />
      <div className="scene__box">
        <div className="scene__layer scene__mid">
          <svg viewBox={`0 0 ${W} ${H}`} focusable="false">
            <defs>
              <radialGradient id="scene-contact">
                <stop className="scene__contact-core" offset="0" />
                <stop className="scene__contact-edge" offset="1" />
              </radialGradient>
            </defs>
            <path className="scene__rail" d={PATH} ref={rail} />
            <path className="scene__line" d={PATH} pathLength={1} />
            <ellipse
              ref={shadow}
              className="scene__contact"
              fill="url(#scene-contact)"
              cx={STATIONS[0]!.x}
              cy={STATIONS[0]!.y + 3}
              rx="30"
              ry="6"
            />
            {STATIONS.map((s, i) => (
              <g
                key={s.name}
                ref={keep(i, 0)}
                className={`scene__station${i === LAST ? " scene__station--end" : ""}`}
                style={{ "--i": i } as React.CSSProperties}
              >
                <circle className="scene__node" cx={s.x} cy={s.y} r={7} />
                {i === LAST && (
                  <path
                    className="scene__tick"
                    d={`M ${s.x - 3.4} ${s.y + 0.2} l 2.3 2.4 l 4.6 -5`}
                  />
                )}
              </g>
            ))}
          </svg>
          {STATIONS.map((s, i) => (
            <span
              key={s.name}
              ref={keep(i, 1)}
              className={`scene__label scene__label--${i}`}
              style={
                {
                  left: `${(s.x / W) * 100}%`,
                  top: `${((s.y + 20) / H) * 100}%`,
                  "--i": i,
                } as React.CSSProperties
              }
            >
              {s.name}
            </span>
          ))}
        </div>
        <div className="scene__layer scene__focal">
          <svg viewBox={`0 0 ${W} ${H}`} focusable="false">
            <g
              ref={token}
              transform={`translate(${STATIONS[0]!.x} ${STATIONS[0]!.y})`}
            >
              <g className="scene__token" transform="translate(-23 -74)">
                <path
                  className="scene__token-sheet"
                  d="M 0 6 Q 0 0 6 0 H 32 L 46 14 V 58 Q 46 64 40 64 H 6 Q 0 64 0 58 Z"
                />
                <path
                  className="scene__token-fold"
                  d="M 32 0 V 10 Q 32 14 36 14 H 46"
                />
                <rect
                  className="scene__token-bar"
                  x="8"
                  y="22"
                  width="22"
                  height="3.5"
                  rx="1.75"
                />
                <rect
                  className="scene__token-bar"
                  x="8"
                  y="31"
                  width="30"
                  height="3.5"
                  rx="1.75"
                />
                <rect
                  className="scene__token-bar"
                  x="8"
                  y="40"
                  width="26"
                  height="3.5"
                  rx="1.75"
                />
                <circle className="scene__token-pip" cx="38" cy="53" r="4" />
              </g>
            </g>
          </svg>
        </div>
        <div className="scene__layer scene__near">
          <div className="scene__gate" />
        </div>
      </div>
      <div className="scene__grain" />
    </div>
  );
}
