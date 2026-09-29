# Deployment

| Where        | What                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ |
| **Supabase** | PostgreSQL (all data), Auth (staff sign-in), Storage (private documents), Realtime               |
| **Railway**  | `api`, `worker`, `migrate` (one-off job) and `clamav`, built from this repository's `Dockerfile` |
| **Vercel**   | The practice console (static build of `apps/console`)                                            |

One image runs the API (`node apps/core-api/dist/server.js`), the worker
(`node apps/worker/dist/main.js`) and the migration job
(`node packages/db/dist/migrate.js`). Every process validates its
configuration at start and exits with code 78, naming the offending
variables, on any violation. `.env.example` lists every variable name.

## Profiles

|                           | `local`          | `synthetic-staging`           | `client-pilot`                       | `production`                |
| ------------------------- | ---------------- | ----------------------------- | ------------------------------------ | --------------------------- |
| Data                      | SYNTHETIC        | SYNTHETIC                     | SYNTHETIC → REAL after the checklist | REAL                        |
| Staff auth                | synthetic bridge | Supabase JWT (bridge allowed) | **Supabase JWT only**                | **Supabase JWT only**       |
| Database TLS              | optional         | recommended                   | **required**                         | **required**                |
| Runtime login check       | skipped          | enforced                      | enforced                             | enforced                    |
| Documents                 | local encrypted  | Supabase private bucket       | **Supabase private bucket**          | **Supabase private bucket** |
| Malware scanner           | mock             | mock or ClamAV                | **ClamAV**                           | **ClamAV**                  |
| Messages to patients      | allow-list only  | allow-list only               | allow-list until REAL                | all consenting patients     |
| Fixtures, fault injection | allowed          | allowed                       | refused                              | refused                     |

**Staging never holds production patient data.** Staging and production
are separate Supabase projects, separate Railway environments and separate
Vercel projects; `synthetic-staging` refuses `ACCESS_DATA_MODE=REAL`, and in
synthetic modes the worker sends WhatsApp and e-mail only to
`NOTIFICATION_RECIPIENT_ALLOWLIST`. Copying production data into staging is
not supported; seed staging with `npm run practice:demo`.

## Credentials

Every secret lives in the platform's variable store (Railway variables,
Vercel environment variables); none is committed. Each credential goes to
the one service that needs it:

| Variable                                                | Service         | Notes                                                                                            |
| ------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `MIGRATION_DATABASE_URL`                                | `migrate` only  | owner (`postgres`) login, **session** pooler (port 5432)                                         |
| `API_DATABASE_URL`                                      | `api`           | `access_request.<project-ref>` via the Supabase pooler                                           |
| `WORKER_DATABASE_URL`                                   | `worker`        | `access_worker.<project-ref>` via the Supabase pooler                                            |
| `DATABASE_SSL=require`, `DATABASE_CA_CERT`              | all three       | the Supabase CA certificate (PEM)                                                                |
| `SUPABASE_SERVICE_ROLE_KEY`                             | `api` only      | Storage access for documents. **Never** the console, Vercel or the worker                        |
| `ARTIFACT_ENCRYPTION_KEY`                               | `api`           | 64 hex (`openssl rand -hex 32`); also derives the document-link key                              |
| `IDENTIFIER_HASH_KEY`, `IDENTIFIER_HASH_KEY_ID`         | `api`, `worker` | 64 hex, the same value on both (patient identifier hashes)                                       |
| `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, `AUTH_JWKS_URL` | `api`           | `https://<ref>.supabase.co/auth/v1`, `authenticated`, `…/.well-known/jwks.json`                  |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`          | `api`           | Meta app secret (webhook signatures), your chosen verify token                                   |
| `WHATSAPP_<NAME>_TOKEN`                                 | `worker`        | one per WhatsApp number: a Meta system-user access token, named by the connection's `secret_ref` |
| `SMTP_URL`, `SMTP_FROM`                                 | `worker`        | optional e-mail notifications                                                                    |
| `EMR_WEBHOOK_<NAME>_SECRET`                             | `worker`        | optional, one per EMR webhook connection                                                         |
| `ANTHROPIC_API_KEY`                                     | `worker`        | only if `INTENT_CLASSIFIER=anthropic` (optional)                                                 |
| `METRICS_TOKEN`                                         | `api`, `worker` | bearer token for `/metrics`                                                                      |

