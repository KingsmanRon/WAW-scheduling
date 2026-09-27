import React from "react";

/** ACCESS's own small line-icon set (20px grid, 1.6px stroke). */
const PATHS = {
  queue: "M4 5.5h12M4 10h12M4 14.5h7M14.5 13v3.5M12.75 14.75h3.5",
  dashboard: "M3.5 15.5h13M5 12.5l3.5-4 3 2.5L15 6.5M13 6.5h2v2",
  plus: "M10 4.5v11M4.5 10h11",
  rules: "M5 4h7l3 3v9H5zM12 4v3h3M7.5 10.5h5M7.5 13.5h3",
  signOut: "M8.5 4.5H5v11h3.5M11.5 7l3 3-3 3M14.5 10H8",
  account: "M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4.5 16a5.5 5.5 0 0 1 11 0",
  back: "M11.5 5.5 7 10l4.5 4.5",
  chevron: "M6 8l4 4 4-4",
  alert: "M10 3.8 17 16H3zM10 8.5v3.2M10 13.9v.1",
  shield:
    "M10 3.5 15.5 5.5v4.2c0 3.2-2.3 5.6-5.5 6.8-3.2-1.2-5.5-3.6-5.5-6.8V5.5z",
  check: "M5 10.5l3.2 3L15 6.5",
  clock: "M10 16a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM10 7v3.3l2.2 1.4",
  refresh: "M15.5 9.5A5.5 5.5 0 1 1 13.9 6M14.2 3.5v3h-3",
  document: "M6 3.5h5.5L14.5 6.5v10H6zM11.5 3.5v3h3",
  info: "M10 16a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM10 9.3v3.9M10 6.9v.1",
  lock: "M6 9h8v7H6zM7.5 9V7a2.5 2.5 0 0 1 5 0v2",
  arrowRight: "M4.5 10h11M11.5 6l4 4-4 4",
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 20,
  className,
  title,
}: {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}
