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
    const roots = ["apps/core-api/src", "apps/worker/src", "packages/db/src"];
    const offenders: string[] = [];
    for (const root of roots)
      for (const file of await readdir(root)) {
        if (!file.endsWith(".ts")) continue;
        const source = await readFile(join(root, file), "utf8");
        for (const call of source.matchAll(
          /\blog\(\s*"(?:info|warn|error)",\s*"[a-z_]+",\s*\{([^}]*)\}/g,
        )) {
          const keys = [...call[1]!.matchAll(/(?:^|,)\s*([a-z_]+)\s*:/g)].map(
            (m) => m[1]!,
          );
          for (const k of keys)
            if (!LOG_FIELD_ALLOWLIST.has(k) || SENSITIVE_FIELDS.has(k))
              offenders.push(`${root}/${file}: ${k}`);
        }
        // Raw error strings may carry row data or free text.
        if (
          /log\([^)]*error:\s*(String\(|e\.message|error\.message)/.test(source)
        )
          offenders.push(`${root}/${file}: raw error text`);
      }
    expect(offenders).toEqual([]);
  });
});
