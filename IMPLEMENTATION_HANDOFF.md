# ACCESS implementation handoff

**Status:** Approved to implement

**Quality target:** Production-grade from the first vertical slice

## Decision

Proceed with implementation. “Start with a vertical slice” does not mean build
a disposable prototype. It means deliberately limit the number of workflows,
channels, and connectors while building the selected path to production
standards.

The first release must be deployable, observable, recoverable, secure, and
testable at agreed production limits. It should process synthetic and approved
test referrals end to end before any real patient data or consequential
customer-system write is enabled.

## Product boundary for release one

Build one complete referral path:

```text
upload synthetic referral
→ persist encrypted artifact
→ classify and extract fixed fields
→ propose or resolve patient identity
→ check administrative completeness
→ create an exception work item when required
→ authorise a referral-create action
→ dispatch through a mock connector
→ reconcile an ambiguous result
→ close the workflow
→ display state, evidence, and operational measurements
```

Release one is production-grade for this path. It is not expected to include
voice, WhatsApp, autonomous patient merging, real clinical triage, every PMS,
every referral type, or a general-purpose agent.

## Deployment decision

Use a portable containerised application, with one supported production
reference deployment. Do not split one production request path between Railway
and Azure merely because both are available.

### Production reference topology

| Platform | Production responsibility |
| --- | --- |
| Vercel | Staff console and public web edge only |
| Azure | Core API, dispatcher, scheduler, reconciler, extraction worker, notifier, mock/real connector runtimes, secrets, telemetry, and encrypted artifact storage |
| Supabase | Managed Postgres system of record and, initially, workforce authentication |
| Railway | Optional developer or short-lived integration environment; not a required hop in production |

Azure is included because the execution plane benefits from workload identity,
private networking options, central secret management, isolated worker
deployments, and controlled connector egress. The implementation must not bind
domain code to Azure SDKs. Infrastructure adapters own Azure-specific concerns.

Railway remains useful for rapid non-production deployments, but production and
staging must run the same container images, migrations, entry points, and
configuration contract. If Railway is later selected instead of Azure for
production, make that an explicit ADR and qualify it against the same security,
availability, restore, and network-isolation gates.

### Cross-platform rules

1. Co-locate Azure compute and the Supabase project as closely as the providers
   permit; measure database latency before accepting the topology.
2. All database connections require TLS. Use separate least-privilege roles for
   migrations, tenant request handling, and system workers.
3. The Vercel application never receives a Supabase service credential and
   never mutates workflow tables directly; it submits commands to the core API.
4. Azure secrets or workload identity provide credentials to server workloads.
   Secrets never appear in images, repository files, client bundles, or logs.
5. Connector runtimes have explicit outbound allowlists and no route to another
   tenant's connector or secrets.
6. Raw artifacts reside in encrypted object storage. Postgres retains immutable
   metadata, object identity, digest, media type, size, and scan status.
7. Logs, traces, metrics, backups, and support tooling are part of the data-flow
   inventory and follow the same residency and access decisions as production.
8. Infrastructure is reproducible. Do not make undocumented production changes
   solely through provider dashboards.

## Repository shape

Use a TypeScript monorepo unless an implementation constraint discovered during
bootstrap justifies an ADR changing it:

```text
apps/
  console/                 Next.js UI deployed to Vercel
  core-api/                HTTP command/query API deployed to Azure
  worker/                  same domain build, role selected by entry point
  connector-mock/          contract reference and fault injection
packages/
  domain/                  aggregates, state machines, commands, events
  contracts/               runtime schemas and generated API types
  db/                      migrations, repositories, tenant transaction helper
  policy/                  access and action policy ports/local implementation
  observability/           correlation, logging, metrics, tracing
infra/
  azure/                   reproducible production infrastructure
  vercel/                  frontend deployment configuration
  railway/                 optional non-production deployment
supabase/
  migrations/              schema, roles, RLS, functions
  seed.sql                  synthetic data only
tests/
  architecture/
  integration/
  load/
  fault/
docs/adr/
```

Prefer a package manager workspace and a task runner only where they reduce,
rather than hide, the commands needed to build and test the system.

## Implementation order

### Phase 0: bootstrap and executable contracts

- Establish formatting, linting, type checking, unit testing, integration
  testing, build, migration, and local-development commands.
- Add `.env.example` with names and descriptions but no secrets.
- Add runtime configuration validation that fails fast.
- Define versioned schemas for commands, events, connector capabilities,
  connector execution results, work items, and errors.
- Add CI that runs all deterministic checks and scans committed content for
  secrets.

### Phase 1: tenancy and durable core

- Implement organisations, actors, referrals, referral state, commands, events,
  outbox, timers, execution ledger, documents, and work items.
- Apply `FORCE ROW LEVEL SECURITY` to every tenant table.
- Implement a tenant-transaction helper that sets tenant context locally and
  fails closed when context is absent.
- Prove state/event/outbox atomicity and command deduplication.
- Define aggregate transitions as an explicit, exhaustively tested state
  machine rather than scattered conditional updates.

### Phase 2: dispatcher and mock connector

- Claim outbox rows with leases and bounded batches.
- Preserve order per aggregate while allowing different aggregates to run in
  parallel.
- Implement connector capability negotiation and record the version used by a
  workflow plan.
- Build fault modes into the mock connector: delay, retryable failure,
  permanent rejection, committed-then-timeout, malformed response, and
  capability withdrawal.
- Implement reconciliation that never blindly retries an ambiguous write.

