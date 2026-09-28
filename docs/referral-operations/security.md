# Security assumptions and residual risks

**Default posture: synthetic data only.** Identifiable patient data is allowed
only in the `client-pilot`/`production` profiles with `ACCESS_DATA_MODE=REAL`
_and_ after every gate in `docs/client-pilot-checklist.md` is evidenced.

## Safety boundary

ACCESS decides administrative facts only. Rule sets are typed data with no
field able to express triage, urgency, diagnosis or treatment, and labels
containing clinical decision terms are rejected. Urgent/clinical-looking
input (synthetic `urgent` fixture, or the staff "looks urgent or clinical"
flag on structured intake) creates a `SAFETY` exception; no extraction or
dispatch happens, and no external fact can move the case out of `EXCEPTION`.
A person decides.

## Controls in code (tested)

| Control                                                                                             | Where                         | Tests                               |
| --------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------- |
| Signed JWT at the edge; tenant/role from membership; header cannot override                         | `apps/core-api/src/auth.ts`   | acceptance 20                       |
| Server-side RBAC before body validation                                                             | `packages/policy`, `app.ts`   | policy, outcomes                    |
| Forced RLS on every tenant table; fail closed without context                                       | 0001–0005                     | rls, acceptance 21                  |
| Least-privilege runtime logins; startup identity check                                              | 0005, `verifyRuntimeIdentity` | acceptance 22                       |
| Append-only evidence, commands, interactions, observations, effort, history, audit (incl. TRUNCATE) | 0004–0005 triggers            | rls, acceptance 27                  |
| Tamper-evident per-case hash chain (tenant, case, subject, actor bound)                             | `packages/db/src/evidence.ts` | acceptance 27, migrations           |
| Idempotent commands with request fingerprints                                                       | `commands.ts`                 | acceptance 2, 23                    |
| Ambiguous writes never re-sent; execution-id binding                                                | worker                        | dispatcher, acceptance 24–25        |
| Encrypted artifacts (AES-256-GCM, key-bound AAD), private managed bucket, no PHI in object names    | `storage.ts`                  | artifact, acceptance 28             |
| Scan before store/extract; scanner error fails closed                                               | `scanner.ts`, `service.ts`    | scanner, artifacts                  |
| Allow-list structured logging; static check of call sites                                           | `packages/observability`      | logging                             |
| Fail-closed startup configuration per profile                                                       | `packages/config`             | config, acceptance 29, CI image job |
| Generic 500 responses (no internal detail)                                                          | `app.ts`                      | artifacts                           |

## Assumptions

- Supabase Auth issues the workforce JWTs; MFA and password policy are
  configured in Supabase for the pilot organisation (not enforced by ACCESS).
- The API trusts one issuer/audience; tokens are short-lived (Supabase
  default one hour). Revocation takes effect on membership suspension at the
  next request, or on token expiry for identity-provider revocation.
- Transaction-local `app.tenant_id` is set only by the API/worker after
  authentication; RLS is defence in depth, not the primary authorisation.
- The application-layer artifact key (`ARTIFACT_ENCRYPTION_KEY`) lives in the
  secret store; Supabase Storage additionally encrypts at rest.
- Staff-entered fields and outcomes are human attestations and are labelled
  so; ACCESS does not verify them against the PMS unless a qualified
  connector reads them back.

## Residual risks and open items (before production)

- No real PMS connector is qualified; the pilot uses manual destination entry.
- No key-rotation procedure for `ARTIFACT_ENCRYPTION_KEY` is automated
  (the `encryption_key_id` column supports it; a re-encryption job is future).
- Retention: `retention_until` is recorded; the purge job is not implemented,
  so deletion is an operator procedure (runbooks).
- ClamAV signature freshness must be monitored; the sidecar image updates
  signatures on start and via freshclam.
- Penetration test, DAST, dependency/container scanning in the release
  pipeline, formal privacy/DPA approval and a timed restore exercise are
  outstanding organisational gates.
- Console uses Supabase's browser session storage (localStorage) for tokens;
  a stricter BFF/cookie model is future work.
- `/metrics` exposes technical counters without authentication (no PHI);
  restrict at ingress if required.
