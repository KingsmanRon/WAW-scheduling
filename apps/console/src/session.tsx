import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export const API_URL =
  import.meta.env.VITE_CORE_API_URL ?? "http://localhost:3001";
export const AUTH_MODE = import.meta.env.VITE_AUTH_MODE ?? "synthetic";

let supabase: SupabaseClient | undefined;
export function supabaseClient(): SupabaseClient {
  if (!supabase) {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anon)
      throw new Error(
        "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required",
      );
    supabase = createClient(url, anon, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return supabase;
}

export interface Me {
  user_id: string;
  tenant_id: string;
  role: "ADMIN" | "PRACTICE_MANAGER" | "REFERRAL_COORDINATOR" | "READ_ONLY";
  auth_mode: "jwt" | "synthetic";
  profile: string;
  data_mode: string;
}
export interface SyntheticIdentity {
  tenant: string;
  role: Me["role"];
  user: string;
}
interface Session {
  me: Me | null;
  headers(): Promise<Record<string, string>>;
  selectTenant(tenantId: string | null): void;
  tenant: string | null;
  synthetic: SyntheticIdentity | null;
  signInSynthetic(identity: SyntheticIdentity): void;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  error: string;
}
const SessionContext = createContext<Session | null>(null);
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("session unavailable");
  return s;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [tenant, setTenant] = useState<string | null>(null);
  // Synthetic development identity survives a reload within the tab only.
  const [synthetic, setSynthetic] = useState<SyntheticIdentity | null>(() => {
    try {
      const raw =
        AUTH_MODE === "synthetic"
          ? sessionStorage.getItem("access-synthetic")
          : null;
      return raw ? (JSON.parse(raw) as SyntheticIdentity) : null;
    } catch {
      return null;
    }
  });
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);

  const session = useMemo<Session>(() => {
    const headers = async () => {
      const h: Record<string, string> = {
        "x-correlation-id": crypto.randomUUID(),
      };
      if (AUTH_MODE === "supabase") {
        const { data } = await supabaseClient().auth.getSession();
        if (data.session)
          h.authorization = `Bearer ${data.session.access_token}`;
        if (tenant) h["x-access-tenant"] = tenant;
      } else if (synthetic) {
        h["x-tenant-id"] = synthetic.tenant;
        h["x-access-role"] = synthetic.role;
        h["x-access-user"] = synthetic.user;
      }
      return h;
    };
    return {
      me,
      tenant,
      synthetic,
      error,
      headers,
      selectTenant: (id) => {
        setTenant(id);
        setVersion((v) => v + 1);
      },
      signInSynthetic: (identity) => {
        try {
          sessionStorage.setItem("access-synthetic", JSON.stringify(identity));
        } catch {
          // storage unavailable: identity lasts until reload
        }
        setSynthetic(identity);
        setVersion((v) => v + 1);
      },
      signOut: async () => {
        if (AUTH_MODE === "supabase") await supabaseClient().auth.signOut();
        try {
          sessionStorage.removeItem("access-synthetic");
        } catch {
          // nothing stored
        }
        setSynthetic(null);
        setMe(null);
        setTenant(null);
      },
      refresh: async () => setVersion((v) => v + 1),
    };
  }, [me, tenant, synthetic, error]);

  useEffect(() => {
    if (AUTH_MODE !== "supabase") return;
    const { data } = supabaseClient().auth.onAuthStateChange(() =>
      setVersion((v) => v + 1),
    );
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (AUTH_MODE === "synthetic" && !synthetic) return setMe(null);
      const res = await fetch(`${API_URL}/v1/me`, {
        headers: await session.headers(),
      }).catch(() => null);
      if (cancelled) return;
      if (!res) return setError("The ACCESS API is unreachable.");
      if (res.status === 401) return setMe(null);
      const body = await res.json();
      if (!res.ok) {
        setMe(null);
        setError(
          body.error === "TENANT_SELECTION_REQUIRED"
            ? "TENANT_SELECTION_REQUIRED"
            : (body.message ?? "Access denied"),
        );
        return;
      }
      setError("");
      setMe(body);
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}
