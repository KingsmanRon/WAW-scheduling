/**
 * Practice workspace routes live in the URL hash:
 *   #/p/<practiceId>/<view>[/<id>][?<query>]
 * so every screen (a day in the calendar, a patient, a conversation) has a
 * link staff can reload or share with a colleague of the same practice.
 */
export interface PracticeRoute {
  practiceId: string;
  view: string;
  id: string | null;
  query: URLSearchParams;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePracticeRoute(hash: string): PracticeRoute | null {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", search = ""] = raw.split("?");
  const [p, practiceId, view, id] = path.split("/");
  if (p !== "p" || !practiceId || !UUID.test(practiceId)) return null;
  return {
    practiceId,
    view: view || "today",
    id: id && UUID.test(id) ? id : null,
    query: new URLSearchParams(search),
  };
}

export function practiceHash(
  practiceId: string,
  view: string,
  id?: string | null,
  query?: Record<string, string | null | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== null && v !== undefined && v !== "") params.set(k, v);
  const q = params.toString();
  return `#/p/${practiceId}/${view}${id ? `/${id}` : ""}${q ? `?${q}` : ""}`;
}
