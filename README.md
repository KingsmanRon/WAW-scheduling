# ACCESS — Referral Operations (v1.1)

ACCESS is a standalone patient-access orchestration layer. It converts inbound
referrals into verified, complete, tracked and measurable outcomes inside the
provider's existing systems:

```text
referral received → patient resolved → information completed → administrative
readiness determined → destination updated → ready for booking → appointment
booked or referral deliberately closed → business outcome measured
```

ACCESS makes **deterministic administrative decisions only** (identity
sufficiency, required information and documents, configured routing, connector
availability, when staff must intervene). It never decides diagnosis, clinical
urgency, prioritisation, treatment suitability or clinical acceptance. Anything
that looks urgent or clinical is routed to a human safety workflow.

## Status

| Capability                                                                     | Implemented       | Client-pilot ready                       | Production ready                     |
| ------------------------------------------------------------------------------ | ----------------- | ---------------------------------------- | ------------------------------------ |
| `access_case` aggregate (REFERRAL; five other case types defined, fail closed) | yes               | yes                                      | yes                                  |
| Case lifecycle through booking or deliberate closure, resolution codes         | yes               | yes                                      | yes                                  |
| Append-only interactions, outcome observations, effort events                  | yes               | yes                                      | yes                                  |
| Versioned, immutable administrative rule sets + deterministic evaluator        | yes               | yes                                      | yes                                  |
| Business measurement with provenance (case and cohort)                         | yes               | yes                                      | yes                                  |
| Workforce auth: Supabase JWT + membership-derived tenant and role              | yes               | yes (after IdP setup)                    | needs pen test                       |
| PostgreSQL RLS, least-privilege runtime roles, ledger migrations               | yes               | yes                                      | yes                                  |
| Managed private artifact storage (Supabase Storage + app-layer AES-GCM)        | yes               | yes (after bucket provisioning)          | needs key rotation                   |
| Malware scanning (ClamAV INSTREAM sidecar), fail closed                        | yes               | yes (after clamd deployment)             | needs signature monitoring           |
| Manual destination workflow (staff enters referral in the PMS)                 | yes               | **yes — the pilot destination path**     | yes                                  |
| Automated destination connector                                                | mock only         | **no** (no real PMS connector qualified) | no                                   |
| Closed-loop outcome readback                                                   | port + mock       | staff/import only                        | needs a qualified connector          |
| Staff console: queue, case detail, actions, dashboard, rules                   | yes               | yes                                      | needs usability/accessibility review |
| Email / WhatsApp / voice / patient portal channels                             | defined, disabled | no                                       | future                               |
| Appointment scheduling, rescheduling, cancellation cases                       | defined, disabled | no                                       | future                               |

"Client-pilot ready" still requires every gate in
[docs/client-pilot-checklist.md](docs/client-pilot-checklist.md) before any
identifiable patient data is used. **Until then: synthetic data only.**

## Architecture

TypeScript modular monolith over PostgreSQL (Supabase).

- `apps/core-api` — Fastify API: intake, interactions, staff actions, outcome
  import, queue/case/metrics queries, rule-set and membership administration.
  JWT auth, artifact storage port, scanner port, extraction port.
- `apps/worker` — leased, case-ordered outbox dispatcher; ambiguous-write
  reconciler; outcome readback poller; follow-up/escalation timers.
- `apps/console` — React/Vite staff console (Supabase sign-in).
- `packages/contracts` — versioned schemas and the platform vocabulary.
- `packages/domain` — case state machine and outcome-observation planning.
- `packages/rules` — typed rule-set schema and deterministic evaluator.
- `packages/policy` — RBAC and case-type/operation authorisation.
- `packages/db` — case engine, evidence chain, command idempotency, metrics,
  ledger migration runner, seeding/bootstrap.
- `packages/config` — fail-closed startup configuration per profile.
- `supabase/migrations` — `0001`–`0005` (additive; applied by the ledger runner).

Read next: [ADR 0002 — case aggregate](docs/adr/0002-access-case-aggregate.md),
[ADR 0003 — execution, identity and storage](docs/adr/0003-execution-identity-storage.md),
[data model](docs/data-model.md), [contracts](docs/contracts.md),
[security](docs/security.md), [deployment](docs/deployment.md),
[runbooks](docs/runbooks.md), [rules guide](docs/rules-guide.md),
[connector qualification](docs/connector-qualification.md),
[synthetic qualification](docs/qualification.md).

## Local development (synthetic data)

Node 20+, npm, PostgreSQL 16 (or Docker Compose).

```bash
cp .env.example .env
npm ci
docker compose up --build        # postgres, migrate, seed, api :3001, worker
VITE_AUTH_MODE=synthetic npm -w @access/console run dev   # console :3000
```

Without Compose:

```bash
set -a; source .env; set +a
npm run db:migrate               # MIGRATION_DATABASE_URL (owner)
npm run db:seed                  # synthetic organisations + default rule sets
psql "$MIGRATION_DATABASE_URL" -c "ALTER ROLE access_request LOGIN PASSWORD 'local-placeholder'; ALTER ROLE access_worker LOGIN PASSWORD 'local-placeholder'"
npm -w @access/core-api run dev
npm -w @access/worker run dev
```

Synthetic organisation `11111111-…` uses the (mock) connector destination;
`22222222-…` uses the manual destination workflow. In the console choose a
role and use the synthetic fixtures (`complete`, `missing-insurance`,
`ambiguous-identity`, `urgent`) or the structured intake form.

## Checks

```bash
npm run format && npm run lint && npm run typecheck
npm run test:unit
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/access_test npm run test:integration
npm run qualify:synthetic          # Flows A-I; set QUALIFICATION_REPORT=report.json
npm run build && npm run validate:infra && npm run check:secrets
```

The integration project drops and re-migrates the test database, then runs
every PostgreSQL suite with the real `access_request`/`access_worker` logins.
In CI a missing database fails the build; skipped tests fail the build.

## Deployment

See [docs/deployment.md](docs/deployment.md). Profiles: `local`,
`synthetic-staging`, `client-pilot`, `production`. Azure Container Apps is the
reference production target (`infra/azure`), with Supabase for PostgreSQL,
Auth and Storage and Vercel for the console. Railway is synthetic-staging only.

The historical planning documents (`PRODUCT_ASSESSMENT.md`,
`ARCHITECTURE_REVIEW.md`, `IMPLEMENTATION_HANDOFF.md`, `NEXT_CHAT_PROMPT.md`)
describe the pre-v1.1 slice and are kept for context only.
