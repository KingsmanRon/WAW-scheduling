# ADR 0002: `access_case` aggregate, business lifecycle and measurement

**Status:** Accepted · **Date:** 2026-09-25 · **Supersedes:** the referral-as-aggregate part of ADR 0001

## Context

v1 modelled a referral as the aggregate and ended its lifecycle at
`COMPLETED` when the destination accepted it. That conflated connector
execution with business outcome, could not represent what happened after the
destination commit, and could not host other patient-access requests.

## Decision

1. **`access_cases` is the platform aggregate.** It owns the business state,
   the optimistic `version`, owner, and the resolution. Case types:
   `REFERRAL` (enabled) and `APPOINTMENT_REQUEST`, `STATUS_ENQUIRY`,
   `MISSING_INFORMATION`, `CANCELLATION_REQUEST`, `RESCHEDULING_REQUEST`
   (defined in contracts, schema and policy; every execution path fails
   closed with `CASE_TYPE_DISABLED`).
2. **`referrals` is the REFERRAL extension** (`case_id` unique, FK). Referral
   IDs are unchanged; `/v1/referrals/:id` still works.
3. **Generic infrastructure is case-aware.** Commands, evidence, work items,
   executions, outbox, artifacts, interactions, observations and effort carry
   `case_id` (+ `subject_type`/`subject_id`); `referral_id` stays for
   referral queries.
4. **Business lifecycle is separate from execution status.**

   ```text
   RECEIVED ─┬─> IDENTITY_PENDING ─┐
             ├─> INFORMATION_MISSING ─┼─> READY (manual destination) ──> READY_FOR_BOOKING
             ├─────────────────────────┴─> DESTINATION_PENDING ─────────> READY_FOR_BOOKING
             └─> EXCEPTION / REJECTED            (connector)        │
   READY_FOR_BOOKING <-> WAITING ──> BOOKED | CLOSED(resolution code)
   EXCEPTION ──> back into the flow, CLOSED or REJECTED (staff decisions)
   BOOKED <-> CLOSED only through the audited manager outcome correction
   ```

   Execution statuses (`PENDING LEASED RETRYABLE AMBIGUOUS RECONCILING
SUCCEEDED PERMANENT POISON`) live on `executions`. A successful
   `referral.create` moves the case to `READY_FOR_BOOKING`, never to a
   terminal state. Transitions are enforced in `packages/domain` and by the
   `case_transition_guard` trigger; each transition increments the version
   once and is appended to `access_case_transitions`.

5. **Resolution is explicit.** Terminal states require `resolution_code`,
   `outcome_at`, `resolution_source`, `resolution_actor_id` (DB `CHECK`).
   Codes: `BOOKED PATIENT_UNREACHABLE PATIENT_DECLINED PROVIDER_DECLINED
DUPLICATE_REFERRAL INVALID_REFERRAL MISSING_INFORMATION REFERRED_ELSEWHERE
CANCELLED UNKNOWN`. Technical failure never implies a closure code.
6. **Outcomes are append-only observations** with source
   (`CONNECTOR CALLBACK RECONCILIATION STAFF IMPORT SYSTEM`) and verification
   (`OBSERVED EXTERNAL_CONFIRMED HUMAN_ATTESTED DERIVED UNKNOWN`). Staff
   observations are always `HUMAN_ATTESTED` (DB `CHECK`). Every source goes
   through one planner (`planObservation`): duplicates are idempotent on
   `(case, type, source, source_reference)`; outcomes that arrive before the
   destination commit are held `PENDING` and applied on `READY_FOR_BOOKING`;
   terminal cases are never regressed (earlier or agreeing facts are
   `RECORDED`, later conflicting facts go to `REVIEW` with an `OUTCOME_REVIEW`
   work item); nothing external moves a case out of `EXCEPTION`.
7. **Interactions are append-only** and idempotent on `idempotency_key`.
   Enabled channels: `STAFF_UPLOAD`, `API`; `EMAIL WHATSAPP VOICE
PATIENT_PORTAL` are defined and refused.
8. **Administrative rules are versioned data** (`access_rule_sets`): typed
   JSON evaluated deterministically; one applicable ACTIVE version per
   tenant/instant (exclusion constraint); published versions immutable
   (trigger); each decision stores rule-set id, version, definition hash,
   input hash and decision hash so it can be recomputed. Cases keep their
   pinned version; retired versions are never used for new cases.
9. **Business measures are computed from source records** (`packages/db/src/metrics.ts`),
   each with provenance `OBSERVED | DERIVED | ESTIMATED | UNKNOWN`. Missing
   inputs yield `UNKNOWN`, never zero; self-reported staff time is
   `ESTIMATED`; inconsistent durations (end before start) are `UNKNOWN`.

## Migration

`0003`–`0005` are additive and applied by the ledger runner. Each legacy
referral becomes one case whose id is `access_derived_uuid('access-case',
tenant, referral)` (deterministic; mirrored in tests). Legacy states map
`ADMIN_PENDING→INFORMATION_MISSING`, `DISPATCH_PENDING|RECONCILING→
DESTINATION_PENDING`, `COMPLETED→READY_FOR_BOOKING`, `REJECTED→REJECTED
(UNKNOWN)`; the original is kept in `legacy_referral_state`. Legacy evidence
rows remain hash version 1 and still verify; new rows are version 2 and chain
onto them. Duplicate open work items from legacy replays are merged.

## Consequences

Cases stay open after the destination accepts them, so conversion and leakage
become measurable. The model extends to other case types by adding
operations to `OPERATIONS` and enabling the type, without schema changes.
Correction of a terminal outcome is deliberately narrow (manager only, backed
by an observation under review).