The console receives only public values: `VITE_CORE_API_URL`,
`VITE_AUTH_MODE=supabase`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. The
security suite builds the console with a service key in the build
environment and fails if it reaches the bundle.

Rotating a secret: set the new value on the service and redeploy it.
`ARTIFACT_ENCRYPTION_KEY` and `IDENTIFIER_HASH_KEY` protect stored data:
rotate them only with a re-encryption / re-hashing plan (RUNBOOK.md).

## 1. Supabase

1. Create the project in the approved region (South Africa: `af-south-1`
   when available to the account, otherwise the nearest approved region
   under the operator agreement). Enable point-in-time recovery.
2. **Auth**: disable public sign-ups; create staff users (e-mail + password
   or magic link) and require MFA according to the practice's policy. Note
   the project URL, anon key and the JWT issuer/JWKS URL.
3. **Migrations**: deploy the Railway `migrate` service (section 2). The
   runner is ledger-based, idempotent and applies `supabase/migrations` in
   order; `0010` adds `scheduling.schedule_signals` to the
   `supabase_realtime` publication.
4. **Runtime logins** (once, from a checkout):
   `railway run -s migrate -e production -- sh -c 'psql "$MIGRATION_DATABASE_URL" --set=api_password=… --set=worker_password=… -f supabase/provisioning/runtime-roles.sql'`
   The logins are `NOINHERIT NOBYPASSRLS`, own nothing and have only the
   privileges the migrations grant.
5. **Storage** (once):
   `railway run -s migrate -e production -- sh -c 'psql "$MIGRATION_DATABASE_URL" -v bucket=access-artifacts -f supabase/provisioning/storage-bucket.sql'`
   The bucket is private with no browser policies; the API stores only
   AES-256-GCM ciphertext and serves documents itself through one-minute
   signed links.
6. **Connection strings**: use the Supavisor pooler with the role-qualified
   user (`access_request.<project-ref>`). Runtime logins work in session or
   transaction mode (all context is transaction-scoped); the migration job
   needs **session** mode (it holds a session advisory lock).
7. **Data API**: ACCESS does not use Supabase's Data API (PostgREST). `0014`
   removes every grant Supabase gives `anon`, `authenticated` and
   `service_role` in `public`; as defence in depth, also turn the Data API
   off (Project Settings → Data API) or remove `public` from its exposed
   schemas. Realtime, Auth and Storage do not depend on it.

## 2. Railway

Create one Railway project (`access`) with two environments, `staging` and
`production` (each has its own variables, deployments and private
network), and four services from this repository:

| Service   | Config file (Settings → Config-as-code) | Public domain       |
| --------- | --------------------------------------- | ------------------- |
| `api`     | `infra/railway/api.railway.toml`        | yes (console, Meta) |
| `worker`  | `infra/railway/worker.railway.toml`     | no                  |
| `migrate` | `infra/railway/migrate.railway.toml`    | no                  |
| `clamav`  | Docker image `clamav/clamav:stable`     | no (private, 3310)  |

