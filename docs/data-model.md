# Data model

All tenant tables have `tenant_id`, **forced** row-level security keyed on the
transaction-local `app.tenant_id`, and composite foreign keys
`(tenant_id, case_id) → access_cases`. Migrations: `0001`–`0002` (v1 slice),
`0003_access_cases`, `0004_interactions_outcomes_rules`,
`0005_workforce_identity_and_privileges`, `0006_appointment_operations`.

| Table                      | Purpose                                                                                                                                                                                                  | Mutability                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `organisations`            | Tenants                                                                                                                                                                                                  | operator only                                                                                    |
| `organisation_memberships` | Workforce user → organisation + role                                                                                                                                                                     | ADMIN context only (RLS)                                                                         |
| `access_cases`             | Aggregate: type, channel, state, owner, version, resolution                                                                                                                                              | transitions via guarded updates                                                                  |
| `access_case_transitions`  | Every business state change (stage durations, stalls)                                                                                                                                                    | append-only                                                                                      |
| `referrals`                | REFERRAL extension: extraction, supplied info, rule decision, destination reference, follow-up                                                                                                           | updated by the engine                                                                            |
| `access_interactions`      | Inbound/outbound interactions (channel, intent, actor, content reference, verification level)                                                                                                            | append-only; unique idempotency key                                                              |
| `access_case_observations` | Outcome facts with source, verification and disposition                                                                                                                                                  | append-only; `PENDING` may settle once                                                           |
| `case_effort_events`       | Staff/system effort (touches, optional self-reported seconds)                                                                                                                                            | append-only                                                                                      |
| `work_items`               | Human work queue (one OPEN item per case and kind)                                                                                                                                                       | resolved by staff/system                                                                         |
| `artifacts`                | Encrypted object metadata: digest, size, type, scan verdict, backend, version, retention                                                                                                                 | insert only for runtime roles                                                                    |
| `commands`                 | Idempotency ledger: type, request fingerprint, actor, stored response                                                                                                                                    | append-only                                                                                      |
| `evidence_events`          | Per-case SHA-256 chain (v1 legacy, v2 case/actor-bound)                                                                                                                                                  | append-only, no TRUNCATE                                                                         |
| `executions`               | Foreign-effect identity and technical status                                                                                                                                                             | worker; API may only mark superseded                                                             |
| `outbox`                   | Transactional dispatch queue (leases, attempts, poison)                                                                                                                                                  | API inserts, worker updates                                                                      |
| `access_rule_sets`         | Versioned administrative rules, hash, effective window                                                                                                                                                   | DRAFT editable; published immutable                                                              |
| `appointment_requests`     | APPOINTMENT / RESCHEDULING / CANCELLATION extension: booking context, search, workflow status, latest availability snapshot, selected slot, current hold, pending execution, result appointment, version | identity immutable; version +1 per update; finished is final; never deleted                      |
| `appointments`             | Committed foreign appointment: destination + external reference, slot, provider, location, start/end, time zone, status, committed/cancelled, replaces/superseded-by, confirmation, version              | foreign identity immutable; cancelled/superseded final; confirmation irreversible; never deleted |
| `appointment_slot_holds`   | Reservation at the destination: slot, hold reference, execution, expiry, status                                                                                                                          | `ACTIVE → CONSUMED \| RELEASED \| EXPIRED` once; never deleted                                   |
| `access_audit_log`         | Administrative actions (rules, memberships, imports)                                                                                                                                                     | append-only                                                                                      |
| `schema_migrations`        | Ledger: version, checksum, execution time                                                                                                                                                                | runner only                                                                                      |

## Key constraints

- `case_resolution_complete`: terminal ⇔ resolution present, with outcome
  time, source and actor; `BOOKED` ⇔ code `BOOKED`.
- `case_transition_guard` (trigger): legal transitions only, version +1.
- `case_identity_guard`: id, tenant, type and opened time are immutable.
- `referrals_one_per_case`: exactly one referral per REFERRAL case.
- `observation_staff_is_attested`: `STAFF` observations are `HUMAN_ATTESTED`.
- `rule_set_single_active`: GiST exclusion on the effective window of ACTIVE versions.
- `one_open_work_item_per_kind`, `outbox_tenant_id_execution_id_key`,
  `evidence_case_sequence`, `artifacts_case_digest`.

### Appointment operations (0006)

- `case_transition_guard` is case-type aware: appointment cases use
  RECEIVED/READY_FOR_BOOKING (staff decision)/WAITING (external action)/
  BOOKED/CLOSED/EXCEPTION only (`appointment_case_states`); a cancellation
  request never books (`cancellation_request_never_booked`); referral
  transitions are unchanged. Resolution `WITHDRAWN` exists for appointment
  cases only (`case_withdrawn_is_request`).
- Requests are bound to a case of their own type
  (`(tenant_id, case_id, case_type)` → `access_cases_typed_key`) and originate
  from a REFERRAL of the same tenant (trigger); per-type shape, selection and
  committed-appointment `CHECK`s; one active booking per referral, one active
  change per appointment, one request per pending execution (partial unique
  indexes).
- Appointments: one row per destination reference and per committing
  execution (`UNIQUE`); cancellation, supersession and confirmation must be
  complete (`CHECK`s); every cross-row reference is a composite tenant key.
- Outbox rows may be `BLOCKED`: pre-authorised steps (a booking's read-back, a
  reschedule's verify-B and cancel-A) that only the worker releases.

## Runtime privileges (0005)

| Role                   | Tables                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access_request` (API) | S/I/U cases, referrals, work items, observations, rule sets, memberships; S/I artifacts, commands, evidence, interactions, effort, transitions, audit, outbox, executions; U(superseded_*) on executions |
| `access_worker`        | S organisations, rule sets; S/U cases, referrals, outbox; S/I/U executions, work items, observations; S/I evidence, transitions, effort. No artifacts, commands, interactions, memberships, audit.       |

0006 adds: `access_request` S/I/U `appointment_requests`, S `appointments` and
holds, and only the staff-owned columns of an appointment (confirmation,
attested cancellation/supersession, version) and of a hold (status,
`closed_at`); it can never insert an appointment or a hold, change an
appointment's foreign identity or time, or move the outbox. `access_worker` S/U
`appointment_requests` (never opens one), S/I/U `appointments` and holds.
Browser roles (`anon`, `authenticated`) get nothing.

Neither role has DELETE or TRUNCATE on anything, owns tables, bypasses RLS,
or inherits roles; startup verifies this (`verifyRuntimeIdentity`).

## Backfill (0003/0004)

Deterministic: one REFERRAL case per legacy referral with
`access_derived_uuid('access-case', tenant_id, referral_id)`; `case_id`
populated on every legacy row; the migration refuses to run over orphaned
rows. Legacy milestones are recorded as `DERIVED` observations. Tested in
`tests/integration/migrations.test.ts` with legacy data including a v1
evidence chain.

## Upgrade (0006)

Additive only: three new tables, one new resolution code, one new outbox
status, case-type-aware transition rules (the referral branch is unchanged
verbatim) and new constraints that existing rows already satisfy. No data is
rewritten. `tests/integration/migrations.test.ts` migrates a database to
0005, creates referral cases in seven states with evidence chains,
executions, outbox rows and a work item, applies 0006 and asserts every
existing row is byte-identical, every chain still verifies, referral
transitions behave as before and the new tables are RLS-forced and empty.
