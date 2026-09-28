import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LOG_FIELD_ALLOWLIST,
  SENSITIVE_FIELDS,
  errorFields,
  log,
  setLogSink,
} from "../../packages/observability/src/index.js";

describe("privacy-safe logging", () => {
  it("drops unknown fields and redacts sensitive ones at any depth", () => {
    const lines: string[] = [];
    const previous = setLogSink((l) => lines.push(l));
    try {
      log("info", "probe", {
        case_id: "c",
        given_name: "Jane",
        date_of_birth: "1980-01-01",
        medical_aid_number: "12345",
        id_number: "8001015009087",
        note: "patient said...",
        extraction: { patient: { family_name: "Example" } },
        free_text: "Referral for chest pain",
        state: { nested: { reason: "knee" } },
      });
    } finally {
      setLogSink(previous);
    }
    const out = lines[0]!;
    for (const secret of [
      "Jane",
      "1980-01-01",
      "12345",
      "8001015009087",
      "patient said",
      "Example",
      "chest pain",
      "knee",
    ])
      expect(out).not.toContain(secret);
    expect(JSON.parse(out)).toMatchObject({
      case_id: "c",
      free_text: "[DROPPED]",
      given_name: "[REDACTED]",
    });
  });
  it("error details never include messages", () => {
    const e = Object.assign(new Error("duplicate key (Jane Example)"), {
      code: "23505",
    });
    expect(JSON.stringify(errorFields(e))).not.toContain("Jane");
  });
  it("every log call site uses only allow-listed field names", async () => {
    // Every server-side source file (apps and packages, all depths).
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (["node_modules", "dist"].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
          files.push(path);
      }
    };
    await walk("apps/core-api/src");
    await walk("apps/worker/src");
    for (const pkg of await readdir("packages"))
      await walk(join("packages", pkg, "src"));
    expect(files.length).toBeGreaterThan(60);
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const call of source.matchAll(
        /\blog\(\s*"(?:info|warn|error)",\s*"[a-z_]+",\s*\{([^}]*)\}/g,
      )) {
        const keys = [...call[1]!.matchAll(/(?:^|,)\s*([a-z_]+)\s*:/g)].map(
          (m) => m[1]!,
        );
        for (const k of keys)
          if (!LOG_FIELD_ALLOWLIST.has(k) || SENSITIVE_FIELDS.has(k))
            offenders.push(`${file}: ${k}`);
      }
      // Raw error strings may carry row data or free text.
      if (
        /log\([^)]*error:\s*(String\(|e\.message|error\.message)/.test(source)
      )
        offenders.push(`${file}: raw error text`);
    }
    expect(offenders).toEqual([]);
  });
});