Each file lists its variables. Common to all: `ACCESS_DEPLOYMENT_PROFILE`,
`ACCESS_DATA_MODE`, `NODE_ENV=production`, `DATABASE_SSL=require`,
`DATABASE_CA_CERT` (`BUILD_ID` is optional: `/health` otherwise reports
Railway's commit or deployment id). Use shared variables for values
two services need (`IDENTIFIER_HASH_KEY`, `METRICS_TOKEN`), and set the API's
`CLAMAV_HOST=clamav.railway.internal`.

**Release order**: `migrate`, then `api`, then `worker` (commands below).
The order is also enforced: a build's `/ready` answers 503
(`schema_behind`) and its worker does no work until the database has the
newest migration the build ships with, so an `api` or `worker` deployed
first simply waits (Railway keeps the previous deployment serving until the
new one is ready, or fails the deploy after the health-check timeout).
Migrations are additive and backward compatible with the running release
(below), so applying them never breaks the release still serving; old API
replicas drain for 25 s.

**Rollback**: redeploy the previous successful deployment of `api` and
`worker` (RUNBOOK.md, "Rollback"). Migrations are not rolled back; because
they are additive, the previous release runs against the newer schema.

## 3. Vercel (console)

Create a Vercel project from this repository with **Root Directory**
`apps/console`; `apps/console/vercel.json` sets the monorepo install and
build commands, the output directory and the security headers. Set the four
`VITE_*` variables (Production and Preview separately: previews must point
at staging). Add the console's domain to the API's `CONSOLE_ORIGIN`
(comma-separated for several).

The build writes a Content-Security-Policy that allows connections only to
`VITE_CORE_API_URL` and `VITE_SUPABASE_URL` (HTTPS and WSS); a new API or
Supabase URL needs a rebuild.

## 4. WhatsApp (Meta Cloud API)

Everything below is implemented and tested against a local Graph API
stand-in; **activating a real number only needs Meta credentials**:

1. In Meta Business Manager: a WhatsApp Business Account, a registered
   phone number, an app with the WhatsApp product, and a system user with
   a permanent access token for the number (`whatsapp_business_messaging`).
2. Webhook: callback URL `https://<api-domain>/v1/channels/whatsapp/webhook`,
   verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe to the `messages`
   field. The app secret is `WHATSAPP_APP_SECRET` (signatures are verified
   over the raw body; unsigned or mis-signed calls are refused).
3. Register these templates (category **UTILITY**, language `en`) — names
   and bodies must match exactly (`packages/notifications/src/catalogue.ts`;
   a connection can map to other approved names in its config):

   | Template                    | Body                                                                                                                                                                                    | Buttons (quick reply) |
   | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
   | `appointment_confirmation`  | Hi {{1}}, your appointment at {{2}} is confirmed for {{3}} with {{4}} at {{5}}. To change it, reply to this message or call the practice.                                               |                       |
   | `appointment_rescheduled`   | Hi {{1}}, your appointment at {{2}} has moved to {{3}} with {{4}} at {{5}}. To change it, reply to this message or call the practice.                                                   |                       |
   | `appointment_cancelled`     | Hi {{1}}, your appointment at {{2}} on {{3}} has been cancelled. Reply to this message or call the practice if you would like a new appointment.                                        |                       |
   | `appointment_reminder_24h`  | Hi {{1}}, a reminder of your appointment at {{2}} on {{3}} with {{4}} at {{5}}. Reply to this message if you need to change it.                                                         |                       |
   | `appointment_reminder_soon` | Hi {{1}}, your appointment at {{2}} is at {{3}} with {{4}} at {{5}}. We look forward to seeing you.                                                                                     |                       |
   | `waitlist_offer`            | Hi {{1}}, an appointment has become available at {{2}}: {{3}} with {{4}} at {{5}}. Tap Book it before {{6}} to take it. If we do not hear from you, it will be offered to someone else. | Book it, No thanks    |

4. Set the token on the worker as e.g. `WHATSAPP_ROSEBANK_TOKEN` and route
   the number to the practice (owner credential, once; run from a checkout
   after `npm ci && npm run build`):
   ```bash
   railway run -s migrate -e production -- npm run channel:whatsapp:connect -- \
     --tenant <org uuid> --practice <practice uuid> \
     --phone-number-id <Meta phone_number_id> --display-number +27… \
     --secret-ref WHATSAPP_ROSEBANK_TOKEN [--waba-id …] [--language en]
   ```

The optional intent classifier (`INTENT_CLASSIFIER=anthropic`,
`ANTHROPIC_API_KEY`) is off by default. With REAL data it additionally
requires `INTENT_CLASSIFIER_PROCESSOR_APPROVED=true`, set only once the
practice has approved Anthropic as an operator (POPIA section 21 agreement)
for the minimised message text it receives.

## 5. A new practice

Operator commands run from a checkout (`npm ci && npm run build`) with the
`migrate` service's variables, so the owner credential, `DATABASE_SSL` and
the CA certificate come from Railway and are never copied:

```bash
railway run -s migrate -e production -- npm run practice:bootstrap -- \
  --tenant <org uuid> --tenant-name "Rosebank Health" \
  --name "Rosebank Family Practice" --timezone Africa/Johannesburg \
  --admin-user <Supabase Auth user uuid> --admin-name "Dr N. Admin" \
  [--admin-email admin@example.org]
```

(in the image: `node apps/worker/dist/cli/practice-bootstrap.js …`). The
practice administrator then signs in to the console and sets up locations,
practitioners, appointment types, working hours and leave under **Schedule
setup**. Further staff are granted practice roles through
`PUT /v1/practices/:practiceId/memberships/:userId` (role `PRACTICE_ADMIN`,
`DOCTOR`, `RECEPTIONIST`, `CLINICAL_STAFF` or `READ_ONLY`), a
`staff.manage` permission held by practice administrators.

For staging or a demonstration, `practice:demo` adds synthetic locations,
practitioners, types, hours and patients (refused with REAL data); it also
needs the environment's `IDENTIFIER_HASH_KEY` (the worker's value:
`railway variable list -s worker -e staging -k`):

