# ADR 0003: connector semantics, workforce identity, storage and scanning

**Status:** Accepted · **Date:** 2026-09-25

## Connector execution

- **Capabilities** are a closed namespace (`patient.lookup … message.send`).
  A capability executes only if the connector declares it _and_ the
  deployment enables it (`CapabilityGate`). The mock declares
  `patient.lookup referral.create referral.status.read appointment.status.read`;
  `CONNECTOR_KIND=none` declares nothing. Unsupported operations return
  `UNSUPPORTED_OPERATION` and open a `MANUAL_DESTINATION` work item; nothing
  is emulated.
- **Case-type binding:** `OPERATIONS` maps each operation to the case types
  allowed to authorise it; the dispatcher refuses any other combination
  before foreign I/O.
- **Error taxonomy:** only `SafeRetryableConnectorError` (known not sent) or
  an explicit `RETRYABLE` result is retried, with a bounded attempt count and
  then `POISON` → case `EXCEPTION` → one `CONNECTOR` work item.
  `PermanentConnectorError`/`PERMANENT` → `EXCEPTION`. Any other thrown error,
  invalid response, timeout, or `AMBIGUOUS` result on a consequential write is
  **ambiguous**: execution `AMBIGUOUS`, then `RECONCILING` by read-back of the
  original `execution_id`, with capped backoff; exhaustion escalates to staff
  and stops polling. Ambiguous writes are never re-sent.
- **Result binding:** every result must carry the intended `execution_id`; a
  mismatch is treated as ambiguous and never mutates another execution/case.
- **Leases are fenced** by the attempt counter; an expired lease is reclaimed,
  but a consequential write is re-sent only if the destination de-duplicates
  `execution_id`, otherwise it goes to reconciliation.
- Retrying after an escalated ambiguous write requires a staff attestation
  that the destination has no record (the old execution is marked superseded).
- Technical-only polls change execution rows only: no case version churn and
  no business evidence.
- **Readback:** `getReferralStatus` / `getAppointmentOutcome` feed the same
  observation engine as staff and imports.

## Workforce identity

- API edge verifies Supabase Auth JWTs (JWKS preferred; HS256 legacy secret
  supported) for issuer, audience, expiry and a UUID `sub`.
- Tenant and role come from `organisation_memberships` (RLS: readable by the
  user or the tenant; writable only in an `ADMIN` request context). A tenant
  header can only select among the caller's active memberships.
- Roles: `ADMIN`, `PRACTICE_MANAGER`, `REFERRAL_COORDINATOR`, `READ_ONLY`;
  permissions are checked server-side before request bodies are parsed.
- Staff identity is recorded on commands, evidence (hash v2 binds actor),
  interactions, observations, effort, work-item resolution and the audit log.
- The synthetic header bridge exists only for `local`/`synthetic-staging`
  with `SYNTHETIC` data; configuration refuses it elsewhere.

## Storage and scanning

- `ArtifactStore` port: `LocalEncryptedArtifactStore` (development) and
  `SupabaseStorageArtifactStore` (private bucket, service-role key server-side,
  `x-upsert: false`, no public or signed URLs; startup refuses a public
  bucket). Both store AES-256-GCM ciphertext whose AAD is the object key;
  keys are `tenant/case/random.acv1` (no PHI).
- `ArtifactScanner` port: `ClamAvScanner` (clamd INSTREAM, sidecar) and an
  explicit `MockSyntheticScanner`. Scan runs in memory before storage;
  `REJECTED` content is never stored; `ERROR` fails the upload with 503.
  Extraction asserts `CLEAN`.
- Objects are written per attempt with random keys; any failure after the
  write deletes the object if no committed row references it.

## Consequences

The pilot can run with **no automated connector** (manual destination) while
a PMS connector is qualified against `docs/connector-qualification.md`. The
cost is an extra network hop for scanning and a Supabase Storage dependency
on the upload path.
