# Client-pilot checklist

The `client-pilot` profile enforces security boundaries in code, but **real
patient data may be used only when every item below is evidenced** (link the
evidence in the release record). Until then run the pilot deployment with
`ACCESS_DATA_MODE=SYNTHETIC`.

## Enforced by configuration (startup refuses otherwise)

- [ ] `NODE_ENV=production`, `ACCESS_DEPLOYMENT_PROFILE=client-pilot`
- [ ] JWT auth: issuer, audience and JWKS (or ≥32-char secret) configured; synthetic bridge off
- [ ] `API_DATABASE_URL` as `access_request`, `WORKER_DATABASE_URL` as `access_worker`; no migration URL on either
- [ ] `DATABASE_SSL=require` with the provider CA
- [ ] `ARTIFACT_STORE=supabase` (private bucket verified at startup), random 32-byte key
- [ ] `ARTIFACT_SCANNER=clamav` reachable
- [ ] Explicit https `CONSOLE_ORIGIN`
- [ ] `CONNECTOR_KIND=none` (manual destination) unless a connector passed qualification

## Verify in the deployed environment

- [ ] **Workforce authentication:** staff users exist only in Supabase Auth; public sign-up disabled; MFA per client policy; one ADMIN bootstrapped; memberships reviewed
- [ ] **RLS:** run `npm run test:integration` against a disposable copy of the migrated schema; `SELECT relname, relforcerowsecurity FROM pg_class …` shows forced RLS on all tenant tables
- [ ] **Restricted runtime roles:** `supabase/provisioning/runtime-roles.sql` output shows NOSUPERUSER/NOBYPASSRLS/NOINHERIT and zero owned tables; API/worker start (they verify this)
- [ ] **Managed private artifact storage:** bucket `public=false`, no storage policies for anon/authenticated (`storage-bucket.sql` output)
- [ ] **Production file scanning:** upload the EICAR test string → case `EXCEPTION` with `FILE_SAFETY`, nothing stored; stop clamd → upload fails with 503
- [ ] **TLS:** API behind HTTPS ingress (`allowInsecure: false`); DB TLS verified
- [ ] **Secrets manager:** all six secrets in Key Vault; none in app settings, images or repository (`npm run check:secrets`)
- [ ] **Backups/PITR** enabled on the Supabase project with the agreed retention
- [ ] **Tested restore:** restore PITR into an isolated project, run migrations, verify evidence chains (`GET /v1/cases/:id/evidence/verify`) and counts; record RPO/RTO
- [ ] **Audit logging:** Log Analytics retention set (90 days default); `access_audit_log` and evidence reviewed; logs contain no patient fields (spot check)
- [ ] **Retention settings:** `ARTIFACT_RETENTION_DAYS` agreed with the client; deletion procedure (runbooks) accepted
- [ ] **Privacy approval / data-processing agreement** signed; data residency (region) approved
- [ ] **Destination workflow:** manual destination procedure trained (staff enter referral in PMS, record reference in ACCESS); or connector qualification evidence attached
- [ ] **Clinical safety:** the client's clinical owner accepts the safety-hold procedure (who reviews `SAFETY` items and how fast)
- [ ] **Synthetic E2E qualification** (`npm run qualify:synthetic`, Flows A–I) passed on the deployed build's commit; report attached
- [ ] **Rule set** for the client published and reviewed (no clinical content), version recorded
- [ ] **Operational ownership:** on-call contact, runbooks walked through, alert on poison/escalated executions and oldest outbox age

Sign-off: product owner, client clinical/safety owner, security, privacy.
