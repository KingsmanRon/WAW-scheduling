# Synthetic end-to-end qualification

`npm run qualify:synthetic` (with `TEST_DATABASE_URL`) runs
`tests/e2e/qualification.test.ts` through the real HTTP API with signed
workforce JWTs and membership-derived tenancy, the least-privilege
`access_request`/`access_worker` logins, and the worker dispatcher. Set
`QUALIFICATION_REPORT=report.json` to write a JSON report (state trace,
evidence verification and notes per flow); CI uploads it as an artifact.

| Flow                   | Path asserted                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A Happy path           | RECEIVED → DESTINATION_PENDING → READY_FOR_BOOKING → BOOKED (connector outcome readback), metrics derived                                                          |
| B Missing information  | RECEIVED → INFORMATION_MISSING → (second interaction supplies insurance) → DESTINATION_PENDING → READY_FOR_BOOKING → BOOKED                                        |
| C Identity review      | RECEIVED → IDENTITY_PENDING → (staff confirmation, human-attested) → DESTINATION_PENDING → READY_FOR_BOOKING                                                       |
| D Manual destination   | RECEIVED → READY → (staff enters reference) → READY_FOR_BOOKING; and connector unavailable: DESTINATION_PENDING → EXCEPTION → manual reference → READY_FOR_BOOKING |
| E Patient unreachable  | READY_FOR_BOOKING → WAITING (follow-up) → CLOSED/PATIENT_UNREACHABLE                                                                                               |
| F Patient declined     | READY_FOR_BOOKING → CLOSED/PATIENT_DECLINED                                                                                                                        |
| G Technical ambiguity  | commit then timeout → reconciling → read back → READY_FOR_BOOKING, one foreign write                                                                               |
| H Persistent ambiguity | bounded reconciliation → EXCEPTION + one CONNECTOR work item, never re-sent                                                                                        |
| I Cross tenant         | 404/403 for another tenant's case, queue and metrics isolated                                                                                                      |
| Dashboard              | cohort measures with provenance for the qualification cohort                                                                                                       |

## Appointment operations qualification

`npm run qualify:appointments` (with `TEST_DATABASE_URL`) runs
`tests/e2e/appointments.test.ts` the same way, one organisation per scenario,
against the synthetic destination. `APPOINTMENT_QUALIFICATION_REPORT=report.json`
writes the report (request states, workflow status, evidence verification,
destination writes, notes); CI uploads it.

| Scenario                      | Asserted                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A Standard booking            | availability → select → hold → commit → read-back → BOOKED (request and referral) → staff confirmation                  |
| B No availability             | request stays open for a staff decision; nothing booked; wider search; withdrawal returns the referral to booking       |
| C Stale slot                  | slot taken elsewhere → refused, no appointment, slot removed, reselect → booked; availability over 10 minutes refused   |
| D Duplicate command           | same command replays; reused id with a different body refused; stale version refused; one foreign appointment           |
| E Safe retry                  | failures known before commit retried to success, one appointment                                                        |
| F Ambiguous, committed        | response lost after commit → AMBIGUOUS → read-back finds it → BOOKED; non-idempotent destination; one create call       |
| G Ambiguous, not committed    | timeout → nothing may be retried until read-back says `NOT_COMMITTED` → staff resubmit → one appointment                |
| H, H2 Hold expiry             | too little hold time refused; expired hold swept and never consumed; a hold lapsed at the destination refused at commit |
| I Concurrent slot loss        | two requests, one slot: one booked, the other back to selection with the conflict stated; holds race the same way       |
| J Reschedule                  | B committed, verified, then A cancelled; A SUPERSEDED by B; one current appointment                                     |
| K Replacement refused         | A untouched; planned verify/cancel steps closed unexecuted; no cancel call                                              |
| L Replacement ambiguous       | A untouched and no cancel call until B is reconciled                                                                    |
| M, M2 Original's cancellation | ambiguous → EXCEPTION "both appointments may exist" → read-back settles it, or a manager attests after escalation       |
| N Cancellation                | separate commit, one destination cancellation, replays idempotent, referral outcome reviewed not rewritten              |
| O Capability withdrawn        | nothing sent or emulated; EXCEPTION for a person                                                                        |
| P Tenant attack               | another organisation's cases and appointments 404; forged tenant header 403; no cross-tenant binding even by the owner  |
| Q Role attack                 | READ_ONLY and browser role claims refused; coordinators cannot reschedule or cancel                                     |
| R Restart recovery            | active hold, pending, ambiguous and lease-expired bookings and a pending cancellation all complete after a new worker   |
| S Metrics                     | booking measures OBSERVED/DERIVED with inputs; no denominator is UNKNOWN, never zero                                    |

`tests/integration/appointments-security.test.ts` checks least privilege on
the new tables, that their rows cannot be deleted, and that refusals and logs
carry no patient details.

The console was verified in Chromium against the local synthetic stack
(synthetic data only; screenshots in
[design/appointment-operations](design/appointment-operations/)), 37 checks
for the main flow and 14 for the unconfirmed states: start booking,
availability, keyboard slot choice with visible focus, hold countdown,
booking with read-back, confirmation, reschedule, cancellation, the
unconfirmed-booking states and staff attestation, queue lenses, the
dashboard booking chapter, 390 px without horizontal overflow, reduced
motion, no browser errors. These browser checks are not part of CI.

## Test inventory

| Area                                                                                                                                 | File                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Acceptance items 1–29                                                                                                                | `tests/e2e/acceptance.test.ts`                    |
| Flows A–I                                                                                                                            | `tests/e2e/qualification.test.ts`                 |
| Appointment scenarios A–S                                                                                                            | `tests/e2e/appointments.test.ts`                  |
| Appointment least privilege, immutability, no patient data in refusals or logs                                                       | `tests/integration/appointments-security.test.ts` |
| Dispatcher: happy, retry, poison, ambiguity, repeated ambiguity, exhaustion, lease crash, concurrency, id mismatch, readback, timers | `tests/integration/dispatcher.test.ts`            |
| Ledger migrations, legacy backfill, evidence continuity                                                                              | `tests/integration/migrations.test.ts`            |
| RLS, membership/rule-set policies, append-only, transition guard                                                                     | `tests/integration/rls.test.ts`                   |
| Outcomes, corrections, safety hold, status contacts, queue, READ_ONLY                                                                | `tests/integration/outcomes.test.ts`              |
| Rule-set lifecycle and integrity                                                                                                     | `tests/integration/rulesets.test.ts`              |
| Artifact failure boundaries, scanning                                                                                                | `tests/integration/artifacts.test.ts`             |
| Unit: lifecycle, booking sub-flow, rules, policy, config, storage, scanner, logging, migrations, connector, synthetic destination    | `tests/unit/*`, `tests/fault/*`                   |
