import type { QueueItem } from "./types";

/**
 * The last queue result per identity and lens, held in memory only (never in
 * browser storage), so returning from a case shows the queue at once while
 * it refreshes. Keys include tenant and user, so one person's view is never
 * shown to another, and sign-out clears it.
 */
export const queueCache = new Map<string, QueueItem[]>();
export const lastOpenedCase: { id: string | null } = { id: null };
export function clearQueueCache(): void {
  queueCache.clear();
  lastOpenedCase.id = null;
}
