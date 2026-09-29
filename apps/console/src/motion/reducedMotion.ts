import { useEffect, useState } from "react";

const REDUCE = "(prefers-reduced-motion: reduce)";
const FINE_POINTER = "(hover: hover) and (pointer: fine)";

function matches(query: string): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(query).matches;
}
export const prefersReducedMotion = () => matches(REDUCE);
export const hasFinePointer = () => matches(FINE_POINTER);

/** Tracks the reduced-motion preference, including changes while open. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCE);
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));
