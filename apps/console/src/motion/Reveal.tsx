import React, { useLayoutEffect, useRef, useState } from "react";

/**
 * Reveals its content once, when it first scrolls into view. Content already
 * on screen at mount is never hidden, and nothing re-hides on the way back
 * up. Brand surfaces only (dashboard story); operational screens never use
 * it, so scanning work is never delayed.
 */
export function Reveal({
  as: Tag = "div",
  className,
  delay = 0,
  children,
  ...rest
}: {
  as?: "div" | "section" | "article" | "li";
  className?: string;
  delay?: number;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);
  const [state, setState] = useState<"static" | "pending" | "shown">("static");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;
    setState("pending");
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setState("shown");
        observer.disconnect();
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <Tag
      ref={ref as React.Ref<never>}
      className={className}
      data-reveal={state}
      style={
        delay ? ({ "--reveal-delay": `${delay}ms` } as React.CSSProperties) : {}
      }
      {...rest}
    >
      {children}
    </Tag>
  );
}
