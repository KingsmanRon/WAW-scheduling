# ACCESS — appointments and scheduling for medical practices

ACCESS runs a practice's appointment book across every way patients reach
it: reception on the phone and at the desk, WhatsApp, referrals and the
waitlist. One **Scheduling Core** decides availability, holds, bookings and
every change to an appointment; no channel books any other way, and the
database itself refuses a double booking.

- **Practice console** (web): today's list with arrivals and no-shows,
  day and week calendars by practitioner and location, guided booking with
  a five-minute hold, reschedule and cancel, patient search and
  registration, waitlist, referrals with private documents, WhatsApp
  conversations handed to reception, message delivery log, schedule setup
  (hours, leave, types, practitioners, locations) and the audit trail.
  What each person sees and may do follows their practice role.
- **WhatsApp**: patients book, see, move and cancel appointments and accept
  waitlist offers in a guided conversation; anything it cannot handle goes
  to reception. Works without any language model.
- **Notifications**: confirmations, changes, cancellations, reminders and
  waitlist offers by WhatsApp template or e-mail, only with consent, each
  with a visible status and reason.
- **Integrations**: signed webhooks to EMR systems.

## Documentation

| Document                                                         | For                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [ARCHITECTURE.md](ARCHITECTURE.md)                               | how it is built: Scheduling Core, channels, outbox, tenancy, AI boundary |
| [DEPLOYMENT.md](DEPLOYMENT.md)                                   | Supabase, Railway, Vercel, WhatsApp activation, onboarding a practice    |
| [RUNBOOK.md](RUNBOOK.md)                                         | health, logs, alerts, incidents, retention, patient requests             |
| [SECURITY.md](SECURITY.md)                                       | authentication, roles, isolation, data protection, POPIA                 |
| [docs/client-pilot-checklist.md](docs/client-pilot-checklist.md) | gates before real patient data                                           |
| [docs/referral-operations](docs/referral-operations/)            | the organisation referral workspace                                      |

## Repository

```text
apps/core-api      Fastify API (practice API, WhatsApp webhook, documents)
apps/worker        outbox, notifications, WhatsApp access layer, waitlist,
                   webhooks, housekeeping; operator commands in src/cli
apps/console       React console (Vite), deployed to Vercel
packages/scheduling  the Scheduling Core (domain + transactional commands)
packages/patients    patient registry and normalised search
packages/notifications, integrations, access, policy, contracts, db,
config, observability, domain, rules
supabase/migrations  PostgreSQL schema, RLS, grants (ledger-applied)
infra/railway, infra/observability, apps/console/vercel.json
tests/unit, integration, concurrency, security, e2e (vitest)
tests/browser        Playwright end-to-end suite
```

## Local development (synthetic data only)

Node 20+, npm and Docker (or a local PostgreSQL 16).

```bash
npm ci
docker compose up --build        # postgres, migrations, api :3001, worker
export MIGRATION_DATABASE_URL=postgres://access_owner:access_owner@localhost:5432/access
npm run practice:bootstrap -- --tenant 11111111-1111-4111-8111-111111111111 \
  --tenant-name "Synthetic Health" --name "Demo Practice" \
  --timezone Africa/Johannesburg \
  --admin-user 99999999-9999-4999-8999-999999999999 --admin-name "Demo Admin"
IDENTIFIER_HASH_KEY=1111111111111111111111111111111111111111111111111111111111111111 \
  npm run practice:demo -- --tenant 11111111-1111-4111-8111-111111111111 \
  --practice <practice id printed above>
VITE_AUTH_MODE=synthetic npm -w @access/console run dev    # console :3000
```

Sign in with organisation `11111111-1111-4111-8111-111111111111`, any
practice role and a name (the synthetic bridge exists only for local and
staging use).

## Checks

```bash
npm run format && npm run lint && npm run typecheck
npm run test:unit
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/access_test npm run test:integration
npm run build && npm run test:e2e      # needs PostgreSQL; resets the access_e2e database
VALIDATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run db:validate
npm run validate:infra && npm run check:secrets
```

- **Unit**: availability engine and time zones, state machine, booking and
  referral rules, patient normalisation, notification selection, the
  WhatsApp interpreter and classifier boundary, policy, configuration.
- **Integration** (real PostgreSQL, real least-privilege logins):
  migrations and RLS, the Scheduling Core, the practice API, the worker,
  the WhatsApp channel end to end against a Graph API stand-in, referrals
  and documents, waitlist offers.
- **Concurrency**: 25 simultaneous bookings of one slot → exactly one
  booked and 24 `SLOT_UNAVAILABLE`; holds, reschedules and waitlist offers
  racing each other.
- **Security**: the authorisation matrix (every route × every role),
  cross-practice and anonymous access, API hardening, and proof that the
  console bundle holds no server secret.
- **Browser** (Playwright, desktop and phone): the console, API and worker
  as deployed, including WhatsApp ↔ console flows and the waitlist.
- **Migrations**: every migration applied to a clean database standing in
  for Supabase (and to plain PostgreSQL), twice, then the schema's security
  invariants checked.

CI (`.github/workflows/ci.yml`) runs all of them; skipped tests fail the
build.
