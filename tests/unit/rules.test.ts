import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULE_DEFINITION,
  definitionHash,
  evaluateReferralRules,
  parseRuleDefinition,
  RuleValidationError,
  unmetBookingPrerequisites,
  type ReferralFacts,
} from "../../packages/rules/src/index.js";
import type { ExtractedReferral } from "../../packages/contracts/src/index.js";

const extraction: ExtractedReferral = {
  schema_version: "referral-extraction.v1",
  patient: {
    given_name: "Synthetic",
    family_name: "Patient",
    date_of_birth: "1980-01-01",
    external_id: "SYN-001",
  },
  referrer: { name: "Dr Fixture" },
  reason: "Synthetic knee assessment",
  documents: ["referral_letter", "insurance", "demographics"],
  confidence: 0.98,
};
const facts = (overrides: Partial<ReferralFacts> = {}): ReferralFacts => ({
  extraction,
  supplied_documents: [],
  supplied_fields: {},
  identity_confirmed_by_staff: false,
  ...overrides,
});
const ref = (definition = parseRuleDefinition(DEFAULT_RULE_DEFINITION)) => ({
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  definition_hash: definitionHash(definition),
  definition,
});

describe("rule set validation", () => {
  it("rejects malformed definitions", () => {
    expect(() =>
      parseRuleDefinition({ schema_version: "access-rules.v1" }),
    ).toThrow(RuleValidationError);
    expect(() =>
      parseRuleDefinition({ ...DEFAULT_RULE_DEFINITION, unexpected: true }),
    ).toThrow(RuleValidationError);
    expect(() =>
      parseRuleDefinition({
        ...DEFAULT_RULE_DEFINITION,
        identity: { min_confidence: 2, require_external_id: true },
      }),
    ).toThrow();
  });
  it("rejects conflicting definitions", () => {
    expect(() =>
      parseRuleDefinition({
        ...DEFAULT_RULE_DEFINITION,
        required_documents: ["insurance", "insurance"],
      }),
    ).toThrow(/duplicate/);
    const service = {
      code: "ORTHO_CONSULT",
      label: "Orthopaedic consult",
      destination_queue: "ortho",
    };
    expect(() =>
      parseRuleDefinition({
        ...DEFAULT_RULE_DEFINITION,
        services: [service, service],
      }),
    ).toThrow(/duplicate service/);
    expect(() =>
      parseRuleDefinition({
        ...DEFAULT_RULE_DEFINITION,
        services: [service],
        unknown_service: "DEFAULT_ROUTE",
      }),
    ).toThrow(/default_route/);
    expect(() =>
      parseRuleDefinition({
        ...DEFAULT_RULE_DEFINITION,
        administrative_prerequisites: [
          {
            code: "BOTH",
            description: "x",
            document: "insurance",
            field: "referral_date",
          },
        ],
      }),
    ).toThrow(/exactly one/);
  });
  it("refuses clinical triage, urgency, diagnosis or treatment terms", () => {
    for (const label of [
      "Urgent oncology",
      "Triage queue",
      "Diagnosis confirmed",
      "Treatment suitability",
      "Priority 1",
    ])
      expect(() =>
        parseRuleDefinition({
          ...DEFAULT_RULE_DEFINITION,
          services: [{ code: "SVC", label, destination_queue: "q" }],
        }),
      ).toThrow(/administrative only/);
    expect(() =>
      parseRuleDefinition({
        ...DEFAULT_RULE_DEFINITION,
        services: [
          {
            code: "URGENT_CARDIO",
            label: "Cardiology",
            destination_queue: "q",
          },
        ],
      }),
    ).toThrow(/administrative only/);
    // The typed schema has nowhere to put a clinical field at all.
    expect(() =>
      parseRuleDefinition({
        ...DEFAULT_RULE_DEFINITION,
        clinical_priority: [],
      }),
    ).toThrow();
  });
  it("hashes the normalised definition deterministically", () => {
    const a = parseRuleDefinition(DEFAULT_RULE_DEFINITION);
    const b = parseRuleDefinition(
      JSON.parse(JSON.stringify(DEFAULT_RULE_DEFINITION)),
    );
    expect(definitionHash(a)).toBe(definitionHash(b));
    expect(
      definitionHash(
        parseRuleDefinition({
          ...DEFAULT_RULE_DEFINITION,
          destination: { mode: "MANUAL" },
        }),
      ),
    ).not.toBe(definitionHash(a));
  });
});

