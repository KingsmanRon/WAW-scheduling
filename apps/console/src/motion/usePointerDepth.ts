import { useEffect, type RefObject } from "react";
import { clamp, hasFinePointer, useReducedMotion } from "./reducedMotion";

/**
 * Publishes the pointer position over an element as --px / --py (-1..1),
 * eased toward the pointer so planes carry a little weight. Mouse on
 * fine-pointer devices only; touch, keyboard and reduced-motion visitors get
 * the static composition. The rAF loop runs only while values are settling,
 * and everything is removed on unmount. Never requests pointer lock.
 */
export function usePointerDepth(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): void {
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || reduced || !hasFinePointer()) return;
    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let frame = 0;
    let rect = el.getBoundingClientRect();
    const measure = () => {
      rect = el.getBoundingClientRect();
    };
    const step = () => {
      x += (targetX - x) * 0.085;
      y += (targetY - y) * 0.085;
      el.style.setProperty("--px", x.toFixed(4));
      el.style.setProperty("--py", y.toFixed(4));
      const settling =
        Math.abs(targetX - x) > 0.0008 || Math.abs(targetY - y) > 0.0008;
      frame = settling ? requestAnimationFrame(step) : 0;
    };
    const wake = () => {
      if (!frame) frame = requestAnimationFrame(step);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      targetX = clamp((e.clientX - rect.left) / rect.width, 0, 1) * 2 - 1;
      targetY = clamp((e.clientY - rect.top) / rect.height, 0, 1) * 2 - 1;
      wake();
    };
    const onLeave = () => {
      targetX = 0;
      targetY = 0;
      wake();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("resize", measure, { passive: true });
    window.addEventListener("scroll", measure, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(frame);
      el.style.removeProperty("--px");
      el.style.removeProperty("--py");
    };
  }, [ref, enabled, reduced]);
}