```bash
railway run -s migrate -e staging -- env IDENTIFIER_HASH_KEY=<staging key> \
  npm run practice:demo -- --tenant <org uuid> --practice <practice uuid>
```

## 6. Deploying to staging

Once per machine: `npm i -g @railway/cli vercel`, `railway login`,
`vercel login`; in a checkout: `railway link` (the `access` project) and
`vercel link` (the **staging** console project), both from the repository
root. Then, for a release candidate whose CI run is green:

```bash
git fetch origin && git checkout <commit>

# 1. Migrations: the job applies what is new, prints it and stops.
railway up -s migrate -e staging --ci
railway logs -s migrate -e staging -n 20
#    last line: {"applied":[…],"baselined":[],"already_applied":N}

# 2. API: goes live once /ready passes (after the migration).
railway up -s api -e staging --ci
railway deployment list -s api -e staging --limit 2
curl -fsS https://<staging-api-domain>/health    # "build": this deployment
curl -fsS https://<staging-api-domain>/ready

# 3. Worker.
railway up -s worker -e staging --ci
railway ssh -s worker -e staging -- node -e "fetch('http://localhost:'+process.env.PORT+'/ready').then(async r=>console.log(r.status,await r.text()))"

# 4. Console (the staging Vercel project's production deployment).
vercel deploy --prod
```

With GitHub auto-deploys on the staging environment instead (services
connected to the repository, "Wait for CI" on), the same order holds: the
API and worker of a new commit stay not-ready until `migrate` has applied
its migrations.

Staging data is synthetic only: `practice:bootstrap` and `practice:demo`
(section 5, with `-e staging`), a WhatsApp test number connected with
`channel:whatsapp:connect`, and the testers' phones in
`NOTIFICATION_RECIPIENT_ALLOWLIST` on the worker.

## 7. Staging acceptance

Run on the exact commit to be released, after section 6. The automated
suites have already passed in CI (unit, integration, concurrency, security,
migrations from a clean database, browser end to end).

1. **Health**: `/health` (its `build` is the commit for GitHub deploys,
   the Railway deployment id for CLI deploys) and `/ready` on the API and
   the worker; `/metrics` answers only with `METRICS_TOKEN`; Prometheus
   shows both targets up.
2. **Sign-in and roles**: sign in as a practice administrator,
   receptionist, doctor, clinical staff member and read-only user; each
   sees only their menus; read-only cannot book (the API answers 403).
3. **Phone booking**: as reception, find a patient, choose type,
   practitioner and time, confirm within the hold time; the appointment
   appears in Today, Day, Week, practitioner and location views; its
   **History** and **Audit** show the receptionist and channel PHONE.
4. **Concurrent desks**: two browsers pick the same time; one books, the
   other sees "The requested time is no longer available." with refreshed
   alternatives.
5. **Changes**: reschedule and cancel (with reason); the allow-listed
   phone receives the WhatsApp templates; **Notifications** shows each
   delivery and its status.
6. **WhatsApp**: from an allow-listed phone, "Hi" → Book → a time → Yes;
   the console shows the booking within seconds; then "cancel" → Yes; the
   console shows it cancelled. "Talk to reception" appears under
   **Conversations → Needs reception**.
7. **Waitlist**: put a patient on the waitlist, cancel a matching
   appointment; the offer arrives; "Book it" books it and closes the entry.
