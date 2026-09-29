import { describe, expect, it } from "vitest";
import {
  caseActionSchema,
  canonicalJson,
  connectorResultSchema,
  ENABLED_CHANNELS,
  ingestRequestSchema,
  observationImportSchema,
} from "../../packages/contracts/src/index.js";

describe("contracts", () => {
  it("rejects unversioned and unknown external input", () => {
    expect(() => connectorResultSchema.parse({ status: "OK" })).toThrow();
    expect(() => ingestRequestSchema.parse({ unexpected: true })).toThrow();
  });
  it("deliberate closure requires a resolution code and a note", () => {
    const base = {
      command_id: crypto.randomUUID(),
      correlation_id: crypto.randomUUID(),
      expected_version: 3,
    };
    expect(() =>
      caseActionSchema.parse({ action: "close", ...base, note: "closing" }),
    ).toThrow();
    expect(() =>
      caseActionSchema.parse({
        action: "close",
        ...base,
        resolution_code: "CANCELLED",
        note: "  ",
      }),
    ).toThrow();
    expect(
      caseActionSchema.parse({
        action: "close",
        ...base,
        resolution_code: "CANCELLED",
        note: "patient moved",
      }).action,
    ).toBe("close");
  });
  it("only STAFF_UPLOAD and API are enabled channels", () =>
    expect(ENABLED_CHANNELS).toEqual(["STAFF_UPLOAD", "API"]));
  it("import rows carry an external source reference for idempotency", () => {
    expect(() =>
      observationImportSchema.parse({
        command_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        source_label: "pms-export",
        rows: [
          {
            case_id: crypto.randomUUID(),
            observation_type: "APPOINTMENT_BOOKED",
            occurred_at: new Date().toISOString(),
          },
        ],
      }),
    ).toThrow();
  });
  it("canonical JSON is key-order independent", () =>
    expect(
      canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } }),
    ).toBe(canonicalJson({ a: { c: null, d: [2, { x: 0, y: 1 }] }, b: 1 })));
});
