import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CASE_STATES,
  DOCUMENT_TYPES,
  STAFF_ROLES,
  TERMINAL_CASE_STATES,
  WORK_ITEM_KINDS,
  canonicalJson,
  type AnyExtraction,
  type DocumentType,
  type FieldsPatch,
  type StaffRole,
  type WorkItemKind,
} from "@access/contracts";

/**
 * Versioned administrative rule sets. A rule set is typed data evaluated by a
 * deterministic function: there is no expression language, no I/O and no
 * model. The vocabulary deliberately cannot express diagnosis, clinical
 * urgency, prioritisation or treatment suitability.
 */

export const RULE_FIELD_PATHS = [
  "patient.given_name",
  "patient.family_name",
  "patient.date_of_birth",
  "patient.external_id",
  "referrer.name",
  "requested_service",
  "referral_date",
  "funding.type",
  "funding.scheme",
] as const;
export type RuleFieldPath = (typeof RULE_FIELD_PATHS)[number];

const code = z.string().regex(/^[A-Z0-9_]{2,64}$/);
const token = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
const label = z.string().trim().min(1).max(200);
const docs = z.array(z.enum(DOCUMENT_TYPES)).max(10);
const role = z.enum(STAFF_ROLES);
const nonTerminalStates = CASE_STATES.filter(
  (s) => !TERMINAL_CASE_STATES.includes(s),
) as [string, ...string[]];

