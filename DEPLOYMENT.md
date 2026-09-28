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
3. **Migrations**: deploy the Railway `migrate` service (section 2) or run
   `MIGRATION_DATABASE_URL=… npm run db:migrate` from an operator machine. The
   runner is ledger-based, idempotent and applies `supabase/migrations` in
   order; `0010` adds `scheduling.schedule_signals` to the
   `supabase_realtime` publication.
4. **Runtime logins** (once):
   `psql "$MIGRATION_DATABASE_URL" --set=api_password=… --set=worker_password=… -f supabase/provisioning/runtime-roles.sql`
   The logins are `NOINHERIT NOBYPASSRLS`, own nothing and have only the
   privileges the migrations grant.
5. **Storage** (once):
   `psql "$MIGRATION_DATABASE_URL" -v bucket=access-artifacts -f supabase/provisioning/storage-bucket.sql`
   The bucket is private with no browser policies; the API stores only
   AES-256-GCM ciphertext and serves documents itself through one-minute
   signed links.
6. **Connection strings**: use the Supavisor pooler with the role-qualified
   user (`access_request.<project-ref>`). Runtime logins work in session or
   transaction mode (all context is transaction-scoped); the migration job
   needs **session** mode (it holds a session advisory lock).

## 2. Railway

Create one Railway project per environment (staging, production) and four
services from this repository:

| Service   | Config file (Settings → Config-as-code) | Public domain       |
| --------- | --------------------------------------- | ------------------- |
| `api`     | `infra/railway/api.railway.toml`        | yes (console, Meta) |
| `worker`  | `infra/railway/worker.railway.toml`     | no                  |
| `migrate` | `infra/railway/migrate.railway.toml`    | no                  |
| `clamav`  | Docker image `clamav/clamav:stable`     | no (private, 3310)  |

Each file lists its variables. Common to all: `ACCESS_DEPLOYMENT_PROFILE`,
`ACCESS_DATA_MODE`, `NODE_ENV=production`, `BUILD_ID=${{RAILWAY_GIT_COMMIT_SHA}}`,
`DATABASE_SSL=require`, `DATABASE_CA_CERT`. Use shared variables for values
two services need (`IDENTIFIER_HASH_KEY`, `METRICS_TOKEN`), and set the API's
`CLAMAV_HOST=clamav.railway.internal`.

**Release order** for a change with a migration:

1. Deploy `migrate` (it runs, prints what it applied, and stops).
2. Deploy `api` (readiness check `/ready`; old replicas drain for 25 s).
3. Deploy `worker` (readiness `/ready` on its `PORT`; in-flight leases expire harmlessly).

Migrations are additive and backward compatible with the running release
(below), so step 1 never breaks the release still serving.

**Rollback**: redeploy the previous successful deployment of `api` and
`worker` in Railway. Migrations are not rolled back; because they are
additive, the previous release runs against the newer schema.

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
   the number to the practice (owner credential, once):
   ```bash
   MIGRATION_DATABASE_URL=… npm run channel:whatsapp:connect -- \
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

```bash
MIGRATION_DATABASE_URL=… npm run practice:bootstrap -- \
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

For staging or a demonstration, `npm run practice:demo -- --tenant … --practice …`
adds synthetic locations, practitioners, types, hours and patients (refused
with REAL data).

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
