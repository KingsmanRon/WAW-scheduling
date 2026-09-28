import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AUTH_MODE, supabaseClient, useSession } from "../session";
import { practiceClient, problem, type PracticeClient } from "./api";
import type {
  AppointmentType,
  Location,
  Permission,
  PracticeContextData,
  Practitioner,
} from "./types";

/** Poll interval when no realtime signal is available (or as a backstop). */
const POLL_MS = 20_000;

export interface Practice {
  id: string;
  data: PracticeContextData;
  client: PracticeClient;
  /** The practice's time zone (display and date boundaries). */
  tz: string;
  can(permission: Permission): boolean;
  location(id: string | null | undefined): Location | undefined;
  practitioner(id: string | null | undefined): Practitioner | undefined;
  type(id: string | null | undefined): AppointmentType | undefined;
  /** Reload configuration (after changing practitioners, types, ...). */
  reload(): Promise<void>;
  /**
   * Changes whenever the schedule may have changed: a realtime signal, the
   * polling backstop, the tab becoming visible, or this operator's own
   * change. Views re-read their data when it changes.
   */
  tick: number;
  changed(): void;
  live: "realtime" | "polling";
}
const PracticeCtx = createContext<Practice | null>(null);
export function usePractice(): Practice {
  const p = useContext(PracticeCtx);
  if (!p) throw new Error("practice context unavailable");
  return p;
}

function useLiveTick(practiceId: string) {
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState<"realtime" | "polling">("polling");
  const pending = useRef<number | undefined>(undefined);
  const bump = useCallback(() => {
    // Coalesce bursts (a booking touches several signals at once).
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => setTick((t) => t + 1), 250);
  }, []);
  useEffect(() => {
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") bump();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearTimeout(pending.current);
    };
  }, [bump]);
  useEffect(() => {
    // Realtime needs a Supabase session: the browser reads only the
    // practice's change signals (no patient data), through RLS.
    if (AUTH_MODE !== "supabase") return;
    let channel: ReturnType<ReturnType<typeof supabaseClient>["channel"]>;
    try {
      channel = supabaseClient()
        .channel(`schedule-signals:${practiceId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "scheduling",
            table: "schedule_signals",
            filter: `practice_id=eq.${practiceId}`,
          },
          () => bump(),
        )
        .subscribe((status) =>
          setLive(status === "SUBSCRIBED" ? "realtime" : "polling"),
        );
    } catch {
      return;
    }
    return () => {
      void supabaseClient().removeChannel(channel);
    };
  }, [practiceId, bump]);
  return { tick, bump, live };
}

export function PracticeProvider({
  practiceId,
  children,
}: {
  practiceId: string;
  children: React.ReactNode;
}) {
  const session = useSession();
  const client = useMemo(
    () => practiceClient(session.headers, practiceId),
    [session.headers, practiceId],
  );
  const [data, setData] = useState<PracticeContextData | null>(null);
  const [error, setError] = useState("");
  const { tick, bump, live } = useLiveTick(practiceId);
  const load = useCallback(async () => {
    try {
      setData(await client.get<PracticeContextData>("/context"));
      setError("");
    } catch (e) {
      setError(problem(e));
    }
  }, [client]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const value = useMemo<Practice | null>(() => {
    if (!data) return null;
    const permissions = new Set(data.membership.permissions);
    const byId = <T extends { id: string }>(list: T[]) => {
      const map = new Map(list.map((x) => [x.id, x]));
      return (id: string | null | undefined) => (id ? map.get(id) : undefined);
    };
    return {
      id: practiceId,
      data,
      client,
      tz: data.practice.timezone,
      can: (p) => permissions.has(p),
      location: byId(data.locations),
      practitioner: byId(data.practitioners),
      type: byId(data.appointment_types),
      reload: load,
      tick,
      changed: bump,
      live,
    };
  }, [data, client, practiceId, load, tick, bump, live]);

  if (error && !data)
    return (
      <div className="page">
        <p className="alert" role="alert">
          {error}
        </p>
        <p className="muted">
          <a href="#/practices">Choose another practice</a>
        </p>
      </div>
    );
  if (!value)
    return (
      <div className="page">
        <p className="loading">Loading the practice…</p>
      </div>
    );
  return <PracticeCtx.Provider value={value}>{children}</PracticeCtx.Provider>;
}
