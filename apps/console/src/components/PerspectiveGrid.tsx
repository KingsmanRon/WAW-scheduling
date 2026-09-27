import React, { useId } from "react";

/**
 * The far plane of the brand stages: a floor grid drawn in perspective,
 * receding to a horizon near the top of its box. Static SVG; parallax, when
 * any, is applied by the parent plane.
 */
const W = 1600;
const H = 600;
const HORIZON = 24;
const VANISH_X = W / 2;
const ROWS = Array.from(
  { length: 15 },
  (_, k) => HORIZON + (H - HORIZON) * Math.pow(k / 14, 2.1),
);
const COLS = Array.from({ length: 41 }, (_, i) => -2400 + i * 160);

export function PerspectiveGrid({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      className={className ? `pgrid ${className}` : "pgrid"}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-fade`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.35" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="1" />
        </linearGradient>
        <mask id={`${id}-mask`}>
          <rect width={W} height={H} fill={`url(#${id}-fade)`} />
        </mask>
      </defs>
      <g className="pgrid__lines" mask={`url(#${id}-mask)`}>
        {ROWS.map((y) => (
          <line key={`r${y}`} x1={0} x2={W} y1={y} y2={y} />
        ))}
        {COLS.map((x) => (
          <line key={`c${x}`} x1={x} y1={H} x2={VANISH_X} y2={HORIZON} />
        ))}
      </g>
    </svg>
  );
}