describe("deterministic evaluation", () => {
  it("default rule set reproduces the v1 hard-coded behaviour", () => {
    expect(evaluateReferralRules(ref(), facts()).outcome).toBe("READY");
    const noInsurance = evaluateReferralRules(
      ref(),
      facts({
        extraction: {
          ...extraction,
          documents: ["referral_letter", "demographics"],
        },
      }),
    );
    expect(noInsurance.outcome).toBe("INFORMATION_MISSING");
    expect(noInsurance.missing_documents).toEqual(["insurance"]);
    const ambiguous = evaluateReferralRules(
      ref(),
      facts({
        extraction: {
          ...extraction,
          confidence: 0.55,
          patient: { ...extraction.patient, external_id: undefined as never },
        },
      }),
    );
    expect(ambiguous.outcome).toBe("IDENTITY_PENDING");
    expect(
      evaluateReferralRules(
        ref(),
        facts({ extraction: { ...extraction, confidence: 0.89 } }),
      ).identity.reason,
    ).toBe("below_confidence_threshold");
  });
  it("same inputs always produce the same decision hash", () => {
    const a = evaluateReferralRules(ref(), facts());
    const b = evaluateReferralRules(ref(), facts({ supplied_documents: [] }));
    expect(a.decision_hash).toBe(b.decision_hash);
    expect(a.decision_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("staff confirmation and supplied documents are honoured", () => {
    const d = evaluateReferralRules(
      ref(),
      facts({
        extraction: {
          ...extraction,
          confidence: 0.2,
          documents: ["referral_letter", "demographics"],
        },
        identity_confirmed_by_staff: true,
        supplied_documents: ["insurance"],
      }),
    );
    expect(d.identity).toEqual({
      status: "RESOLVED",
      reason: "staff_confirmed",
    });
    expect(d.outcome).toBe("READY");
  });
  it("routes by requested service and applies medical-aid prerequisites", () => {
    const definition = parseRuleDefinition({
      ...DEFAULT_RULE_DEFINITION,
      services: [
        {
          code: "ORTHO_CONSULT",
          label: "Orthopaedic consult",
          destination_queue: "ortho",
          location: "main",
          required_documents: ["consent_form"],
        },
      ],
      medical_aid: {
        required_documents: ["medical_aid_card"],
        required_fields: ["funding.scheme"],
      },
    });
    const missingService = evaluateReferralRules(ref(definition), facts());
    expect(missingService.missing_fields).toContain("requested_service");
    const routed = evaluateReferralRules(
      ref(definition),
      facts({
        supplied_fields: {
          requested_service: "ORTHO_CONSULT",
          funding: { type: "MEDICAL_AID" },
        },
        supplied_documents: ["consent_form"],
      }),
    );
    expect(routed.routing).toEqual({
      destination_queue: "ortho",
      location: "main",
    });
    expect(routed.missing_documents).toEqual(["medical_aid_card"]);
    expect(routed.missing_fields).toEqual(["funding.scheme"]);
    const unknown = evaluateReferralRules(
      ref(definition),
      facts({ supplied_fields: { requested_service: "PHYSIO" } }),
    );
    expect(unknown.unmet_prerequisites).toContain("UNKNOWN_SERVICE");
  });
  it("booking prerequisites require a destination reference", () => {
    const d = parseRuleDefinition(DEFAULT_RULE_DEFINITION);
    expect(unmetBookingPrerequisites(d, facts(), null)).toEqual([
      "destination_reference",
    ]);
    expect(unmetBookingPrerequisites(d, facts(), "PMS-1")).toEqual([]);
  });
});
