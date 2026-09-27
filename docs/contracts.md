# Contracts

Schemas live in `packages/contracts/src/index.ts` (zod, strict). All write
endpoints take a client-generated `command_id` (idempotency) and
`correlation_id`. Authentication: `Authorization: Bearer <Supabase JWT>`
(optionally `x-access-tenant` to choose among your memberships). Synthetic
development mode uses `x-tenant-id`, `x-access-role`, `x-access-user`.

## Idempotency

`command_id` is bound to a SHA-256 fingerprint of the material request
(content digest, not base64). Same id + same request → the stored response
with `deduplicated: true` and no side effects (no scan, object, row,
evidence, execution). Same id + different request → `409
IDEMPOTENCY_CONFLICT`. Interactions are additionally unique on
`idempotency_key` (defaults to `command:<command_id>`).

## HTTP API

| Method & path                                                          | Role                                        | Purpose                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /ready`                                            | —                                           | liveness / database readiness                                                                                               |
| `GET /v1/me`                                                           | any member                                  | identity, tenant, role, profile, data mode                                                                                  |
| `POST /v1/referrals`                                                   | coordinator+                                | intake: document + `structured` fields (or synthetic `fixture`)                                                             |
| `POST /v1/cases`                                                       | coordinator+                                | generic creation; only `case_type: REFERRAL` executes                                                                       |
| `GET /v1/case-types`                                                   | any                                         | enabled/disabled case types                                                                                                 |
| `GET /v1/cases?filter=`                                                | any                                         | queue (`needs_attention identity_pending information_missing ready ready_for_booking waiting booked closed exceptions all`) |
| `GET /v1/cases/:id`                                                    | any (patient details hidden from READ_ONLY) | case detail, timeline, evidence, metrics                                                                                    |
| `GET /v1/cases/:id/evidence/verify`                                    | any                                         | chain verification                                                                                                          |
| `POST /v1/cases/:id/interactions`                                      | coordinator+                                | `MISSING_INFORMATION` (optional document), `STATUS_ENQUIRY`, `OUTCOME_REPORT`, `OTHER`                                      |
| `POST /v1/cases/:id/actions`                                           | per action                                  | staff actions (below)                                                                                                       |
| `POST /v1/observations/import`                                         | practice manager+                           | outcome rows from a destination export                                                                                      |
| `GET /v1/metrics/cohort?from&to`                                       | any                                         | dashboard measures with provenance                                                                                          |
| `GET/POST /v1/rule-sets`, `POST /v1/rule-sets/:id/publish`, `…/retire` | read any / write ADMIN                      | versioned rules                                                                                                             |
| `GET/POST /v1/admin/memberships`                                       | ADMIN                                       | workforce membership in own organisation                                                                                    |
| `GET /v1/referrals/:id`, `POST /v1/referrals/:id/resolve`              | as above                                    | v1 compatibility                                                                                                            |

### Staff actions (`caseActionSchema`)

Every action needs `expected_version` and a non-empty `note`; `staff_seconds`
is optional (unknown stays unknown).

| Action                                                                 | When                                                              | Effect                                                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `confirm_identity`                                                     | IDENTITY_PENDING                                                  | staff attests identity; rules re-evaluated                                                                  |
| `provide_information`                                                  | IDENTITY_PENDING, INFORMATION_MISSING, EXCEPTION (no safety hold) | documents / fields / structured intake; rules re-evaluated                                                  |
| `resolve_exception`                                                    | open work item                                                    | `safety_reviewed`, `file_reviewed`, `acknowledge`, `retry_destination` (attestation needed after ambiguity) |
| `record_destination_reference`                                         | READY (manual) or EXCEPTION with destination item                 | manual destination → READY_FOR_BOOKING                                                                      |
| `record_follow_up`                                                     | READY_FOR_BOOKING/WAITING                                         | follow-up effort, → WAITING                                                                                 |
| `record_booking`                                                       | READY_FOR_BOOKING/WAITING                                         | APPOINTMENT_BOOKED (human-attested) → BOOKED; booking prerequisites enforced                                |
| `record_patient_unreachable` / `_declined`, `record_provider_declined` | bookable or pre-destination                                       | → CLOSED with that code                                                                                     |
| `close`                                                                | non-terminal, not in flight                                       | → CLOSED with `resolution_code` (not BOOKED)                                                                |
| `reject`                                                               | pre-destination / EXCEPTION                                       | → REJECTED (`INVALID_REFERRAL`/`DUPLICATE_REFERRAL`)                                                        |
| `correct_outcome`                                                      | BOOKED/CLOSED + observation under review; manager+                | audited terminal correction                                                                                 |

No action records or requires a clinical judgement.

## Connector contracts

- `connector-request.v1`: `execution_id tenant_id case_id subject operation correlation_id payload`.
- `connector-result.v1`: `SUCCEEDED(external_id) | RETRYABLE(code) | PERMANENT(code) | DEFERRED | AMBIGUOUS | UNSUPPORTED_OPERATION`, always echoing `execution_id`.
- `referral-status.v1`, `appointment-outcome.v1` (with a stable `source_reference` so re-reads are idempotent).

## Rule decisions

`rule-decision.v1`: rule-set id/version/definition hash, input hash, identity
status and reason, missing fields/documents, unmet prerequisites, service,
routing, destination mode, outcome, decision hash. See `docs/rules-guide.md`.

## Measures

`{ value, provenance: OBSERVED|DERIVED|ESTIMATED|UNKNOWN, basis, inputs? }`.
Case: `received_to_verified_seconds`, `verified_to_destination_seconds`,
`received_to_ready_for_booking_seconds`, `received_to_booked_seconds`,
`staff_seconds`, `human_touch_count`, `status_enquiry_count`,
`follow_up_count`, `correction_count`, `exception_count`,
`booking_conversion`, `closure_reason`. Cohort: `referrals_received`,
`verified`, `ready_for_booking`, `booked`, `closed_without_booking`,
`closed_unknown_outcome`, `still_open`, `booking_conversion_rate` (known
outcomes only), `cohort_booking_rate`, median/p95 times, `exception_rate`,
`human_touch_rate`, `human_touches_per_referral`,
`status_contacts_per_referral`, `staff_seconds_per_referral`, top closure and
exception reasons, open by state, median time in state.
