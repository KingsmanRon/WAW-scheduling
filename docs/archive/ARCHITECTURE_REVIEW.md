# ACCESS architecture review

**Status:** Approved target direction, with implementation gates

## Verdict

This is a strong architecture for the proposed referral-processing wedge. It
turns the product principles in the assessment into enforceable boundaries:
the model cannot execute, state changes and emitted intent commit together,
foreign effects are isolated, and ambiguous outcomes are reconciled rather
than blindly retried.

The design is substantially more credible than a conventional “agent plus
tools” implementation. In particular, the modular monolith, transactional
outbox, single workflow writer, capability-based connectors, and isolated
credential boundary are appropriate defaults for an early healthcare product.

It should not yet be treated as an implementation specification. Several rules
are stated too absolutely, and a few contracts conflict with the stated module
ownership. Resolve the issues below in architecture decision records (ADRs) and
executable tests before building the production path.

## Decision-by-decision assessment

| Decision | Assessment | Required refinement |
| --- | --- | --- |
| Modular monolith; isolated execution | **Accept** | Keep connector and de-identification processes separate. Do not split domain modules until security, ownership, or scaling evidence requires it. |
| Postgres as record and queue | **Accept with limits** | Call it the initial durable work queue, not a general message bus. Define throughput, latency, retention, and recovery exit criteria. |
| State authoritative; events evidential | **Accept** | Define event correction, retention, schema evolution, and chain anchoring. Never imply the chain proves the truth of payloads. |
| No foreign call in a transaction | **Accept** | Enforce with import/network tests and keep transactions short. Policy calls that can be remote must also go through durable orchestration. |
| Orchestrator owns idempotency | **Accept with nuance** | The orchestrator mints the key; the execution ledger and connector both participate. A remote system without idempotency requires reconciliation before any retry. |
| Capability negotiation | **Accept** | Unsupported operations must produce a planned fallback or explicit unsupported result, not “never throw” silently. |
| One writer per aggregate | **Accept** | Define aggregate boundaries and command ownership; the current table matrix violates the rule in places. |
| Model as pure, de-identified function | **Accept as a goal** | Prove task quality after tokenisation, prohibit re-identification, version prompts/models/schemas, and specify zero-retention provider terms. |
| Policy as a port | **Accept** | Reads do not bypass authorisation. Separate action authorisation, data-access control, and approval workflow. |
| Database-enforced tenant isolation | **Accept** | Threat-model role switching, pooling, background workers, migrations, support access, and database-owner bypass. Test isolation continuously. |

## What is especially good

### Ambiguous outcomes are first-class

The distinction among `RETRYABLE`, `PERMANENT`, and `AMBIGUOUS` is one of the
most important choices in the proposal. A timeout after a write is not evidence
that the write failed. Moving an ambiguous execution into reconciliation makes
duplicate-patient and duplicate-booking creation structurally less likely.

Keep the proposed invariant:

```text
RETRYABLE  → retry with the same execution_id
AMBIGUOUS  → reconcile; never immediately execute again
PERMANENT  → create an exception work item
```

The invariant should be enforced in the workflow transition table and tested
with fault injection at every point between sending a request and recording its
result.

### The connector security boundary is meaningful

A per-tenant-connector runtime limits credentials, customer-specific code, and
network egress. This is a more useful boundary than creating microservices for
each internal domain. The core should send a canonical, authorised operation;
the runtime should handle transport and report evidence, without deciding
business policy.

### Human work returns through the same state machine

Human resolution, connector callbacks, timers, and retries entering through one
command path preserves the single-writer rule and makes behaviour replayable.
The console is therefore a command client, not an administrative back door.

### Audit and value measurement share causality

Using the same correlation and causation chain for control evidence and
operational measurement makes it possible to connect an outcome to the human
and machine work that produced it. That is more reliable than adding analytics
after implementation.

## Required corrections before implementation

### 1. Resolve ownership contradictions

The proposed ownership table says `intake` owns `raw_artifact` while the
channel gateway writes it; `document` owns extraction tables while the worker
writes them; `workflow` owns the execution ledger while the dispatcher writes
it; and all modules append events through `evidence`.

“One writer” should mean **one domain command owner**, not merely one process or
one SQL role. Use one of these patterns consistently:

1. the worker submits a command and the owning core module persists the result;
2. the worker invokes an owner-controlled stored procedure with a narrow role;
3. explicitly designate a table as infrastructure-owned rather than
   module-owned.

Recommended ownership:

| Aggregate/table | Sole command owner |
| --- | --- |
| `inbound_message`, artifact metadata | `intake` |
| `document`, `extraction`, confidence | `document` |
| patient index and match decisions | `identity` |
| referral state, saga, timer, execution ledger | `workflow` |
| work items and assignment | `queue` |
| outbox and event append mechanism | infrastructure library called inside the owning module transaction |

