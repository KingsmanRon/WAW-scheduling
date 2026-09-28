import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * The browser console is public code: it may hold only the Supabase anon
 * key and the API's address, and every authoritative change goes through
 * the Scheduling API. These checks read its source and build it.
 */
const CONSOLE = "apps/console";
const run = promisify(execFile);

async function files(dir: string, pattern: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path, pattern)));
    else if (pattern.test(entry.name)) out.push(path);
  }
  return out;
}
/** The console's code, without comments (which may name what it must not hold). */
async function source(): Promise<{ path: string; text: string }[]> {
  return Promise.all(
    (await files(join(CONSOLE, "src"), /\.(ts|tsx)$/)).map(async (path) => ({
      path,
      text: (await readFile(path, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1"),
    })),
  );
}

describe("the browser console holds no privileged credential and changes nothing directly", () => {
  it("names no server-side secret in its source", async () => {
    const secrets = [
      /service[_-]?role/i,
      /SUPABASE_SERVICE/,
      /sb_secret_/,
      /DATABASE_URL/,
      /ARTIFACT_ENCRYPTION_KEY/,
      /IDENTIFIER_HASH_KEY/,
      /WHATSAPP_(APP_SECRET|VERIFY_TOKEN|[A-Z_]*TOKEN)/,
      /ANTHROPIC_API_KEY/,
      /AUTH_JWT_SECRET/,
      /METRICS_TOKEN/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    const found = (await source()).flatMap(({ path, text }) =>
      secrets.filter((s) => s.test(text)).map((s) => `${path}: ${s}`),
    );
    expect(found).toEqual([]);
  });

  it("reads only the four public build settings", async () => {
    const used = new Set(
      (await source()).flatMap(({ text }) =>
        [...text.matchAll(/import\.meta\.env\.(\w+)/g)].map((m) => m[1]!),
      ),
    );
    expect([...used].sort()).toEqual([
      "VITE_AUTH_MODE",
      "VITE_CORE_API_URL",
      "VITE_SUPABASE_ANON_KEY",
      "VITE_SUPABASE_URL",
    ]);
  });

  it("uses Supabase only to sign in and to hear schedule changes", async () => {
    const direct =
      /supabase\w*(\(\))?\s*\.\s*(from|rpc|storage|schema|functions)\b/;
    const found = (await source())
      .filter(({ text }) => direct.test(text))
      .map(({ path }) => path);
    expect(found).toEqual([]);
    // The only table it subscribes to is the per-practice change signal.
    const tables = (await source()).flatMap(({ text }) =>
      [...text.matchAll(/table:\s*"(\w+)"/g)].map((m) => m[1]),
    );
    expect(tables).toEqual(["schedule_signals"]);
  });

  it("keeps a service key in the build environment out of the bundle", async () => {
    const out = await mkdtemp(join(tmpdir(), "console-build-"));
    const canary = `canary-${randomUUID()}`;
    const key = `service-${canary}`;
    try {
      await run(
        "npx",
        [
          "vite",
          "build",
          "--outDir",
          out,
          "--emptyOutDir",
          "--logLevel",
          "error",
        ],
        {
          cwd: CONSOLE,
          timeout: 150_000,
          env: {
            ...process.env,
            VITE_CORE_API_URL: "https://api.example.test",
            VITE_AUTH_MODE: "supabase",
            VITE_SUPABASE_URL: "https://project.supabase.example",
            VITE_SUPABASE_ANON_KEY: "public-anon-key-for-this-build",
            // As if the build machine also held server secrets.
            SUPABASE_SERVICE_ROLE_KEY: key,
            DATABASE_URL: `postgres://owner:x@db.example.test/${canary}`,
            ANTHROPIC_API_KEY: `sk-ant-${canary}`,
          },
        },
      );
      const bundle = (
        await Promise.all(
          (await files(out, /\.(js|css|html|map)$/)).map((f) =>
            readFile(f, "utf8"),
          ),
        )
      ).join("\n");
      // The scan saw the real bundle: the public settings are in it.
      expect(bundle).toContain("public-anon-key-for-this-build");
      expect(bundle).toContain("https://api.example.test");
      expect(bundle).not.toContain(canary);
      expect(bundle).not.toMatch(/service_role/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 180_000);
});
