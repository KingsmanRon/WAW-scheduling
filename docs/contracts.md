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

| Method & path                                                          | Role                                             | Purpose                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /ready`                                            | —                                                | liveness / database readiness                                                                                                                                           |
| `GET /v1/me`                                                           | any member                                       | identity, tenant, role, profile, data mode                                                                                                                              |
| `POST /v1/referrals`                                                   | coordinator+                                     | intake: document + `structured` fields (or synthetic `fixture`)                                                                                                         |
| `POST /v1/cases`                                                       | coordinator+                                     | generic creation; only `case_type: REFERRAL` is created directly (appointment types: `422 CASE_TYPE_NOT_CREATABLE`)                                                     |
| `GET /v1/case-types`                                                   | any                                              | enabled/disabled case types and what each is created from                                                                                                               |
| `GET /v1/cases?filter=`                                                | any                                              | queue (`needs_attention identity_pending information_missing ready ready_for_booking booking_in_progress waiting booked reschedule cancellation closed exceptions all`) |
| `GET /v1/cases/:id`                                                    | any (patient details hidden from READ_ONLY)      | case detail, timeline, evidence, metrics; `access_status`, `booking` eligibility, `appointment_request`, `appointments`                                                 |
| `POST /v1/cases/:id/appointment-actions`                               | coordinator+; reschedule/cancel cases manager+   | booking sub-flow steps (below)                                                                                                                                          |
| `GET /v1/appointments/:id`                                             | any (patient reference hidden from READ_ONLY)    | appointment, the cases around it, changes in progress                                                                                                                   |
| `POST /v1/appointments/:id/actions`                                    | confirm coordinator+; reschedule/cancel manager+ | `confirm`, `reschedule`, `cancel` (below)                                                                                                                               |
| `GET /v1/cases/:id/evidence/verify`                                    | any                                              | chain verification                                                                                                                                                      |
| `POST /v1/cases/:id/interactions`                                      | coordinator+                                     | `MISSING_INFORMATION` (optional document), `STATUS_ENQUIRY`, `OUTCOME_REPORT`, `OTHER`                                                                                  |
| `POST /v1/cases/:id/actions`                                           | per action                                       | staff actions (below)                                                                                                                                                   |
| `POST /v1/observations/import`                                         | practice manager+                                | outcome rows from a destination export                                                                                                                                  |
| `GET /v1/metrics/cohort?from&to`                                       | any                                              | dashboard measures with provenance                                                                                                                                      |
| `GET/POST /v1/rule-sets`, `POST /v1/rule-sets/:id/publish`, `…/retire` | read any / write ADMIN                           | versioned rules                                                                                                                                                         |
| `GET/POST /v1/admin/memberships`                                       | ADMIN                                            | workforce membership in own organisation                                                                                                                                |
| `GET /v1/referrals/:id`, `POST /v1/referrals/:id/resolve`              | as above                                         | v1 compatibility                                                                                                                                                        |

### Staff actions (`caseActionSchema`)

Every action needs `expected_version` and a non-empty `note`; `staff_seconds`
is optional (unknown stays unknown).

| Action                                                                                    | When                                                                            | Effect                                                                                                       |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `confirm_identity`                                                                        | IDENTITY_PENDING                                                                | staff attests identity; rules re-evaluated                                                                   |
| `provide_information`                                                                     | IDENTITY_PENDING, INFORMATION_MISSING, EXCEPTION (no safety hold)               | documents / fields / structured intake; rules re-evaluated                                                   |
| `resolve_exception`                                                                       | open work item                                                                  | `safety_reviewed`, `file_reviewed`, `acknowledge`, `retry_destination` (attestation needed after ambiguity)  |
| `record_destination_reference`                                                            | READY (manual) or EXCEPTION with destination item                               | manual destination → READY_FOR_BOOKING                                                                       |
| `record_follow_up`                                                                        | READY_FOR_BOOKING/WAITING                                                       | follow-up effort, → WAITING                                                                                  |
| `start_booking` (`search`: from, to, IANA time zone, optional provider/location/duration) | READY_FOR_BOOKING/WAITING, prerequisites met, no safety hold, no active booking | opens an APPOINTMENT_REQUEST and asks the destination for availability; referral → WAITING, follow-up paused |
| `record_booking`                                                                          | READY_FOR_BOOKING/WAITING                                                       | APPOINTMENT_BOOKED (human-attested) → BOOKED; booking prerequisites enforced                                 |
| `record_patient_unreachable` / `_declined`, `record_provider_declined`                    | bookable or pre-destination                                                     | → CLOSED with that code                                                                                      |
| `close`                                                                                   | non-terminal, not in flight                                                     | → CLOSED with `resolution_code` (not BOOKED)                                                                 |
| `reject`                                                                                  | pre-destination / EXCEPTION                                                     | → REJECTED (`INVALID_REFERRAL`/`DUPLICATE_REFERRAL`)                                                         |
| `correct_outcome`                                                                         | BOOKED/CLOSED + observation under review; manager+                              | audited terminal correction                                                                                  |

While a booking is active, `record_booking`, `record_follow_up`, the
`record_patient_*`/`record_provider_declined` outcomes and `close` are refused
with `409 BOOKING_IN_PROGRESS`. No action records or requires a clinical
judgement.

### Appointment actions (`appointmentActionSchema`)

On an APPOINTMENT_REQUEST (coordinator+), RESCHEDULING_REQUEST or
CANCELLATION_REQUEST (manager+). `expected_version` is the **request's**
version (every step and every destination result increments it); `note` is
required where marked. Each step evaluates `appointment-policy.v1` and records
the decision before its outbox row; the worker performs the foreign effect.

| Action                             | When                                                                              | Effect                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `search` (optional `search`)       | no step running                                                                   | fresh availability; releases a held slot                                                                                                   |
| `select` (`slot_reference`)        | availability returned, under 10 minutes old                                       | that slot, as offered                                                                                                                      |
| `hold`                             | slot selected, the slot supports holds                                            | asks the destination to reserve it (`HOLD_NOT_SUPPORTED` otherwise)                                                                        |
| `commit`                           | slot selected (fresh) or held (over 15 s left)                                    | booking: create + planned read-back; reschedule: commit B + planned verify B + planned cancel A; cancellation: cancel; referral re-checked |
| `withdraw` (note)                  | nothing consequential unresolved                                                  | request WITHDRAWN, case CLOSED/WITHDRAWN; booking: referral back to READY_FOR_BOOKING, follow-up resumes                                   |
| `recheck`                          | the destination could not confirm a write, or a commit was not found on read-back | read-back re-armed (never a re-send)                                                                                                       |
| `attest_not_committed` (note)      | the destination could not confirm a write; staff checked it is absent             | execution superseded, step back to staff (`ATTESTED_NOT_COMMITTED`)                                                                        |
| `attest_original_cancelled` (note) | reschedule waiting on A's cancellation; staff checked A is cancelled              | A SUPERSEDED by B (staff source), reschedule COMPLETED                                                                                     |

Refusals are `409` with a code: `VERSION_CONFLICT`, `INVALID_BOOKING_STEP`,
`EXECUTION_IN_FLIGHT`, `OUTCOME_UNKNOWN`, `AVAILABILITY_STALE`,
`SLOT_NOT_OFFERED`, `SLOT_IN_PAST`, `HOLD_EXPIRED`, `BOOKING_NOT_ELIGIBLE`,
`BOOKING_ALREADY_ACTIVE`, `APPOINTMENT_CHANGE_ACTIVE`, `REQUEST_FINISHED`,
`NOTHING_TO_RECHECK`, `ATTESTATION_NOT_APPLICABLE`; messages never contain
patient details.

### Appointment changes (`appointmentChangeSchema`)

`expected_version` is the **appointment's** version.

| Action                              | Role         | Effect                                                                                      |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| `confirm` (`method`, optional note) | coordinator+ | staff attest the patient confirmed (booked ≠ confirmed); irreversible                       |
| `reschedule` (note, `search`)       | manager+     | opens a RESCHEDULING_REQUEST and searches; the appointment stays booked until B is verified |
| `cancel` (note, `reason`)           | manager+     | opens a CANCELLATION_REQUEST; nothing is sent until its `commit`                            |

### Status

`access_status` (`patientAccessStatus`, pure) answers "what is happening with
this referral?" from the referral, its active request and its appointments:
Referral in progress, Referral complete, Ready for booking, Searching for
appointment, Slot selected / awaiting commit, Booked, Confirmed, Reschedule in
progress, Cancellation in progress, Cancelled, Closed, Needs staff attention.
A `STATUS_ENQUIRY` interaction returns it; nothing is generated by a model.

## Connector contracts

- `connector-request.v1`: `execution_id tenant_id case_id subject operation correlation_id payload`.
- `connector-result.v1`: `SUCCEEDED(external_id, data?) | RETRYABLE(code) | PERMANENT(code) | DEFERRED | AMBIGUOUS | UNSUPPORTED_OPERATION | NOT_COMMITTED(basis)`, always echoing `execution_id`. `data` carries an operation's typed result and is validated before use (an invalid `data` after a consequential write is ambiguous). `NOT_COMMITTED` is a read-back answer only: the destination authoritatively holds no effect for that `execution_id`.
- Appointment payloads: `appointment-availability-query.v1` → `appointment-availability.v1` (slots: reference, provider, location, start/end instants, IANA time zone, `hold_supported`, `hold_expires_at`); `appointment-hold-request.v1` → `appointment-hold.v1`; `appointment-hold-release.v1`; `appointment-booking-request.v1` (exact slot, hold, replaced appointment) → `appointment-commit.v1`; `appointment-verify-request.v1` → `appointment-status.v1`; `appointment-cancellation-request.v1` → `appointment-cancellation.v1`. Operations and their case-type bindings: [appointment operations](appointment-operations-v1.md#5-connector-contract).
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
exception reasons, open by state, median time in state. Cohort `booking`:
`ready_to_booked_conversion`, median/p95 ready-for-booking → booked,
`booking_requests`, `booked_by_access`, `booking_attempts_per_booked`,
`availability_searches_per_booked`, `selection_to_booking_success`,
`abandoned_booking_requests`, `reschedules_completed`,
`cancellations_completed`, `ambiguous_appointment_writes` (with how many
needed a staff check), `interventions_per_booking_request`.