### Phase 3: referral workflow and console

- Accept a synthetic PDF or fixture through the upload edge.
- Store and scan the artifact through a storage port.
- Use a deterministic extraction fixture first, behind the same pure extraction
  port that a model implementation will later use.
- Implement identity candidates, administrative completeness, exception work
  items, human resolution, and action policy.
- Build the smallest console required to view referrals, inspect evidence,
  resolve work, and observe reconciliation.

### Phase 4: production qualification

- Deploy an isolated staging environment from the production infrastructure
  definition.
- Exercise backup and point-in-time restore into an isolated environment.
- Run tenant-isolation, concurrency, load, soak, and fault-injection suites.
- Prove rollback or forward-fix procedures for application and migration
  failures.
- Create alerts and runbooks, then execute a game day with a stuck queue,
  database interruption, expired credential, and ambiguous connector write.
- Produce a signed release evidence report containing test versions, results,
  known limitations, and residual risks.

## Production limits are measured, not asserted

Before implementation, place initial targets in version-controlled test
configuration. Adjust them only with a recorded reason and test evidence.

The qualification suite must measure:

- accepted commands per second and burst size;
- simultaneous tenants and active workflows;
- referral artifact size and extraction duration;
- outbox queue age at median, p95, and p99;
- command API latency at median, p95, and p99;
- time to reconcile ambiguous writes;
- timer firing delay;
- database connections, lock waits, transaction duration, and storage growth;
- worker memory and CPU saturation;
- cross-provider database latency;
- recovery point and recovery time achieved in a restore exercise; and
- behaviour when each external dependency is slow or unavailable.

Do not invent numerical service-level objectives without workload evidence. The
first implementation task is to add explicit provisional targets to a load-test
profile, explain the assumed customer volume and safety margin, and obtain owner
approval. A release fails if it misses an approved target or if the test cannot
measure it reliably.

## Production-grade acceptance gates

### Correctness

- State, event, and outbox changes commit atomically.
- Every command deduplicates by `command_id`.
- Every foreign effect is tracked by one `execution_id`.
- Stale aggregate versions conflict rather than overwrite.
- `AMBIGUOUS` can transition only to reconciliation or human exception.
- Linking a referral and merging patients are separate operations.

### Tenant and data security

- Cross-tenant read and write property tests pass for every tenant table.
- Missing tenant context fails closed.
- Privileged database roles are unavailable to request handlers.
- Direct identifiers do not cross the model boundary.
- Logs and traces redact secrets and defined identifiers.
- Artifact download uses short-lived, authorised access.
- Dependency, container, and secret scans meet the recorded release policy.

### Reliability and recovery

- Duplicate delivery, process termination, lease expiry, and network timeout
  tests pass.
- Queue depth and age are bounded under the approved load profile.
- A poison item reaches an exception state without silently disappearing.
- Backup restoration is demonstrated, timed, and documented.
- Every alert used as a release gate points to an exercised runbook.

### Operability

- One correlation ID traces a request through command, event, outbox,
  connector, reconciliation, and work-item resolution.
- Dashboards expose command errors, queue age, reconciliation backlog, connector
  health, tenant throttling, and workflow outcome counts.
- Deployments expose build identity, schema version, contract versions, and
  connector versions.
- Migrations have compatibility and recovery procedures.

### Product and safety

- The UI identifies unsupported and pending states honestly.
- Urgent or clinical content follows the approved out-of-scope path.
- Human decisions show evidence and uncertainty rather than only a model answer.
- The workflow records staff effort without substituting fake zeros for unknown
  measurements.
- No real patient data or live consequential connector write is enabled until
  the responsible product, security, privacy, and operational owners approve it.

## Required ADR defaults

Implementation should record these decisions rather than reopening the entire
architecture:

1. **Aggregate ownership:** workers return commands; owning domain modules write
   state. Infrastructure libraries append events/outbox within that transaction.
2. **Delivery:** at-least-once dispatch with leases; effectively-once effects
   only through idempotency or successful reconciliation.
3. **Evidence:** begin with per-aggregate chains and periodic tenant anchors;
   benchmark before considering a tenant-global serialized appender.
4. **Policy:** access authorisation applies to reads and writes; action policy is
   additionally evaluated before consequential effects.
5. **Grants:** persist the decision and action hash, then mint or validate a
   short-lived execution grant immediately before dispatch.
6. **Measurement:** immutable events retain raw technical facts; versioned
   projections calculate operational and ROI metrics.
7. **Identity:** referral linking, merge proposals, and patient merge execution
   are distinct operations.
8. **Runtime:** Vercel for web, Azure for production compute/control services,
   Supabase for Postgres/auth initially, Railway only as an optional alternate
   environment.

Any change requires an ADR explaining the driver, alternatives, consequences,
and how the replacement still passes the acceptance gates.

## Definition of done for the implementation chat

The next chat is complete only when it has:

- produced runnable application code rather than more design-only documents;
- included migrations and synthetic seed data;
- provided one-command local startup and documented cloud deployment;
- passed formatting, linting, type checking, unit, integration, architecture,
  RLS, fault, and approved load tests;
- deployed or generated reproducible deployment assets for the selected stack;
- updated the README with exact commands and environment variables;
- committed all changes; and
- clearly listed anything that could not be exercised because external cloud
  credentials or projects were unavailable.

Passing local tests is necessary but not sufficient for a production release.
Cloud-specific qualification remains required in the owner's Azure, Supabase,
and Vercel environments before real patient data is introduced.
