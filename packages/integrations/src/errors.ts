/**
 * How a failed call to an external system may be retried. Every adapter in
 * this package reports failures as a DeliveryFailure, so the worker decides
 * retries from the kind alone:
 *
 * - TRANSIENT: known not to have taken effect (or safe to repeat, e.g. an
 *   idempotent webhook); retried with backoff.
 * - AMBIGUOUS: the request may have been processed (timeout or reset after
 *   it was sent). Retried only after a delay long enough for provider
 *   callbacks to reconcile it, and never counted as success.
 * - CONFIGURATION: credentials, permissions, templates or the target are
 *   wrong. Retried with backoff (an operator can fix it in time) and
 *   surfaced as an alert.
 * - PERMANENT: the provider refused this particular message. Never retried.
 */
export type FailureKind =
  "TRANSIENT" | "AMBIGUOUS" | "CONFIGURATION" | "PERMANENT";

export class DeliveryFailure extends Error {
  override readonly name = "DeliveryFailure";
  readonly detail: string | null;
  constructor(
    readonly kind: FailureKind,
    /** Stable machine code: ^[A-Z0-9_]{2,64}$. */
    readonly code: string,
    detail?: string | null,
    readonly retryAfterSeconds: number | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(`${kind}:${code}`);
    this.code = normalizeCode(code);
    this.detail = detail ? safeDetail(detail) : null;
  }
}

export function normalizeCode(code: string): string {
  const c = code
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return c.length >= 2 ? c : "UNKNOWN";
}

/**
 * Provider error text is kept for operators, but it can echo what was sent.
 * Strip anything that looks like a phone number, e-mail address or long
 * number before it is stored, and bound its length.
 */
export function safeDetail(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/\+?\d[\d\s-]{6,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function isDeliveryFailure(e: unknown): e is DeliveryFailure {
  return e instanceof DeliveryFailure;
}

/**
 * Backoff for the next attempt: exponential from 30 s (capped at an hour)
 * with jitter; at least 3 minutes after an ambiguous send (time for the
 * provider's status callback to settle it) and 5 minutes after a
 * configuration error; never sooner than the provider asked.
 */
export function retryDelaySeconds(
  attempt: number,
  failure: DeliveryFailure,
  random: () => number = Math.random,
): number {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(base * (0.8 + 0.4 * random()));
  const floor =
    failure.kind === "AMBIGUOUS"
      ? 180
      : failure.kind === "CONFIGURATION"
        ? 300
        : 0;
  return Math.max(jittered, floor, failure.retryAfterSeconds ?? 0);
}