export const ruleDefinitionSchema = z
  .object({
    schema_version: z.literal("access-rules.v1"),
    case_type: z.literal("REFERRAL"),
    identity: z
      .object({
        min_confidence: z.number().min(0.5).max(1),
        require_external_id: z.boolean(),
      })
      .strict(),
    required_fields: z.array(z.enum(RULE_FIELD_PATHS)).max(20),
    required_documents: docs,
    services: z
      .array(
        z
          .object({
            code,
            label,
            destination_queue: token,
            location: token.optional(),
            required_documents: docs.default([]),
          })
          .strict(),
      )
      .max(200)
      .default([]),
    unknown_service: z
      .enum(["INFORMATION_MISSING", "DEFAULT_ROUTE"])
      .default("INFORMATION_MISSING"),
    default_route: z
      .object({ destination_queue: token, location: token.optional() })
      .strict()
      .nullable()
      .default(null),
    medical_aid: z
      .object({
        required_documents: docs.default([]),
        required_fields: z
          .array(z.enum(["funding.scheme"]))
          .max(1)
          .default([]),
      })
      .strict()
      .default({ required_documents: [], required_fields: [] }),
    administrative_prerequisites: z
      .array(
        z
          .object({
            code,
            description: label,
            document: z.enum(DOCUMENT_TYPES).optional(),
            field: z.enum(RULE_FIELD_PATHS).optional(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    booking_prerequisites: z
      .object({
        require_destination_reference: z.literal(true),
        required_fields: z.array(z.enum(RULE_FIELD_PATHS)).max(10).default([]),
      })
      .strict(),
    destination: z.object({ mode: z.enum(["CONNECTOR", "MANUAL"]) }).strict(),
    exception_ownership: z
      .partialRecord(z.enum(WORK_ITEM_KINDS), role)
      .default({}),
    follow_up: z
      .object({
        ready_for_booking_hours: z.number().int().min(1).max(1440),
        waiting_hours: z.number().int().min(1).max(1440),
        max_follow_ups: z.number().int().min(0).max(20),
      })
      .strict(),
    escalation: z
      .array(
        z
          .object({
            state: z.enum(nonTerminalStates),
            after_hours: z.number().int().min(1).max(8760),
            owner: role,
          })
          .strict(),
      )
      .max(20)
      .default([]),
    outcome_polling: z
      .object({ interval_minutes: z.number().int().min(1).max(1440) })
      .strict()
      .default({ interval_minutes: 60 }),
  })
  .strict()
  .superRefine((d, ctx) => {
    const duplicate = (name: string, values: readonly string[]) => {
      const seen = new Set<string>();
      for (const v of values) {
        if (seen.has(v))
          ctx.addIssue({
            code: "custom",
            message: `conflicting rule: duplicate ${name} ${v}`,
          });
        seen.add(v);
      }
    };
    duplicate("required field", d.required_fields);
    duplicate("required document", d.required_documents);
    duplicate(
      "service code",
      d.services.map((s) => s.code),
    );
    duplicate(
      "prerequisite code",
      d.administrative_prerequisites.map((p) => p.code),
    );
    duplicate(
      "escalation state",
      d.escalation.map((e) => e.state),
    );
    for (const p of d.administrative_prerequisites)
      if (Boolean(p.document) === Boolean(p.field))
        ctx.addIssue({
          code: "custom",
          message: `prerequisite ${p.code} must name exactly one document or field`,
        });
    if (d.unknown_service === "DEFAULT_ROUTE" && !d.default_route)
      ctx.addIssue({
        code: "custom",
        message: "conflicting rule: DEFAULT_ROUTE requires default_route",
      });
    if (d.services.length === 0 && d.unknown_service === "DEFAULT_ROUTE")
      ctx.addIssue({
        code: "custom",
        message: "conflicting rule: DEFAULT_ROUTE without any services",
      });
    for (const text of collectStrings(d))
      if (CLINICAL_TERMS.test(text))
        ctx.addIssue({
          code: "custom",
          message:
            "rule sets are administrative only; clinical triage, urgency, diagnosis or treatment terms are not permitted",
        });
  });
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;
export type RuleDefinitionInput = z.input<typeof ruleDefinitionSchema>;

/**
 * Defence in depth against smuggling clinical decisions into labels, service
 * codes or queue names. The typed schema already has no clinical fields.
 */
const CLINICAL_TERMS =
  /(triage|urgen|emergen|priorit|diagnos|clinical|acuity|severity|symptom|treatment|suitab|red[\s_-]?flag|contraindicat|prognos)/i;
function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(collectStrings);
  return [];
}

export class RuleValidationError extends Error {
  readonly statusCode = 422;
  readonly code = "RULE_SET_INVALID";
  constructor(readonly issues: string[]) {
    super(`rule set invalid: ${issues.join("; ")}`);
  }
}
export function parseRuleDefinition(input: unknown): RuleDefinition {
  const parsed = ruleDefinitionSchema.safeParse(input);
  if (!parsed.success)
    throw new RuleValidationError(
      parsed.error.issues.map(
        (i) => `${i.path.join(".") || "definition"}: ${i.message}`,
      ),
    );
  return parsed.data;
}
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
/** Hash of the normalised definition; stored and re-verified on load. */
export function definitionHash(definition: RuleDefinition): string {
  return sha256Hex(canonicalJson(definition));
}

export const DEFAULT_RULE_DEFINITION: RuleDefinitionInput = {
  // Reproduces the pre-v1.1 hard-coded behaviour exactly.
  schema_version: "access-rules.v1",
  case_type: "REFERRAL",
  identity: { min_confidence: 0.9, require_external_id: true },
  required_fields: [
    "patient.given_name",
    "patient.family_name",
    "patient.date_of_birth",
    "referrer.name",
  ],
  required_documents: ["referral_letter", "insurance", "demographics"],
  booking_prerequisites: {
    require_destination_reference: true,
    required_fields: [],
  },
  destination: { mode: "CONNECTOR" },
  exception_ownership: {
    SAFETY: "PRACTICE_MANAGER",
    OUTCOME_REVIEW: "PRACTICE_MANAGER",
    ESCALATION: "PRACTICE_MANAGER",
  },
  follow_up: {
    ready_for_booking_hours: 48,
    waiting_hours: 72,
    max_follow_ups: 3,
  },
  escalation: [
    {
      state: "INFORMATION_MISSING",
      after_hours: 72,
      owner: "PRACTICE_MANAGER",
    },
  ],
};

export interface ReferralFacts {
  extraction: AnyExtraction | null;
  supplied_documents: readonly DocumentType[];
  supplied_fields: FieldsPatch;
  identity_confirmed_by_staff: boolean;
}
export interface RuleSetRef {
  id: string;
  version: number;
  definition_hash: string;
  definition: RuleDefinition;
}
export interface RuleDecision {
  schema_version: "rule-decision.v1";
  rule_set_id: string;
  rule_set_version: number;
  definition_hash: string;
  input_hash: string;
  identity: {
    status: "RESOLVED" | "REVIEW";
    reason:
      | "staff_confirmed"
      | "threshold_met"
      | "below_confidence_threshold"
      | "external_id_missing"
      | "no_extraction";
  };
  missing_fields: string[];
  missing_documents: string[];
  unmet_prerequisites: string[];
  service: { code: string; recognised: boolean } | null;
  routing: { destination_queue: string; location: string | null } | null;
  destination_mode: "CONNECTOR" | "MANUAL";
  outcome: "IDENTITY_PENDING" | "INFORMATION_MISSING" | "READY";
  decision_hash: string;
}

function readField(
  facts: ReferralFacts,
  path: RuleFieldPath,
): string | undefined {
  const e = facts.extraction;
  const f = facts.supplied_fields;
  const v2 = e?.schema_version === "referral-extraction.v2" ? e : undefined;
  const value = (() => {
    switch (path) {
      case "patient.given_name":
        return e?.patient.given_name;
      case "patient.family_name":
        return e?.patient.family_name;
      case "patient.date_of_birth":
        return e?.patient.date_of_birth;
      case "patient.external_id":
        return f.patient_external_id ?? e?.patient.external_id;
      case "referrer.name":
        return f.referrer_name ?? e?.referrer.name;
      case "requested_service":
        return f.requested_service ?? v2?.requested_service;
      case "referral_date":
        return f.referral_date ?? v2?.referral_date;
      case "funding.type":
        return f.funding?.type ?? v2?.funding?.type;
      case "funding.scheme":
        return f.funding?.scheme ?? v2?.funding?.scheme;
    }
  })();
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Canonical view of the facts the evaluator reads; hashed, never logged. */
function factInputs(facts: ReferralFacts) {
  return {
    fields: Object.fromEntries(
      RULE_FIELD_PATHS.map((p) => [p, readField(facts, p) ?? null]),
    ),
    documents: documentsOf(facts),
    confidence: facts.extraction?.confidence ?? null,
    identity_confirmed_by_staff: facts.identity_confirmed_by_staff,
  };
}
function documentsOf(facts: ReferralFacts): string[] {
  return [
    ...new Set([
      ...(facts.extraction?.documents ?? []),
      ...facts.supplied_documents,
    ]),
  ].sort();
}

/**
 * Deterministic administrative evaluation. Given the same rule set and the
 * same facts it always returns a byte-identical decision (decision_hash).
 */
export function evaluateReferralRules(
  ruleSet: RuleSetRef,
  facts: ReferralFacts,
): RuleDecision {
  const d = ruleSet.definition;
  const inputs = factInputs(facts);
  const present = new Set(inputs.documents);
  const identity: RuleDecision["identity"] = facts.identity_confirmed_by_staff
    ? { status: "RESOLVED", reason: "staff_confirmed" }
    : !facts.extraction
      ? { status: "REVIEW", reason: "no_extraction" }
      : d.identity.require_external_id &&
          !readField(facts, "patient.external_id")
        ? { status: "REVIEW", reason: "external_id_missing" }
        : facts.extraction.confidence < d.identity.min_confidence
          ? { status: "REVIEW", reason: "below_confidence_threshold" }
          : { status: "RESOLVED", reason: "threshold_met" };

  const serviceCode = readField(facts, "requested_service");
  const service = serviceCode
    ? d.services.find((s) => s.code === serviceCode)
    : undefined;
  const medicalAid = readField(facts, "funding.type") === "MEDICAL_AID";

  const requiredFields = new Set<string>(d.required_fields);
  if (d.services.length) requiredFields.add("requested_service");
  if (medicalAid)
    for (const f of d.medical_aid.required_fields) requiredFields.add(f);
  const missing_fields = [...requiredFields]
    .filter((p) => !readField(facts, p as RuleFieldPath))
    .sort();

  const requiredDocs = new Set<string>(d.required_documents);
  for (const doc of service?.required_documents ?? []) requiredDocs.add(doc);
  if (medicalAid)
    for (const doc of d.medical_aid.required_documents) requiredDocs.add(doc);
  const missing_documents = [...requiredDocs]
    .filter((doc) => !present.has(doc))
    .sort();

  const unmet = new Set<string>();
  for (const p of d.administrative_prerequisites)
    if (
      (p.document && !present.has(p.document)) ||
      (p.field && !readField(facts, p.field))
    )
      unmet.add(p.code);
  let routing: RuleDecision["routing"] = null;
  if (service)
    routing = {
      destination_queue: service.destination_queue,
      location: service.location ?? null,
    };
  else if (serviceCode && d.services.length) {
    if (d.unknown_service === "DEFAULT_ROUTE" && d.default_route)
      routing = {
        destination_queue: d.default_route.destination_queue,
        location: d.default_route.location ?? null,
      };
    else unmet.add("UNKNOWN_SERVICE");
  }
  const unmet_prerequisites = [...unmet].sort();
  const outcome =
    identity.status === "REVIEW"
      ? "IDENTITY_PENDING"
      : missing_fields.length ||
          missing_documents.length ||
          unmet_prerequisites.length
        ? "INFORMATION_MISSING"
        : "READY";
  const body = {
    schema_version: "rule-decision.v1" as const,
    rule_set_id: ruleSet.id,
    rule_set_version: ruleSet.version,
    definition_hash: ruleSet.definition_hash,
    input_hash: sha256Hex(canonicalJson(inputs)),
    identity,
    missing_fields,
    missing_documents,
    unmet_prerequisites,
    service: serviceCode
      ? { code: serviceCode, recognised: Boolean(service) }
      : null,
    routing,
    destination_mode: d.destination.mode,
    outcome,
  } satisfies Omit<RuleDecision, "decision_hash">;
  return { ...body, decision_hash: sha256Hex(canonicalJson(body)) };
}

/** Owner role for a work-item kind under a rule set. */
export function ownerFor(
  definition: RuleDefinition | null,
  kind: WorkItemKind,
): StaffRole {
  return definition?.exception_ownership[kind] ?? "REFERRAL_COORDINATOR";
}

/** Booking prerequisites that are not met; empty means booking may be recorded. */
export function unmetBookingPrerequisites(
  definition: RuleDefinition,
  facts: ReferralFacts,
  destinationReference: string | null,
): string[] {
  const unmet: string[] = [];
  if (
    definition.booking_prerequisites.require_destination_reference &&
    !destinationReference
  )
    unmet.push("destination_reference");
  for (const f of definition.booking_prerequisites.required_fields)
    if (!readField(facts, f)) unmet.push(f);
  return unmet.sort();
}
