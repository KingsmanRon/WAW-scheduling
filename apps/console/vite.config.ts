import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * The built console's Content-Security-Policy, as a meta tag written at
 * build time: it may talk only to its own origin, the Scheduling API and
 * the Supabase project it was built for (HTTPS, and WSS for Realtime). No
 * inline or third-party script, style, font or frame. frame-ancestors is
 * not allowed in a meta policy; the host sends it (apps/console/vercel.json).
 */
function contentSecurityPolicy(env: Record<string, string>): Plugin {
  const origin = (url: string | undefined) => {
    try {
      return url ? new URL(url).origin : null;
    } catch {
      return null;
    }
  };
  const api = origin(env.VITE_CORE_API_URL);
  const supabase = origin(env.VITE_SUPABASE_URL);
  const connect = [
    "'self'",
    api,
    supabase,
    supabase?.replace(/^http/, "ws"),
  ].filter(Boolean);
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "access-content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: policy },
        injectTo: "head-prepend",
      },
    ],
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [contentSecurityPolicy(loadEnv(mode, process.cwd(), "VITE_"))],
  build: {
    rollupOptions: {
      // The console, and the front page signed-out visitors land on.
      input: {
        console: fileURLToPath(new URL("index.html", import.meta.url)),
        welcome: fileURLToPath(new URL("welcome/index.html", import.meta.url)),
      },
    },
  },
}));
