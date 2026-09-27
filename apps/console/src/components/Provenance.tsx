import React from "react";
import type { Measure, Provenance } from "../types";

const MEANING: Record<Provenance, string> = {
  OBSERVED: "counted from records",
  DERIVED: "calculated from recorded timestamps and counts",
  ESTIMATED: "self-reported by staff",
  UNKNOWN: "not enough data; never shown as zero",
};

/** Provenance is always a printed word; colour only supports it. */
export function ProvenanceTag({ value }: { value: Provenance }) {
  return (
    <span
      className={`prov prov--${value.toLowerCase()}`}
      title={`${value}: ${MEANING[value]}`}
    >
      {value}
    </span>
  );
}

/** Formats a measure; an unknown measure is the word "Unknown", never 0. */
export function measureText(
  m: Measure<number | boolean | string> | undefined,
  format?: (v: number) => string,
): string {
  if (!m || m.value === null || m.value === undefined) return "Unknown";
  if (typeof m.value === "number")
    return format ? format(m.value) : String(m.value);
  if (typeof m.value === "boolean") return m.value ? "Yes" : "No";
  return String(m.value);
}

/** Sample size or ratio inputs, when the API reports them. */
export function measureInputs(m: Measure | undefined): string {
  const inputs = m?.inputs;
  if (!inputs) return "";
  if (
    typeof inputs.numerator === "number" &&
    typeof inputs.denominator === "number"
  )
    return `${inputs.numerator} of ${inputs.denominator}`;
  if (typeof inputs.samples === "number") return `n = ${inputs.samples}`;
  if (
    typeof inputs.reported_touches === "number" &&
    typeof inputs.total_touches === "number"
  )
    return `${inputs.reported_touches} of ${inputs.total_touches} touches timed`;
  if (typeof inputs.escalated_to_staff === "number")
    return `${inputs.escalated_to_staff} needed a staff check`;
  return "";
}
