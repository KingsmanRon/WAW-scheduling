import {
  anyExtractionSchema,
  extractedReferralV2Schema,
  type AnyExtraction,
  type ExtractedReferral,
  type StructuredReferral,
} from "@access/contracts";
import { assertClean, type ScanStatus } from "./scanner.js";

/**
 * Extraction port. v1.1 ships two deterministic implementations and no model:
 * the synthetic fixture extractor and staff-entered structured intake. Both
 * can only produce administrative fields; neither classifies clinically.
 */
export type ExtractionOutcome =
  | { kind: "extracted"; extraction: AnyExtraction }
  | { kind: "none" }
  | { kind: "safety_hold"; reason: "urgent_or_clinical_content" };
export interface ExtractionPort {
  extract(input: {
    bytes: Uint8Array;
    scan: { status: ScanStatus };
    fixture?: string | undefined;
    structured?: StructuredReferral | undefined;
  }): Promise<ExtractionOutcome>;
}

/** Deterministic synthetic fixtures (development and synthetic staging). */
export class FixtureExtractor {
  async extract(
    _bytes: Uint8Array,
    fixture: string,
  ): Promise<ExtractedReferral> {
    const base: ExtractedReferral = {
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
    if (fixture === "missing-insurance")
      base.documents = ["referral_letter", "demographics"];
    if (fixture === "ambiguous-identity") {
      delete base.patient.external_id;
      base.confidence = 0.55;
    }
    if (fixture === "urgent")
      throw Object.assign(
        new Error("clinical or urgent content outside administrative scope"),
        { code: "URGENT_CONTENT" },
      );
    return base;
  }
}

/** Staff key in the administrative fields; provenance says so. */
export function structuredToExtraction(s: StructuredReferral): AnyExtraction {
  return extractedReferralV2Schema.parse({
    schema_version: "referral-extraction.v2",
    patient: s.patient,
    referrer: s.referrer,
    ...(s.reason ? { reason: s.reason } : {}),
    ...(s.requested_service ? { requested_service: s.requested_service } : {}),
    ...(s.referral_date ? { referral_date: s.referral_date } : {}),
    ...(s.funding ? { funding: s.funding } : {}),
    documents: [...new Set(s.documents)],
    // Not a model confidence: the fields were entered by a person.
    confidence: 1,
    provenance: "STAFF_ENTERED",
  });
}

export class IntakeExtractor implements ExtractionPort {
  private fixtures = new FixtureExtractor();
  constructor(private options: { fixturesAllowed: boolean }) {}
  async extract(
    input: Parameters<ExtractionPort["extract"]>[0],
  ): Promise<ExtractionOutcome> {
    assertClean(input.scan);
    if (input.structured) {
      if (input.structured.safety_flag)
        return { kind: "safety_hold", reason: "urgent_or_clinical_content" };
      return {
        kind: "extracted",
        extraction: structuredToExtraction(input.structured),
      };
    }
    if (input.fixture) {
      if (!this.options.fixturesAllowed)
        throw Object.assign(new Error("fixture extraction is synthetic-only"), {
          statusCode: 422,
          code: "FIXTURE_REFUSED",
        });
      try {
        const extracted = await this.fixtures.extract(
          input.bytes,
          input.fixture,
        );
        return {
          kind: "extracted",
          extraction: anyExtractionSchema.parse(extracted),
        };
      } catch (e) {
        if ((e as { code?: string }).code === "URGENT_CONTENT")
          return { kind: "safety_hold", reason: "urgent_or_clinical_content" };
        throw e;
      }
    }
    return { kind: "none" };
  }
}
