/**
 * Read-only shapes of the API documents the console renders. They mirror
 * apps/core-api (queries.ts, packages/db metrics.ts and rules.ts); the API
 * remains the source of truth and nothing here is sent back to it.
 */
export type CaseState =
  | "RECEIVED"
  | "IDENTITY_PENDING"
  | "INFORMATION_MISSING"
  | "READY"
  | "DESTINATION_PENDING"
  | "READY_FOR_BOOKING"
  | "WAITING"
  | "BOOKED"
  | "CLOSED"
  | "EXCEPTION"
  | "REJECTED";

export type Provenance = "OBSERVED" | "DERIVED" | "ESTIMATED" | "UNKNOWN";
export interface Measure<T = number> {
  value: T | null;
  provenance: Provenance;
  basis: string;
  inputs?: Record<string, unknown>;
}

export interface QueueItem {
  case_id: string;
  display_ref: string;
  state: CaseState;
  age_seconds: number;
  owner: string | null;
  exception_reason: string | null;
  next_action: string;
  destination_status: string;
  outcome_status: string;
  open_work_items: string[];
  follow_up_due_at?: string | null;
}

export interface WorkItem {
  id: string;
  kind: string;
  status: string;
  reason: string;
  owner_role: string | null;
  due_at: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}
export interface Transition {
  from_state: CaseState | null;
  to_state: CaseState;
  version: number;
  actor_type: string;
  actor_id: string;
  reason: string;
  occurred_at: string;
}
export interface Interaction {
  id: string;
  channel: string;
  actor_type: string;
  intent: string;
  received_at: string;
}
export interface Observation {
  id: string;
  observation_type: string;
  occurred_at: string;
  source_type: string;
  verification_level: string;
  disposition: string;
  disposition_reason: string | null;
}
export interface Execution {
  id: string;
  operation: string;
  status: string;
  attempts: number;
  reconcile_attempts: number;
  last_error: string | null;
  escalated_at: string | null;
  superseded_at: string | null;
  superseded_reason: string | null;
  created_at: string;
}
export interface EvidenceEvent {
  sequence: number;
  event_type: string;
  aggregate_version: number;
  actor_type: string | null;
  actor_id: string | null;
  hash: string;
  created_at: string;
}
export interface RuleDecision {
  outcome: string;
  definition_hash: string;
  decision_hash: string;
  identity: { status: string; reason: string };
  missing_documents: string[];
  missing_fields: string[];
  unmet_prerequisites: string[];
  routing: { destination_queue: string; location?: string | null } | null;
  service?: { code: string } | null;
}
export interface CaseView {
  case: {
    id: string;
    display_ref: string;
    source_channel: string;
    current_state: CaseState;
    current_owner: string | null;
    exception_reason: string | null;
    opened_at: string;
    outcome_at: string | null;
    resolution_code: string | null;
    resolution_source: string | null;
    version: number;
  };
  referral: {
    extraction: {
      patient?:
        | {
            given_name: string;
            family_name: string;
            date_of_birth: string;
            external_id?: string;
          }
        | string;
      documents?: string[];
      provenance?: string;
    } | null;
    referring_provider: string | null;
    requested_service: string | null;
    identity_status: string | null;
    identity_confirmed_by: string | null;
    completeness_status: string;
    supplied_documents: string[] | null;
    rule_set_version: number | null;
    rule_decision: RuleDecision | null;
    destination_mode: "CONNECTOR" | "MANUAL" | null;
    destination_reference: string | null;
    destination_reference_source: string | null;
    follow_up_due_at: string | null;
    follow_up_count: number;
  } | null;
  next_action: string;
  interactions: Interaction[];
  observations: Observation[];
  evidence: {
    verification: { valid: boolean; events: number };
    events: EvidenceEvent[];
  };
  work_items: WorkItem[];
  executions: Execution[];
  transitions: Transition[];
  metrics: Record<string, Measure<number | boolean | string> | string>;
}

export interface Cohort {
  period: { from: string; to: string };
  referrals_received: Measure;
  verified: Measure;
  ready_for_booking: Measure;
  booked: Measure;
  closed_without_booking: Measure;
  closed_unknown_outcome: Measure;
  still_open: Measure;
  booking_conversion_rate: Measure;
  cohort_booking_rate: Measure;
  median_received_to_verified_seconds: Measure;
  median_received_to_ready_seconds: Measure;
  p95_received_to_ready_seconds: Measure;
  median_received_to_booked_seconds: Measure;
  exception_rate: Measure;
  human_touch_rate: Measure;
  human_touches_per_referral: Measure;
  status_contacts_per_referral: Measure;
  staff_seconds_per_referral: Measure;
  outcomes_awaiting_review: Measure;
  top_closure_reasons: { code: string; count: number }[];
  top_exception_reasons: { kind: string; count: number }[];
  open_by_state: { state: CaseState; count: number }[];
  median_seconds_in_state: {
    state: CaseState;
    median_seconds: number;
    samples: number;
  }[];
}

export interface RuleDefinition {
  schema_version?: string;
  identity?: { min_confidence?: number; require_external_id?: boolean };
  required_fields?: string[];
  required_documents?: string[];
  services?: {
    code: string;
    label: string;
    destination_queue: string;
    location?: string;
    required_documents?: string[];
  }[];
  unknown_service?: string;
  default_route?: { destination_queue: string; location?: string } | null;
  medical_aid?: { required_documents?: string[]; required_fields?: string[] };
  administrative_prerequisites?: {
    code: string;
    description: string;
    document?: string;
    field?: string;
  }[];
  booking_prerequisites?: {
    require_destination_reference?: boolean;
    required_fields?: string[];
  };
  destination?: { mode?: "CONNECTOR" | "MANUAL" };
  exception_ownership?: Record<string, string>;
  follow_up?: {
    ready_for_booking_hours?: number;
    waiting_hours?: number;
    max_follow_ups?: number;
  };
  escalation?: { state: string; after_hours: number; owner: string }[];
  outcome_polling?: { interval_minutes?: number };
}
export interface RuleSet {
  id: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  definition: RuleDefinition;
  definition_hash: string;
  effective_from: string | null;
  effective_to: string | null;
  published_by: string | null;
  published_at: string | null;
  created_by: string;
  created_at: string;
}
