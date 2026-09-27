/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_CORE_API_URL?: string;
  /** "supabase" (workforce login) or "synthetic" (local development only). */
  readonly VITE_AUTH_MODE?: "supabase" | "synthetic";
  readonly VITE_SUPABASE_URL?: string;
  /** Public anon key only. Never a service-role key. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
