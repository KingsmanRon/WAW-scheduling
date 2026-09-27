import React from "react";
import { Icon } from "./Icon";

/**
 * The data mode plate. SYNTHETIC is hatched like a test environment; REAL is
 * solid coral. Any other value is shown verbatim in the stronger REAL style,
 * so an unexpected configuration is never presented as synthetic.
 */
export function DataMode({
  mode,
  compact = false,
}: {
  mode: string;
  compact?: boolean;
}) {
  const synthetic = mode === "SYNTHETIC";
  const text = synthetic
    ? "Synthetic data"
    : mode === "REAL"
      ? "Real patient data"
      : `Data mode: ${mode}`;
  return (
    <span
      className={`data-mode ${synthetic ? "data-mode--synthetic" : "data-mode--real"}${compact ? " data-mode--compact" : ""}`}
      title={text}
    >
      <Icon name={synthetic ? "shield" : "alert"} size={16} />
      <span className="data-mode__text">{text}</span>
      {/* The narrow rail shows a short word; the full text stays for assistive tech. */}
      <span className="data-mode__short" aria-hidden="true">
        {synthetic ? "Synthetic" : mode === "REAL" ? "Real data" : mode}
      </span>
    </span>
  );
}
