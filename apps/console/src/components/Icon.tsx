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
  calendar: "M4 5.5h12v10.5H4zM4 8.5h12M7 3.5v3M13 3.5v3",
  today: "M4 5.5h12v10.5H4zM4 8.5h12M7 3.5v3M13 3.5v3M8.5 12.5h3",
  patients:
    "M7.5 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 16a4.5 4.5 0 0 1 9 0M13 9.5a2 2 0 1 0 0-4M14.5 12.5A4 4 0 0 1 17 16",
  list: "M7.5 6h8.5M7.5 10h8.5M7.5 14h8.5M4 6h.5M4 10h.5M4 14h.5",
  message: "M4 5h12v8.5H9.5L6 16.5v-3H4z",
  bell: "M6 13.5V9.5a4 4 0 1 1 8 0v4l1.5 1.5h-11zM8.5 16.5h3",
  waitlist:
    "M6.5 3.5h7M6.5 16.5h7M7 3.5c0 3 3 4.5 3 6.5s-3 3.5-3 6.5M13 3.5c0 3-3 4.5-3 6.5s3 3.5 3 6.5",
  settings:
    "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10 3.5v2M10 14.5v2M3.5 10h2M14.5 10h2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M5.4 14.6l1.4-1.4M13.2 6.8l1.4-1.4",
  search: "M9 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12.7 12.7l3.8 3.8",
  close: "M5.5 5.5l9 9M14.5 5.5l-9 9",
  phone:
    "M6.5 3.5h-2a1 1 0 0 0-1 1.1A12 12 0 0 0 15.4 16.5a1 1 0 0 0 1.1-1v-2l-3-1.2-1.4 1.4a8 8 0 0 1-4.3-4.3l1.4-1.4z",
  swap: "M5 7h10M12.5 4.5 15 7l-2.5 2.5M15 13H5M7.5 10.5 5 13l2.5 2.5",
  practice:
    "M3.5 16.5h13M5 16.5v-9l5-3.5 5 3.5v9M8.5 16.5v-4h3v4M10 7.5v2.5M8.75 8.75h2.5",
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
