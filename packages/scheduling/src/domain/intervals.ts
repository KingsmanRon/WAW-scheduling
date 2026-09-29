/**
 * Half-open intervals [start, end) in epoch milliseconds. Adjacent intervals
 * do not overlap: an appointment ending at 09:30 never conflicts with one
 * starting at 09:30 (the same semantics as PostgreSQL's '[)' ranges used by
 * the exclusion constraint).
 */
export interface Interval {
  start: number;
  end: number;
}

/** Sorted, with overlapping or touching intervals merged; empty ones dropped. */
export function normalize(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push(i);
  }
  return out;
}

/** `base` minus every interval of `remove`. Both may be unsorted. */
export function subtract(
  base: readonly Interval[],
  remove: readonly Interval[],
): Interval[] {
  const cuts = normalize(remove);
  const out: Interval[] = [];
  for (const b of normalize(base)) {
    let cursor = b.start;
    for (const c of cuts) {
      if (c.end <= cursor) continue;
      if (c.start >= b.end) break;
      if (c.start > cursor) out.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
      if (cursor >= b.end) break;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out;
}

/** Index of the first normalized interval whose end is after `point`. */
function firstEndingAfter(sorted: readonly Interval[], point: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]!.end <= point) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** True when `iv` lies entirely inside one interval of `normalized`. */
export function containedIn(
  normalized: readonly Interval[],
  iv: Interval,
): boolean {
  const i = normalized[firstEndingAfter(normalized, iv.start)];
  return i !== undefined && i.start <= iv.start && iv.end <= i.end;
}

/** True when `iv` overlaps any interval of `normalized`. */
export function overlapsAny(
  normalized: readonly Interval[],
  iv: Interval,
): boolean {
  const i = normalized[firstEndingAfter(normalized, iv.start)];
  return i !== undefined && i.start < iv.end;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}