Gateways and workers may store opaque bytes in object storage or perform
compute, but should return a command to the owner to change domain state.

### 2. Do not describe Postgres as providing exactly-once effects

The design can provide atomic state-plus-outbox persistence, at-least-once
delivery, and effectively-once handling where idempotency or reconciliation is
available. It cannot guarantee exactly-once execution in a foreign system.

Use precise guarantees:

- one committed outbox intent for one accepted workflow transition;
- at-least-once dispatch;
- ordered dispatch per aggregate while a valid lease is held;
- idempotent acceptance in ACCESS by `execution_id`;
- effectively-once foreign effect only when the connector can prove it; and
- an exception when the outcome cannot be established safely.

### 3. Redesign hash-chain sequencing

A single monotonically increasing sequence and `prev_hash` per tenant creates a
serialization point for every event in that tenant. It also complicates
concurrent transactions: the final hash depends on which transaction commits
first.

Choose and benchmark one design:

- per-aggregate chains plus periodic tenant-level Merkle roots;
- a serialized tenant event appender for lower-volume tenants; or
- independently appendable events, periodically anchored in a signed ledger.

Document what tampering the mechanism detects. A hash chain detects later
modification or removal when a trusted anchor exists; it does not prove that an
original event was accurate, prevent an authorised writer from emitting a false
event, or replace immutable backups and access controls.

### 4. Split measurement facts from event requirements

Requiring a fully populated `measurement` object on every event encourages fake
zeros. Human effort is known when work completes, machine time may span several
attempts, and financial outcomes are often attributed later.

Keep stable technical facts on the event, but allow unknown values:

```json
{
  "measurement": {
    "machine_ms": 412,
    "staff_seconds": null,
    "confidence": { "value": 0.974, "calibration_version": "identity.v3" }
  }
}
```

Record staff activity as separate work-session events and derive metrics in
versioned projections. Retain the raw numerator, denominator, attribution rule,
and projection version so historical ROI can be reproduced.

### 5. Separate record linking from patient merging

Resolving a referral to an existing patient is a link decision. Merging two
patient records is a destructive master-data operation with a different risk
class. An `identity_exception` work item offering “link referral to patient”
must not call `merge_patient_records` or require the same implementation path.

Use distinct operations:

```text
referral.link_patient       reversible with audit and correction
patient.propose_merge       creates a proposal only
patient.execute_merge       privileged, approved, system-capability dependent
```

### 6. Reads still require policy

`READ bypasses` is unsafe wording. Reads may bypass the **consequential-write
approval flow**, but must still pass authentication, tenant isolation,
purpose/role checks, and field-level disclosure rules. Appointment information,
documents, and identity candidates are sensitive even when no state changes.

Model two decisions:

```text
authorise_access(subject, resource, fields, purpose)
authorise_action(actor, operation, payload_hash, consequence_class)
```

The first applies to reads and writes. The second controls effects and approval.

### 7. Make grants safe for asynchronous execution

A short-lived, single-use policy token can expire before a delayed outbox item
runs. Conversely, a long-lived bearer grant expands the blast radius. Define
whether policy is evaluated when intent is committed, immediately before
execution, or both.

Recommended approach:

- persist the decision, policy hash, action hash, and approval evidence with the
  intent;
- mint a short-lived execution credential just before connector invocation;
- re-evaluate if relevant context or policy changed;
- atomically consume the grant against `execution_id`; and
- make the connector verify issuer, audience, tenant, action hash, expiry, and
  execution ID.

### 8. Tighten tenant-isolation mechanics

`SET LOCAL ROLE` and `app.current_org_id` are useful only inside a correctly
managed transaction. Define how connection pooling resets state, how workers
iterate tenants, and how privileged operations are isolated.

Minimum tests should prove:

- missing tenant context fails closed;
- tenant A cannot read or mutate tenant B through every query path;
- prepared statements and pooled connections do not retain tenant context;
- table owners and migration roles are unavailable to application handlers;
- background jobs use a tenant-scoped transaction rather than a cross-tenant
  application query; and
- support access is time-bound, approved, and audited.

### 9. Formalise backpressure and ordering

Advisory locks provide mutual exclusion, but not by themselves fair ordering or
bounded queues. Define the row-claim query, lease renewal, attempt state, and
head-of-line behaviour. A poison item must not block every later action forever,
but skipping it may violate aggregate order.

Set explicit limits for:

- maximum pending and in-flight work per tenant and connector;
- priority classes and fairness;
- connector circuit breaking;
- maximum attempt age and reconciliation cycles;
- patient-visible behaviour during degradation; and
- the terminal exception path.

### 10. Define the Postgres exit criteria now

Postgres is a sensible initial queue because it preserves the transactional
outbox without another operational dependency. Reconsider it when measured
requirements exceed the design, not because a broker is fashionable.

