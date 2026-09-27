# Administrative rules configuration

Rule sets are organisation-specific, versioned JSON documents
(`access-rules.v1`, schema in `packages/rules`). They decide **administrative
readiness only**: required fields and documents, identity sufficiency,
routing, medical-aid prerequisites, booking prerequisites, ownership,
follow-up intervals and escalation. They cannot express triage, urgency,
diagnosis or treatment — the schema has no such fields, and any label or code
containing clinical decision terms (triage, urgent, priority, diagnosis,
clinical, severity, treatment, …) is rejected.

## Lifecycle

1. ADMIN creates a draft: `POST /v1/rule-sets {command_id, definition}` →
   validated, normalised, hashed, next version number.
2. ADMIN publishes: `POST /v1/rule-sets/:id/publish {command_id, effective_from?}`.
   The open ACTIVE version's window is closed at that instant; only one
   version can apply at any time (database exclusion constraint).
3. Published versions are immutable. A change is a new version.
4. `…/retire` stops a version applying to new cases. Existing cases keep
   the version they were decided under (it is re-verified by hash on load).
5. Every decision stores rule-set id, version, definition hash, input hash and
   decision hash; replaying `evaluateReferralRules` over the stored inputs
   reproduces the decision byte-for-byte (acceptance test 15).

## Definition

```json
{
  "schema_version": "access-rules.v1",
  "case_type": "REFERRAL",
  "identity": { "min_confidence": 0.9, "require_external_id": true },
  "required_fields": [
    "patient.given_name",
    "patient.family_name",
    "patient.date_of_birth",
    "referrer.name"
  ],
  "required_documents": ["referral_letter", "insurance", "demographics"],
  "services": [
    {
      "code": "ORTHO_CONSULT",
      "label": "Orthopaedic consultation",
      "destination_queue": "ortho",
      "location": "main",
      "required_documents": ["consent_form"]
    }
  ],
  "unknown_service": "INFORMATION_MISSING",
  "default_route": null,
  "medical_aid": {
    "required_documents": ["medical_aid_card"],
    "required_fields": ["funding.scheme"]
  },
  "administrative_prerequisites": [
    {
      "code": "REFERRAL_DATED",
      "description": "Referral letter is dated",
      "field": "referral_date"
    }
  ],
  "booking_prerequisites": {
    "require_destination_reference": true,
    "required_fields": []
  },
  "destination": { "mode": "MANUAL" },
  "exception_ownership": {
    "SAFETY": "PRACTICE_MANAGER",
    "OUTCOME_REVIEW": "PRACTICE_MANAGER"
  },
  "follow_up": {
    "ready_for_booking_hours": 48,
    "waiting_hours": 72,
    "max_follow_ups": 3
  },
  "escalation": [
    {
      "state": "INFORMATION_MISSING",
      "after_hours": 72,
      "owner": "PRACTICE_MANAGER"
    }
  ],
  "outcome_polling": { "interval_minutes": 60 }
}
```

Field paths: `patient.given_name`, `patient.family_name`,
`patient.date_of_birth`, `patient.external_id`, `referrer.name`,
`requested_service`, `referral_date`, `funding.type`, `funding.scheme`.
Documents: `referral_letter insurance demographics medical_aid_card
identity_document consent_form prior_results`.

## Evaluation order

Identity (staff confirmation, else external ID + confidence threshold) →
missing fields → missing documents (global ∪ service ∪ medical aid) → unmet
prerequisites (including `UNKNOWN_SERVICE`) → outcome `IDENTITY_PENDING |
INFORMATION_MISSING | READY`. `READY` + `CONNECTOR` enqueues the destination
action; `READY` + `MANUAL` opens a destination-entry work item.

Validation also rejects duplicates (fields, documents, service codes,
prerequisite codes, escalation states), a prerequisite naming both or neither
of a document and a field, and `DEFAULT_ROUTE` without a route.

The default rule set (`DEFAULT_RULE_DEFINITION`) reproduces v1 behaviour;
`npm run tenant:bootstrap` uses it with `MANUAL` destination unless
`RULES_FILE` is supplied.
