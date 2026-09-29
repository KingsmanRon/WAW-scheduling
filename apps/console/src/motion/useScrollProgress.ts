import { useEffect, useRef, type RefObject } from "react";
import { clamp, useReducedMotion } from "./reducedMotion";

/**
 * Publishes --sp (0..1) across an element's visible life: 0 where it rests
 * when the page loads (or as it enters from below), 1 once it has scrolled
 * out above the viewport. Listens only while the element is near the
 * viewport; one read and one write per frame. Reduced motion pins it at 0,
 * which is the complete, resolved composition.
 */
export function useScrollProgress(
  ref: RefObject<HTMLElement | null>,
  onProgress?: (progress: number) => void,
): void {
  const reduced = useReducedMotion();
  const callback = useRef(onProgress);
  useEffect(() => {
    callback.current = onProgress;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced) {
      el.style.setProperty("--sp", "0");
      callback.current?.(0);
      return;
    }
    let frame = 0;
    let last = -1;
    const read = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const docTop = rect.top + window.scrollY;
      const start = Math.max(0, docTop - window.innerHeight);
      const end = docTop + rect.height;
      const progress = clamp((window.scrollY - start) / (end - start || 1));
      const rounded = Math.round(progress * 1000) / 1000;
      if (rounded === last) return;
      last = rounded;
      el.style.setProperty("--sp", String(rounded));
      callback.current?.(rounded);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    let listening = false;
    const listen = (on: boolean) => {
      if (on === listening) return;
      listening = on;
      if (on) {
        window.addEventListener("scroll", schedule, { passive: true });
        window.addEventListener("resize", schedule, { passive: true });
        schedule();
      } else {
        window.removeEventListener("scroll", schedule);
        window.removeEventListener("resize", schedule);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => listen(entries.some((e) => e.isIntersecting)),
      { rootMargin: "25% 0px 25% 0px" },
    );
    observer.observe(el);
    read();
    return () => {
      observer.disconnect();
      listen(false);
      cancelAnimationFrame(frame);
      el.style.removeProperty("--sp");
    };
  }, [ref, reduced]);
}