Record trigger thresholds for sustained dispatch throughput, table/index size,
vacuum pressure, replica lag, timer precision, queue latency, multi-region
operation, and independent retention/replay requirements. A future broker would
consume the outbox; it would not replace the state transaction.

## Contract changes

### Command envelope

All state-changing entry points—including callbacks, timers, and human
resolution—should use the same envelope:

```json
{
  "command_id": "uuid",
  "tenant_id": "uuid",
  "type": "execution.completed",
  "actor": { "kind": "connector", "id": "goodx:tenant-7" },
  "subject": { "kind": "referral", "id": "uuid" },
  "correlation_id": "uuid",
  "causation_id": "uuid",
  "expected_version": 17,
  "issued_at": "2026-09-19T08:14:04Z",
  "payload": {},
  "evidence": {}
}
```

Persist command deduplication independently from effect idempotency. A repeated
`command_id` returns its prior result; an `execution_id` identifies one intended
foreign effect across dispatch and reconciliation attempts.

### Connector capability document

Capabilities need semantics, not only operation names:

```json
{
  "connector_id": "goodx",
  "version": "1.4.2",
  "operations": {
    "patient.create": {
      "modes": ["DIRECT", "PREPARED_ACTION"],
      "idempotency": "NATIVE | READBACK | NONE",
      "reconciliation": true,
      "max_payload_version": "patient.v2",
      "typical_latency_ms": 700
    }
  }
}
```

Capabilities should be cached with a version and expiry. A workflow plan records
the capability version it used. A capability disappearing after planning must
yield a controlled re-plan or exception, never silent degradation.

### Connector result

Do not combine HTTP success with business success. Authenticate the connector
response, require an echoed `execution_id`, and make fields conditional on
status. For `AMBIGUOUS`, evidence must state what is unknown; for `DEFERRED`, the
work item should be created by the queue owner from the returned prepared-action
descriptor rather than by the connector.

## Deployment comments

The regional private topology is a reasonable target, subject to four changes:

1. Treat “one pod per tenant-connector” as a security deployment option, not an
   invariant. At larger tenant counts, isolated jobs or sandboxes with distinct
   identities may preserve the boundary at lower cost.
2. Keep raw artifacts out of database rows. Store encrypted objects and retain
   only immutable location, digest, media type, size, and malware-scan status in
   the intake aggregate.
3. The de-identification gateway should own tokenisation and vault access; the
   extraction worker should call it, not receive general detokenisation rights.
   Only the domain path that needs identified fields may resolve approved tokens.
4. “EU-pinned” is configuration, not a compliance conclusion. Record tenant
   residency, subprocessors, backups, telemetry destinations, support access,
   retention, deletion, and key-location requirements.

## Architecture fitness tests

The important rules should be executable rather than relying on review:

| Invariant | Test |
| --- | --- |
| Core never makes foreign calls in a transaction | Import rule plus network-deny integration test |
| Model receives no direct identifiers | Canary PII corpus at the inference boundary |
| Only workflow advances referral state | Database privileges plus architecture/import test |
| State, event, and outbox commit atomically | Kill process before and after each write boundary |
| Ambiguous execution is never blindly retried | Connector fault-injection contract suite |
| Cross-tenant access fails closed | Property-based RLS tests on all tenant tables |
| Commands and executions deduplicate | Concurrent redelivery and crash-recovery tests |
| Aggregate effects preserve order | Parallel dispatcher stress test |
| Capability loss degrades explicitly | Connector-version compatibility suite |
| Evidence remains verifiable | Mutation, deletion, restore, and anchor verification tests |

## ADRs required during the first production-grade vertical slice

1. Aggregate and table ownership.
2. Outbox leasing, ordering, and poison-item handling.
3. Execution outcome and reconciliation state machine.
4. Evidence chaining, anchoring, correction, and retention.
5. Tenant database roles, pools, worker access, and support access.
6. Pseudonymisation boundary and model-provider data handling.
7. Policy evaluation time, approval lifecycle, and grant verification.
8. Connector capability negotiation and fallback ladder.
9. Artifact retention, malware scanning, and deletion.
10. Measurement attribution and benefit-ledger projection versions.

## Recommended decision

Adopt the architecture as the **target direction**, with the modular monolith,
outbox, single workflow writer, isolated connector runtime, and ambiguous-write
reconciliation as non-negotiable foundations. Do not freeze the supplied
contracts until ownership, read authorisation, hash-chain concurrency, policy
grant timing, and measurement semantics are corrected.

The best next engineering artefact is not another diagram. It is a
production-grade vertical slice that receives one synthetic referral, extracts
a fixed schema, resolves one identity, commits one mock connector action,
survives a forced timeout, and proves its state/event/outbox and tenant-isolation
invariants under production-like load and failure tests. “Vertical slice” limits
the feature surface, not the engineering quality or operational standard.
