# Prompt for the implementation chat

Copy everything below the divider into a new chat opened at the root of this
repository.

---

Implement the first production-grade vertical slice of the ACCESS healthcare
patient-access platform in this repository.

Before editing anything:

1. Find and obey every applicable `AGENTS.md` file.
2. Read `README.md`, `PRODUCT_ASSESSMENT.md`, `ARCHITECTURE_REVIEW.md`, and
   `IMPLEMENTATION_HANDOFF.md` completely.
3. Inspect the current branch and preserve the committed architecture decisions.
4. Create a concise execution plan, then implement it; do not stop after
   producing another assessment, scaffold-only repository, or pseudocode.

## Required outcome

Build a runnable, production-grade vertical slice that:

- accepts a synthetic referral artifact;
- persists encrypted artifact metadata and its digest;
- performs fixed-schema extraction through a replaceable pure extraction port;
- proposes or resolves a patient identity;
- checks administrative completeness;
- opens and resolves a human exception work item;
- evaluates access and action policy;
- atomically commits workflow state, evidence event, and outbox intent;
- dispatches a referral-create action to a fault-injectable mock connector;
- handles retryable, permanent, deferred, and ambiguous outcomes;
- reconciles committed-then-timeout without creating a duplicate;
- displays referral state, evidence, exceptions, and reconciliation in a minimal
  staff console; and
- emits operational telemetry with end-to-end correlation.

Feature scope is deliberately narrow, but the selected path must meet the
production engineering and test gates in `IMPLEMENTATION_HANDOFF.md`. Do not
implement voice, WhatsApp, real clinical triage, autonomous patient merging, or
multiple real PMS connectors in this increment.

## Platform allocation

- Vercel: Next.js staff console/public web edge.
- Azure: production core API, workers, connector runtime, secrets, telemetry,
  and artifact storage.
- Supabase: Postgres system of record and initial workforce authentication.
- Railway: optional developer/integration deployment only; application
  containers and configuration must remain portable.

Keep cloud SDK use behind infrastructure ports. The application must run locally
without cloud credentials using containerised or local substitutes. Never put a
Supabase service credential or any privileged secret in browser code.

## Implementation expectations

- Use a TypeScript monorepo unless a discovered hard constraint warrants a
  committed ADR.
- Create actual migrations, tenant roles/RLS, repositories, APIs, workers,
  console screens, mock connector, fault injection, seed fixtures, and tests.
- Validate all external input and version command/event/connector schemas.
- Enforce optimistic concurrency and command deduplication.
- Keep all foreign I/O outside database transactions.
- Use at-least-once outbox dispatch with bounded leases and ordering per
  aggregate.
- Treat `execution_id` as the intended-effect identity across dispatch and
  reconciliation.
- Never blindly retry `AMBIGUOUS`; reconcile or create a human exception.
- Keep referral linking distinct from patient merging.
- Make tenant context fail closed and prove isolation for every tenant table.
- Use synthetic data only.
- Add `.env.example`; never commit credentials.
- Add structured logs, metrics/traces or locally testable adapters, health/readiness
  endpoints, migrations, deployment assets, and operator runbooks.
- Make infrastructure reproducible rather than depending on undocumented
  dashboard configuration.

## Verification

Implement and run:

- formatting and lint checks;
- strict type checking;
- unit tests for state transitions and policies;
- integration tests against a real Postgres instance;
- property/integration tests for cross-tenant RLS;
- crash and duplicate-delivery tests for state/event/outbox atomicity;
- connector contract and fault-injection tests;
- an ambiguous-write reconciliation test;
- migration tests;
- a production-build check for every app;
- a documented, reproducible load profile with provisional limits; and
- the strongest infrastructure validation possible without my cloud credentials.

Do not claim a test passed if it was not run. If a cloud deployment or restore
exercise needs credentials unavailable in the environment, finish all code and
reproducible infrastructure first, then report the exact command I must run and
the evidence I should capture.

## Completion requirements

- Update `README.md` with exact local setup, test, migration, seed, build, and
  deployment commands.
- Record material decisions under `docs/adr/`.
- Keep a list of security assumptions and residual risks.
- Commit all completed changes on the current branch.
- Create the required pull request after committing.
- In the final response, cite changed files and list every command actually run,
  marking pass, failure, or environment limitation accurately.

Continue until the complete vertical slice and its tests are implemented. Do
not return merely to ask whether you should start, and do not describe the
application as production-ready until the documented acceptance gates have
evidence.
