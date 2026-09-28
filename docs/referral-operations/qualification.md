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

## Test inventory

| Area                                                                                                                                 | File                                   |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Acceptance items 1–29                                                                                                                | `tests/e2e/acceptance.test.ts`         |
| Flows A–I                                                                                                                            | `tests/e2e/qualification.test.ts`      |
| Dispatcher: happy, retry, poison, ambiguity, repeated ambiguity, exhaustion, lease crash, concurrency, id mismatch, readback, timers | `tests/integration/dispatcher.test.ts` |
| Ledger migrations, legacy backfill, evidence continuity                                                                              | `tests/integration/migrations.test.ts` |
| RLS, membership/rule-set policies, append-only, transition guard                                                                     | `tests/integration/rls.test.ts`        |
| Outcomes, corrections, safety hold, status contacts, queue, READ_ONLY                                                                | `tests/integration/outcomes.test.ts`   |
| Rule-set lifecycle and integrity                                                                                                     | `tests/integration/rulesets.test.ts`   |
| Artifact failure boundaries, scanning                                                                                                | `tests/integration/artifacts.test.ts`  |
| Unit: lifecycle, rules, policy, config, storage, scanner, logging, migrations, connector                                             | `tests/unit/*`, `tests/fault/*`        |
