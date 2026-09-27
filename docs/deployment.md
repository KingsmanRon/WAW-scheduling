# Deployment

One immutable image runs three processes: API (`node apps/core-api/dist/server.js`),
worker (`node apps/worker/dist/main.js`) and the migration job
(`node packages/db/dist/migrate.js`). Configuration is validated at startup
(`packages/config`); a violation prints the offending variable names and exits
with code 78.

## Profiles

|                            | `local`             | `synthetic-staging`  | `client-pilot`                                             | `production`                  |
| -------------------------- | ------------------- | -------------------- | ---------------------------------------------------------- | ----------------------------- |
| Data                       | SYNTHETIC           | SYNTHETIC            | SYNTHETIC → REAL after checklist                           | REAL                          |
| Auth                       | synthetic bridge    | JWT (bridge allowed) | **JWT only**                                               | **JWT only**                  |
| DB TLS                     | optional            | recommended          | **required**                                               | **required**                  |
| Runtime role check         | skipped             | enforced             | enforced                                                   | enforced                      |
| Artifact store             | local encrypted     | local or Supabase    | **Supabase (private)**                                     | **Supabase (private)**        |
| Scanner                    | mock                | mock or ClamAV       | **ClamAV**                                                 | **ClamAV**                    |
| Connector                  | mock                | mock                 | `none` (manual destination) until a connector is qualified | qualified connector or `none` |
| Fixtures / fault injection | allowed             | allowed              | refused                                                    | refused                       |
| CORS                       | any explicit origin | explicit             | explicit https                                             | explicit https                |
| Where                      | laptop / Compose    | Railway or Azure     | Azure Container Apps                                       | Azure Container Apps          |

## Credentials (never shared between processes)

| Secret (Key Vault name)                                                        | Consumer           |
| ------------------------------------------------------------------------------ | ------------------ |
| `api-database-url` → `API_DATABASE_URL` (`access_request`)                     | API                |
| `worker-database-url` → `WORKER_DATABASE_URL` (`access_worker`)                | worker             |
| `migration-database-url` → `MIGRATION_DATABASE_URL` (owner)                    | migration job only |
| `database-ca-cert` → `DATABASE_CA_CERT`                                        | all                |
| `artifact-encryption-key` → `ARTIFACT_ENCRYPTION_KEY` (`openssl rand -hex 32`) | API                |
| `supabase-service-role-key` → `SUPABASE_SERVICE_ROLE_KEY`                      | API                |

The console (Vercel) receives only `VITE_CORE_API_URL`, `VITE_AUTH_MODE=supabase`,
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — all public.

## Supabase

1. Create the project in the approved region; enable PITR backups.
2. Run migrations as the owner (0004 creates `btree_gist` if absent; on
   Supabase it may already exist in the `extensions` schema, which is on the
   default search path): `MIGRATION_DATABASE_URL=… npm run db:migrate`
   (or the Azure job). The runner is ledger-based and idempotent; it baselines
   `0001`/`0002` if they were recorded by the v1 runner.
3. Provision runtime logins: `psql "$MIGRATION_DATABASE_URL" --set=api_password=… --set=worker_password=… -f supabase/provisioning/runtime-roles.sql`.
4. Create the private bucket: `psql "$MIGRATION_DATABASE_URL" -v bucket=access-artifacts -f supabase/provisioning/storage-bucket.sql`.
5. Auth: disable public sign-ups, create staff users, require MFA as per the
   client's policy; note the JWKS URL (`https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`)
   and issuer (`https://<ref>.supabase.co/auth/v1`).
6. Bootstrap the organisation: `TENANT_ID=… TENANT_NAME=… ADMIN_USER_ID=<auth user id> RULES_FILE=client-rules.json npm run tenant:bootstrap`
   (default: default rules with `MANUAL` destination). Further staff are added
   by the ADMIN in the API (`POST /v1/admin/memberships`).

## Azure (reference production target)

```bash
docker build -t "$REGISTRY/access:$GIT_SHA" . && docker push "$REGISTRY/access:$GIT_SHA"
IMAGE="$REGISTRY/access@$(docker inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/access:$GIT_SHA" | cut -d@ -f2)"
az keyvault secret set --vault-name "$KV" --name api-database-url --value "…"   # and the others above
RESOURCE_GROUP=access-pilot PREFIX=access-pilot IMAGE="$IMAGE" KEY_VAULT_NAME="$KV" \
  SUPABASE_URL=https://<ref>.supabase.co AUTH_JWT_ISSUER=https://<ref>.supabase.co/auth/v1 \
  AUTH_JWKS_URL=https://<ref>.supabase.co/auth/v1/.well-known/jwks.json \
  CONSOLE_ORIGIN=https://console.example.org ACCESS_DEPLOYMENT_PROFILE=client-pilot \
  ACCESS_DATA_MODE=SYNTHETIC CONNECTOR_KIND=none infra/azure/deploy.sh
```

`main.bicep` creates a user-assigned identity with _Key Vault Secrets User_ on
the vault, the API (with a ClamAV sidecar on localhost:3310), the worker (one
replica) and a manual migration job; `deploy.sh` requires a digest-pinned
image, runs the migration job, then restarts the revisions. Grant AcrPull to
the output identity first if the image is in a private registry. Switch
`ACCESS_DATA_MODE=REAL` only after the client-pilot checklist is complete.

## Vercel (console)

`vercel deploy --prod --cwd apps/console` with the four public `VITE_*`
variables. `infra/vercel/vercel.json` adds security headers.

## Railway (synthetic staging only)

Two services from the same image (`infra/railway/*.toml`). Variables are listed
in those files. Railway is not a supported target for real patient data.

**Breaking change for the existing Railway staging:** set
`ACCESS_DEPLOYMENT_PROFILE=synthetic-staging` on both services (required when
`NODE_ENV=production`), `CONNECTOR_KIND=mock` on the worker, and run the
migration once with the owner URL to apply `0003`–`0006`.

**Appointment operations (0006):** run the migration before deploying the new
API and worker. No new variable or secret. `CONNECTOR_CAPABILITIES` empty
means every capability the connector implements; if it is set explicitly,
automated booking needs `appointment.availability.read`, `appointment.create`
and `appointment.status.read` (read-back is required: a booking counts only
once read back), plus `appointment.hold`, `appointment.reschedule` and
`appointment.cancel` for holds, rescheduling and cancellation. With
`CONNECTOR_KIND=none` every booking step fails closed into a staff exception,
and booking stays manual (`record_booking`).

## Local

`docker compose up --build` (profile `local`, synthetic everything).
