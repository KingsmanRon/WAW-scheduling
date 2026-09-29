# ADR 0001: production slice foundations

**Status:** Accepted; aggregate, lifecycle and identity decisions superseded by [ADR 0002](0002-access-case-aggregate.md) and [ADR 0003](0003-execution-identity-storage.md) · **Date:** 2026-09-23

## Context and decision

ACCESS starts as a TypeScript modular monolith with a PostgreSQL system of
record. Referral is the aggregate; only domain command handlers advance it.
Every transition increments an optimistic version and appends a per-aggregate
SHA-256 evidence link and optional outbox intent in the same transaction.

Outbox delivery is at least once. Rows receive 30-second leases, five bounded
attempts, per-aggregate ordering, and a poison terminal status. `command_id`
deduplicates state commands while `execution_id` identifies the intended
foreign effect. Ambiguous writes enter `RECONCILING`; they are read back using
the execution identity and never blindly repeated.

Every tenant table uses forced RLS. Request and worker roles are non-inheriting,
tenant context is transaction-local, and absent context returns no rows. Staff
access and referral-create action policy are separate checks. A decision and
action hash is retained before dispatch; production execution grants remain a
pre-live qualification gate.

Artifacts are AES-256-GCM encrypted behind a storage port. PostgreSQL stores
only object identity, SHA-256 digest, immutable metadata, key identifier, and
scan result. The fixture extractor is pure and receives bytes locally; a future
provider must receive pseudonymised tokens through a separately governed port.

Connector capability and result schemas are versioned. The mock advertises the
single referral-create contract; unsupported/capability-loss paths fail into an
exception. Referral linking never implies a patient merge.

Raw technical events are immutable facts. Operational projections and benefit
calculations will be explicitly versioned; unknown staff effort is never zero.
Vercel hosts only the console, Azure runs API/workers/connectors, Supabase hosts
Postgres/auth, and Railway is optional development infrastructure.

## Consequences

This deliberately serialises evidence only within an aggregate, supports
portable local substitutes, and keeps cloud SDKs outside domain code. Global
evidence anchoring, signed short-lived execution grants, real malware scanning,
and production identity integration must pass qualification before live data.
