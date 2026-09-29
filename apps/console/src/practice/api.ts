import { ApiError, type HeaderSource } from "../api";
import { API_URL } from "../session";

export type Query = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * The practice API as the console uses it. Reads are plain GETs. Every
 * change carries a fresh Idempotency-Key; if the network drops before an
 * answer arrives, the same request is sent once more with the same key, so
 * the Scheduling Core applies it at most once and the console learns the
 * original outcome.
 */
export interface PracticeClient {
  readonly practiceId: string;
  get<T>(path: string, query?: Query): Promise<T>;
  send<T>(
    method: "POST" | "PATCH" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T>;
  /** An absolute URL on the API (signed document links). */
  url(path: string): string;
}

function queryString(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : "";
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = body as {
      error?: string;
      message?: string;
      details?: unknown;
      issues?: unknown;
    } | null;
    const err = new ApiError(
      res.status,
      b?.error ?? "ERROR",
      b?.message ?? `Request failed (${res.status})`,
    );
    (err as ApiError & { details?: unknown }).details = b?.details ?? b?.issues;
    throw err;
  }
  return body as T;
}

export function practiceClient(
  headers: HeaderSource,
  practiceId: string,
): PracticeClient {
  const base = `${API_URL}/v1/practices/${practiceId}`;
  return {
    practiceId,
    async get<T>(path: string, query?: Query) {
      const res = await fetch(`${base}${path}${queryString(query)}`, {
        headers: await headers(),
      });
      return parse<T>(res);
    },
    async send<T>(
      method: "POST" | "PATCH" | "PUT",
      path: string,
      body: unknown = {},
    ) {
      const key = crypto.randomUUID();
      const attempt = async () =>
        fetch(`${base}${path}`, {
          method,
          headers: {
            ...(await headers()),
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify(body),
        });
      let res: Response;
      try {
        res = await attempt();
      } catch {
        // No answer: safe to repeat with the same key.
        res = await attempt();
      }
      return parse<T>(res);
    },
    url: (path: string) => `${API_URL}${path}`,
  };
}

/** A domain refusal in words staff can act on. */
export function problem(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  // fetch() rejects with a TypeError when there is no answer at all.
  if (e instanceof TypeError || !(e instanceof Error) || !e.message)
    return "The practice API could not be reached. Check the connection and try again.";
  return e.message;
}
export function errorCode(e: unknown): string | null {
  return e instanceof ApiError ? e.code : null;
}
export function errorDetails(e: unknown): unknown {
  return (e as { details?: unknown } | null)?.details ?? null;
}
