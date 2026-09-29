# Operator runbooks

Query by case, execution and correlation IDs. Never copy extraction, notes,
documents or other patient content into tickets or chat.

## Stuck outbox / poison

Alert on oldest `PENDING` outbox age and on any `POISON`. Expired leases are
reclaimed automatically (fenced by `attempts`). A poison row already moved the
case to `EXCEPTION` with one `CONNECTOR` work item. Find the root cause
(`executions.last_error` is a code), fix it, then a coordinator uses
_Resolve work item → Retry automated destination_ (new execution ID; the
poisoned one was known not to have committed) or records the destination
reference manually.

## Ambiguous connector write

The case stays `DESTINATION_PENDING`; the execution is `AMBIGUOUS` then
`RECONCILING`, read back by the original `execution_id` with capped
exponential backoff (`RECONCILE_BASE_SECONDS`, max 300 s,
`RECONCILE_MAX_ATTEMPTS`). Inconclusive polls change only the execution row.
On exhaustion the execution stays `AMBIGUOUS` with `escalated_at`, the case
goes to `EXCEPTION` and one `CONNECTOR` work item opens. **Never reset it for
re-send.** Staff check the destination system:

- referral present → _Record destination entry_ with its reference (the
  execution is marked superseded, `manual_destination_reference`);
- referral absent → _Retry automated destination_ with the attestation box
  (execution superseded, `staff_attested_not_committed`, new execution ID).

## Outcome under review

`OUTCOME_REVIEW` items mean a fact conflicted with a terminal outcome or
arrived while the case was in `EXCEPTION`. A practice manager either
acknowledges (the recorded outcome stands) or uses _Correct outcome_ with the
observation (audited transition, evidence `case_outcome_corrected`).

## Safety hold

`SAFETY` items (urgent/clinical-looking input) go to the practice manager and
the client's clinical owner. After clinical review: _Resolve work item →
Safety review completed_, then either close/reject with a resolution code or
continue administrative processing with _Provide information_ (structured).

## Scanner or storage unavailable

Uploads fail with 503 (`SCANNER_UNAVAILABLE` / `ARTIFACT_STORE_UNAVAILABLE`);
nothing is persisted and callers retry with the same `command_id`. Check the
clamd sidecar (signatures loaded, port 3310) or Supabase Storage status.

## Orphaned artifact objects

Objects are deleted when a request fails after upload; if deletion itself
fails the API logs `artifact_cleanup_failed` with the opaque `object_key`.
Remove such objects after confirming no `artifacts` row references the key.

## Retention and deletion

`artifacts.retention_until` is set at upload (`ARTIFACT_RETENTION_DAYS`). Until
an automated purge exists: for resolved cases past retention, delete the
object from the bucket and set `deleted_at` (owner connection), recording the
action in the release/operations log. Evidence and metadata are retained.

## Migrations

`npm run db:migrate` (or the Azure migrate job) applies only unapplied files in
order, each in its own transaction with its ledger row, under an advisory
lock. A changed applied file (checksum mismatch), a duplicate number, an
out-of-order file or a missing applied file stops the run. Fix forward with a
new migration; never edit applied files.

## Database interruption and restore

Stop the worker, record the outbox watermark, restore PITR into an isolated
project, run migrations, compare evidence chain heads
(`/v1/cases/:id/evidence/verify`) and execution IDs, run the integration suite
against a copy, then resume. Record actual RPO/RTO in the release record.

## Credential rotation / rollback

Rotate in Key Vault and restart the revision. Roll back only to an image
compatible with the current schema; `0003` removed the legacy
`referrals.state/version` columns, so pre-v1.1 images cannot run against a
v1.1 schema — use a forward fix. Verify `/ready`, queue age and one synthetic
end-to-end referral before resuming dispatch.

## Onboarding staff

ADMIN: `POST /v1/admin/memberships {command_id, user_id, role, status}` for a
Supabase Auth user id. Suspend with `status: SUSPENDED` (effective on the next
request).