8. **Schedule setup**: add and remove working hours, leave and a block (each
   removal asks first); the times disappear from and return to both the
   console and the WhatsApp list.
9. **Visit**: check in, start, complete; mark another appointment as a
   no-show after its start (asks first).
10. **Referrals**: register a referral with a PDF; a doctor opens it through
    the one-minute link; reception cannot open documents.
11. **Worker outage**: remove the worker's deployment, book an appointment,
    redeploy the worker: the confirmation is sent once, late.
12. **Isolation**: the API without a token answers 401; a second practice's
    ids answer 404. On the Supabase project itself (owner session), the
    browser and service roles hold no table privileges beyond the Realtime
    signal; this must return no rows:

    ```sql
    SELECT r.rolname, n.nspname || '.' || c.relname AS relation
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_roles r
     WHERE n.nspname IN ('public','platform','directory','scheduling','messaging','integration')
       AND c.relkind IN ('r','p') AND r.rolname IN ('anon','authenticated','service_role')
       AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE')
       AND NOT (r.rolname = 'authenticated' AND n.nspname || '.' || c.relname
                IN ('directory.practice_memberships','scheduling.schedule_signals'));
    ```

13. **Rollback drill**: roll `api` back to the previous deployment (RUNBOOK.md),
    check `/ready`, roll forward again.

Record the commit, the date and the result of each step.

## 8. Production release

1. Staging accepted on the same commit (section 7). No open incident; the
   outbox is not backed up (RUNBOOK.md, diagnostic queries).
2. Supabase (production): point-in-time recovery is on; note the current
   time as the restore point.
3. Release:

   ```bash
   git checkout <accepted commit>
   railway up -s migrate -e production --ci
   railway logs -s migrate -e production -n 20      # applied migrations, or stop:
                                                    # RUNBOOK.md, "Migration failure"
   railway up -s api -e production --ci
   railway deployment list -s api -e production --limit 2
   curl -fsS https://<api-domain>/ready
   railway up -s worker -e production --ci
   railway ssh -s worker -e production -- node -e "fetch('http://localhost:'+process.env.PORT+'/ready').then(async r=>console.log(r.status,await r.text()))"
   vercel deploy --prod                               # production console project, if it changed
   ```

4. Smoke test without patient-facing actions: sign in, open Today and a
   practitioner's week, list availability; `curl -sI` the console shows its
   security headers.
5. Watch for 30 minutes: 5xx rate, `slot_conflicts_total`,
   `outbox_oldest_pending_seconds`, notification failures, alerts.
6. Anything wrong: RUNBOOK.md, "Rollback".

## Schema changes

Migrations are **expand → migrate → contract**, never combined with the
code that depends on the removal:

1. **Expand**: add tables, columns (nullable or defaulted), constraints
   `NOT VALID`, new grants. The running release ignores them.
2. **Deploy** code that writes both shapes / reads the new one.
3. **Backfill** and verify (then `VALIDATE CONSTRAINT`).
4. **Contract** in a later release: drop what nothing reads any more.

Pending contract step: the appointment-operations v1 tables
(`appointment_requests`, `appointments`, `appointment_slot_holds` in the
`public` schema, from `0006`) are read-only since `0011`. Once every
environment has applied `0011` and their rows are exported (or judged
disposable, e.g. staging), a migration may drop them together with the
retired case types' rules.

## Local development

Docker Compose (synthetic data only):

```bash
docker compose up --build          # postgres, migrate, api :3001, worker
MIGRATION_DATABASE_URL=postgres://access_owner:access_owner@localhost:5432/access \
  npm run practice:bootstrap -- --tenant 11111111-1111-4111-8111-111111111111 \
  --tenant-name "Synthetic Health" --name "Demo Practice" --timezone Africa/Johannesburg \
  --admin-user 99999999-9999-4999-8999-999999999999 --admin-name "Demo Admin"
MIGRATION_DATABASE_URL=… IDENTIFIER_HASH_KEY=<the compose API's> \
  npm run practice:demo -- --tenant … --practice <printed id>
VITE_AUTH_MODE=synthetic npm -w @access/console run dev   # console :3000
```

In synthetic mode the console's sign-in asserts an organisation id, a
practice role and a name (refused by client-pilot and production).
