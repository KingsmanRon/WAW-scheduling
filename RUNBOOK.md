# Runbook

Operating ACCESS in production: how to look at it, what the alerts mean and
what to do when something goes wrong. Releases are in DEPLOYMENT.md, the
security model in SECURITY.md. Nothing here contains a credential; where a
command needs one it reads it from the service's Railway variables.

Railway project `access`, environments `staging` and `production`, services
`api` (public), `worker`, `migrate` (one-off job) and `clamav`; one Supabase
project per environment; the console on Vercel.

## Getting in

- **Railway CLI**: `npm i -g @railway/cli`, `railway login`, then
  `railway link` in a checkout of this repository. Commands take
  `-s <service> -e <environment>`.
- **Database (owner)**: the Supabase SQL editor, or `psql` without copying
  the credential anywhere:
  `railway run -s migrate -e production -- sh -c 'psql "$MIGRATION_DATABASE_URL"'`.
  Start every diagnostic session with
  `SET default_transaction_read_only = on;` and lift it only to apply a fix
  from this runbook. Never paste patient details into tickets or chat; the
  queries below return ids, statuses and counts.
- **Worker endpoints** are private:
  `railway ssh -s worker -e production -- node -e "fetch('http://localhost:'+process.env.PORT+'/ready').then(async r=>console.log(r.status,await r.text()))"`.

## Health

| Endpoint       | API                                                             | Worker (its `PORT`, private)                 |
| -------------- | --------------------------------------------------------------- | -------------------------------------------- |
| `GET /health`  | process up (liveness)                                           | its loop completed a cycle in the last 5 min |
| `GET /ready`   | database reachable **and** it has this build's newest migration | the same                                     |
| `GET /metrics` | Prometheus, `Authorization: Bearer $METRICS_TOKEN`              | the same                                     |

Railway switches traffic to a new deployment only once `/ready` answers, so
a release whose migration has not run never goes live: the API logs
`schema_behind` and answers `{"status":"not_ready","reason":"schema_behind"}`,
and the worker logs `worker_waiting_for_schema` and does no work. Railway
checks readiness only while deploying; afterwards the alerts below and an
**external uptime check** on `https://<api-domain>/ready` (any uptime
service, every minute; the one signal that also sees DNS, TLS and edge
problems) watch it.

## Logs

Every process writes one JSON object per line to stdout:
`railway logs -s api -e production -n 200 -f '@level:error'`,
`railway logs -s worker -e production -n 200 -f 'outbox_event_failed'`.
Fields: `timestamp`, `level`, `message`, `service`, `environment`, `build`,
and per event `request_id`, `correlation_id`, `tenant_id`, `practice_id`,
`actor_id`, `route` (the pattern, never the URL), `status_code`,
`duration_ms`, error `error_code` and `error_name`.

Never logged: request or response bodies, patient names, numbers, e-mail
addresses or identifiers, message text, tokens, keys, passwords or
webhook secrets (a static test scans every server source file for logging
calls that could, and the logger drops fields it does not know).

Tracing one booking across processes: the API returns `x-request-id`; the
console sends `x-correlation-id`, which is stored on the audit entry and the
outbox event and appears on the worker's log lines for that event and the
notifications it plans.

## Metrics and alerts

`infra/observability/prometheus.yml` scrapes both services over Railway's
private network; `infra/observability/alerts.yml` holds the rules below.

| Alert                                                      | Meaning                                    | Go to                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `AccessTargetDown`                                         | API or worker not answering                | [API unavailable](#api-unavailable), [Worker stopped](#worker-stopped)                                                   |
| `AccessApiServerErrors`, `AccessSchedulingServerErrors`    | requests failing with 5xx                  | logs `request_failed` by `route`; a recent deploy ([Rollback](#rollback)); [Database unavailable](#database-unavailable) |
| `AccessApiSlow`                                            | p95 latency above 1.5 s                    | database CPU and connections (Supabase dashboard); [Capacity](#capacity)                                                 |
| `AccessDatabaseErrors`                                     | unexpected PostgreSQL errors               | the `code` label; `23505`/`23P01` are conflicts answered 409, others need a look                                         |
| `AccessOutboxBacklog`, `AccessOutboxFailed`                | events waiting over 5 minutes, or given up | [Outbox backlog](#outbox-backlog)                                                                                        |
| `AccessNotificationsBacklog`, `AccessNotificationFailures` | messages not going out                     | [Notifications failing](#notifications-failing)                                                                          |
| `AccessWorkerJobErrors`                                    | a worker job keeps failing                 | logs `worker_job_failed` with `job`, `worker_tick_failed`                                                                |
| `AccessSlotConflictSpike`                                  | many `SLOT_UNAVAILABLE` answers            | [Slot-conflict spike](#slot-conflict-spike)                                                                              |
| `AccessWebhookSignatureRejections`                         | WhatsApp calls with bad signatures         | [WhatsApp webhook failing](#whatsapp-webhook-failing)                                                                    |
| `AccessClassifierFailing`                                  | the optional classifier failing            | nothing breaks (menus take over); provider status or key, or `INTENT_CLASSIFIER=off`                                     |

Useful series: `scheduling_commands_total{operation,outcome}` (commands and
refusals by code), `scheduling_command_seconds`, `slot_conflicts_total`,
`holds_expired_total`, `outbox_pending`, `outbox_oldest_pending_seconds`,
`notifications_pending`, `notifications_{sent,failed,skipped,retried}_total`,
`channel_messages_sent_total`, `waitlist_offers_total`,
`whatsapp_webhook_{messages,statuses,rejected}_total`, `worker_job_seconds{job}`.

## Diagnostic queries

Owner session, read-only (see "Getting in"). Replace `<tenant>` and ids.

```sql
SET default_transaction_read_only = on;

-- Schema: the latest applied migrations
SELECT version, applied_at, execution_ms FROM schema_migrations ORDER BY version DESC LIMIT 5;

-- Connections by service, and anything holding a transaction open
SELECT application_name, state, count(*) FROM pg_stat_activity
 WHERE application_name LIKE 'access-%' GROUP BY 1, 2 ORDER BY 1, 2;
SELECT pid, application_name, state, wait_event_type, now() - xact_start AS open_for
  FROM pg_stat_activity WHERE xact_start < now() - interval '30 seconds' ORDER BY xact_start;

-- Outbox: queue by status and by event type
SELECT status, count(*), min(available_at) AS oldest_due, max(attempts) AS max_attempts
  FROM platform.outbox_events WHERE status <> 'PROCESSED' GROUP BY status;
SELECT event_type, count(*), max(attempts), min(created_at)
  FROM platform.outbox_events WHERE status IN ('PENDING','PROCESSING') GROUP BY 1 ORDER BY 2 DESC;

-- Notifications of the last day: outcome and reason
SELECT channel, status, coalesce(skip_reason, last_error_code) AS why, count(*)
  FROM messaging.notification_deliveries WHERE created_at > now() - interval '1 day'
 GROUP BY 1, 2, 3 ORDER BY 4 DESC;

-- WhatsApp conversation replies waiting or failed; EMR webhooks
SELECT status, count(*), min(created_at) FROM messaging.channel_messages
 WHERE direction = 'OUTBOUND' AND status IN ('PENDING','SENDING','FAILED') GROUP BY 1;
SELECT status, last_error_code, count(*) FROM integration.events
 WHERE direction = 'OUTBOUND' AND status IN ('PENDING','PROCESSING','FAILED') GROUP BY 1, 2;

-- Holds past their expiry (a healthy worker keeps this at 0)
SELECT count(*) FROM scheduling.slot_holds
 WHERE status = 'ACTIVE' AND expires_at < now() - interval '1 minute';

-- Slot conflicts answered to console/API clients, per minute and command
SELECT date_trunc('minute', created_at) AS minute, operation, count(*)
  FROM platform.idempotency_keys
 WHERE response_status = 409 AND response_body->>'error' = 'SLOT_UNAVAILABLE'
   AND created_at > now() - interval '1 hour'
 GROUP BY 1, 2 ORDER BY 1 DESC;

-- Appointments made in the last hour, by channel
SELECT source_channel, status, count(*) FROM scheduling.appointments
 WHERE created_at > now() - interval '1 hour' GROUP BY 1, 2;

-- The double-booking invariant: must return no rows
SELECT a.id, b.id FROM scheduling.appointments a
  JOIN scheduling.appointments b ON b.tenant_id = a.tenant_id
   AND b.practitioner_id = a.practitioner_id AND b.id > a.id AND b.occupied && a.occupied
 WHERE a.status IN ('HELD','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED')
   AND b.status IN ('HELD','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED');

-- Who did what to one record
SELECT occurred_at, actor_type, actor_id, actor_role, channel, action FROM platform.audit_events
 WHERE tenant_id = '<tenant>' AND resource_type = 'appointment' AND resource_id = '<id>'
 ORDER BY id;
```

## Incidents

### API unavailable

Signals: `AccessTargetDown`, the uptime check, the console showing "The
practice API could not be reached", Meta reporting webhook failures.
Impact: reception cannot see or change the schedule; WhatsApp messages wait
for Meta's retries; notifications already queued still go out (the worker
runs on its own).

1. `curl -sS -o /dev/null -w '%{http_code}\n' https://<api-domain>/health`,
   then `/ready`.
2. `/health` fails: `railway deployment list -s api -e production` and
   `railway logs -s api -e production -n 200`.
   - Exit code 78 at start: configuration refused; the line names the
     variables (never values). Fix with
     `railway variable set NAME=value -s api -e production` (it redeploys).
   - Crashing since a deploy: [Rollback](#rollback).
3. `/health` answers but `/ready` is 503: `reason: schema_behind` means the
   release's migration has not run ([Migration failure](#migration-failure));
   otherwise [Database unavailable](#database-unavailable).
4. Both answer but the console fails: the browser console shows a CORS or
   CSP error. The console's origin must be in the API's `CONSOLE_ORIGIN`,
   and the console must be built with this API's URL (its CSP allows only
   the API and Supabase it was built for).
5. Meanwhile reception keeps a paper list and enters it when the API
   returns; a clash is refused then (`SLOT_UNAVAILABLE`), never double
   booked.

### Database unavailable

Signals: `/ready` 503 on both services; API `request_failed` with
`error_code` such as `ECONNREFUSED`, `ETIMEDOUT`, `57P01` or `53300`;
worker `worker_tick_failed`; `database_connection_lost` warnings.
Impact: nothing can be read or changed. Every change is one transaction, so
nothing is half-written, and nothing acknowledged is lost.

1. Supabase dashboard (project paused, restarting, disk full, CPU) and
   status.supabase.com.
2. `53300` (too many connections): [Capacity](#capacity); the connections
   query above shows which service holds them.
3. `28P01` (password authentication failed) after a password change: set
   the new URL on the service (`API_DATABASE_URL` / `WORKER_DATABASE_URL`).
4. Recovery needs no action: pools replace lost connections on the next
   query and the worker resumes where it stopped. Then check that the
   outbox drains ([Outbox backlog](#outbox-backlog)). Holds that lapsed in
   between are expired by the next booking or the 15-second sweep; missed
   reminders are reconciled (sent if still useful, else skipped as too
   late).

### Worker stopped

Signals: `AccessTargetDown{job="access-worker"}`, `AccessOutboxBacklog`,
`notifications_pending` rising, WhatsApp patients not getting replies (the
access layer runs in the worker).
Impact: nothing is lost; bookings are not blocked (a booking expires any
lapsed hold in its way); messages, WhatsApp replies, waitlist offers and
webhooks wait.

1. `railway logs -s worker -e production -n 200`; the private `/health` and
   `/ready` (see "Getting in").
2. `/health` 503 (`stalled`): a cycle hangs; `railway restart -s worker -e production -y`.
   Leases held by the stuck cycle expire and the work is picked up again.
3. `/ready` 503: the database, or `worker_waiting_for_schema` (run the
   migration: [Migration failure](#migration-failure)).
4. Exits with 78: configuration (the line names the variables).
5. After it returns, watch `outbox_oldest_pending_seconds` fall. Events are
   handled in order per record. WhatsApp replies can only be sent inside
   WhatsApp's 24-hour window: after a very long outage some fail with
   `OUTSIDE_SERVICE_WINDOW` (WhatsApp query above), and reception contacts
   those patients.

### WhatsApp webhook failing

1. Meta app → WhatsApp → Configuration: callback URL
   `https://<api-domain>/v1/channels/whatsapp/webhook`, verify token, the
   `messages` subscription, and Meta's delivery errors.
2. `whatsapp_webhook_rejected_total{reason="signature"}` (401s):
   `WHATSAPP_APP_SECRET` on the API differs from the Meta app's secret (it
   was reset), or someone is probing; nothing unsigned is processed.
   `reason="json"`: malformed bodies. Verification failing (403 on `GET`):
   `WHATSAPP_VERIFY_TOKEN` differs from the one entered in Meta.
3. Messages arrive (`whatsapp_webhook_messages_total` rises) but nobody
   answers: logs `whatsapp_unrouted` / `whatsapp_webhook_partial` (the
   number's `phone_number_id` is not connected to a practice:
   `npm run channel:whatsapp:connect`, DEPLOYMENT.md) or the worker
   ([Worker stopped](#worker-stopped)).
4. Replies fail: worker logs `channel_message_send_error` with the Graph
   code: `WHATSAPP_190` or HTTP 401 means the access token expired or was
   revoked; issue a new system-user token and
   `printf %s "$TOKEN" | railway variable set WHATSAPP_<NAME>_TOKEN --stdin -s worker -e production`.
5. Meta retries deliveries that failed; when the API is back they are
   processed once (duplicates are dropped by message id).

### Outbox backlog

`AccessOutboxBacklog` (oldest pending event older than 5 minutes) or
`AccessOutboxFailed`.

1. Is the worker running and past the schema gate? ([Worker stopped](#worker-stopped))
2. The outbox queries above: one `event_type` dominating with rising
   `attempts` is a handler failing; the worker logs `outbox_event_retry`
   (with `event_type` and `code`) and, after `OUTBOX_MAX_ATTEMPTS` (10),
   `outbox_event_failed`.
3. Fix the cause (configuration, provider, data), then requeue the failed
   events you want retried; handlers are idempotent per event:

   ```sql
   SET default_transaction_read_only = off;
   UPDATE platform.outbox_events
      SET status = 'PENDING', attempts = 0, available_at = now(),
          lease_until = NULL, last_error_code = NULL
    WHERE tenant_id = '<tenant>' AND status = 'FAILED' AND id IN (…);
   ```

   Processed events cannot be reopened (a trigger refuses it).

### Notifications failing

Console → **Notifications** (or an appointment's "Messages to the patient")
shows each planned message and, when not sent, why: no consent on that
channel, no usable number, channel not set up, reminders off, appointment
changed, too late to be useful, record archived, test recipient not allowed
(synthetic environments), already confirmed in the WhatsApp conversation.

1. The notifications query above: `FAILED` with the provider code.
   - `WHATSAPP_190`, HTTP 401/403: token (see WhatsApp step 4).
   - `WHATSAPP_132001` and other `1320xx`: template missing, not approved
     or its parameters differ (DEPLOYMENT.md, template table).
   - `WHATSAPP_130429`, `131056`: throttled; retried automatically.
   - E-mail: `SMTP_URL` credentials or the provider.
2. Deliveries retry by kind of failure (transient, ambiguous, configuration)
   up to their attempt limit; a `FAILED` delivery is final and is not sent
   later (a late message about a changed appointment would mislead).
   Reception phones the patients listed as failed for anything that
   matters.
3. Record consent in the patient's **Messages and consent** panel only
   after asking the patient.

### Migration failure

The `migrate` job exits non-zero with
`migration NNNN_name failed and was rolled back: …`. Each migration runs in
one transaction with its ledger row: nothing of it was applied, the ledger
is unchanged and the running release is unaffected (the new release stays
not-ready: `schema_behind`).

| Message                                                             | Cause and action                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `… canceling statement due to lock timeout`                         | a long transaction held a lock past 15 s; find it (open-transactions query), let it finish, deploy `migrate` again |
| `… was modified after it was applied (checksum mismatch)`           | an applied migration file was edited; restore it from git and put the change in a new migration                    |
| `applied migration … is missing from the migrations directory`      | `migrate` was deployed from an older commit than the database; deploy the release's commit                         |
| `… is older than an applied migration; refusing out-of-order apply` | a new migration was numbered below an applied one; renumber it                                                     |
| a constraint or type error                                          | existing data violates the change; fix it with a new expand step (e.g. `NOT VALID`, backfill, then `VALIDATE`)     |

Before releasing a migration: CI validates every migration on a clean
database (applied twice, schema security checked), and staging applies it
to existing data first (DEPLOYMENT.md). Never "fix" a failure by editing the
ledger.

### Slot-conflict spike

`AccessSlotConflictSpike`: many `SLOT_UNAVAILABLE` answers.
`slot_conflicts_total` by `operation`, and the per-minute query above.

- Many people chasing few times (a freed slot, a popular day) is normal:
  every refusal is correct and the database still admits one booking per
  time (the double-booking query above returns nothing).
- One `operation` or one `actor_id` (API logs) dominating: a client
  retrying with fresh idempotency keys, or a screen showing stale times.
  The console refreshes on Realtime signals and every 20 s; if Realtime is
  down it relies on the polling. A misbehaving staff session can be stopped
  by suspending the membership (Credential compromise, step 1).

### Provider outage

| Provider                  | Effect                                                                                 | Action                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Meta WhatsApp Cloud API   | replies and notifications retried with backoff, then `FAILED`; inbound delayed by Meta | none needed; after a long outage review failed notifications and **Needs reception** |
| SMTP                      | e-mail notifications retried, then `FAILED`                                            | as above                                                                             |
| EMR webhook receiver      | `integration.events` retried (up to 8 attempts), then `FAILED`                         | fix with the receiver; failed events are visible in the EMR webhook query            |
| Supabase Auth             | staff cannot sign in; signed-in staff continue until their token expires (≤ 1 hour)    | none; WhatsApp is unaffected                                                         |
| Supabase Storage          | referral document upload and download answer 503; scheduling unaffected                | none                                                                                 |
| Supabase Realtime         | consoles refresh by 20-second polling instead of instantly                             | none                                                                                 |
| ClamAV (`clamav` service) | document uploads refused (never stored unscanned)                                      | `railway restart -s clamav -e production -y`; signatures update themselves           |
| Anthropic (classifier)    | free text falls back to the menus                                                      | optional: `INTENT_CLASSIFIER=off` on the worker                                      |
| Vercel                    | console unavailable; API and WhatsApp keep working                                     | Vercel status; the last deployment keeps serving once it recovers                    |
| Railway                   | API and worker unavailable                                                             | Railway status; nothing to repair afterwards (see Database unavailable, step 4)      |

### Credential compromise

First contain, then rotate, then investigate (Security incidents below).

| Credential                                                   | Where to rotate                                                                                                                                                    | Then                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| A staff account                                              | `PUT /v1/practices/:practiceId/memberships/:userId` with `"status":"SUSPENDED"` (effective on the next request); Supabase Auth → reset password or delete the user | audit trail for that `actor_id`                                                                                                       |
| `API_DATABASE_URL` / `WORKER_DATABASE_URL`                   | as owner: `ALTER ROLE access_request PASSWORD '<new>';` (or `access_worker`)                                                                                       | set the new URL on the service; it redeploys                                                                                          |
| `MIGRATION_DATABASE_URL` (owner)                             | Supabase → Project Settings → Database → reset the database password                                                                                               | set it on `migrate`; treat as a full data exposure                                                                                    |
| `SUPABASE_SERVICE_ROLE_KEY`                                  | Supabase → Project Settings → API keys: roll it (a legacy `service_role` key rolls with the JWT secret, which also replaces the anon key and signs everyone out)   | set it on `api` (and a new anon key on Vercel, then redeploy the console); it has no table privileges (0014), documents are encrypted |
| `WHATSAPP_APP_SECRET`                                        | Meta app → Settings → Basic → reset the app secret                                                                                                                 | set it on `api` **at once**: with it, messages could be forged as any patient number                                                  |
| `WHATSAPP_<NAME>_TOKEN`                                      | Business Manager → System users → revoke and generate                                                                                                              | set it on `worker` (stdin, as above)                                                                                                  |
| `WHATSAPP_VERIFY_TOKEN`, `METRICS_TOKEN`                     | choose new values                                                                                                                                                  | set on the services (and in Meta / the Prometheus config)                                                                             |
| `EMR_WEBHOOK_<NAME>_SECRET`, `SMTP_URL`, `ANTHROPIC_API_KEY` | with the receiver / provider                                                                                                                                       | set on `worker`                                                                                                                       |
| `ARTIFACT_ENCRYPTION_KEY`, `IDENTIFIER_HASH_KEY`             | cannot simply be replaced                                                                                                                                          | see Key rotation; assess exposure of the encrypted documents / hashes                                                                 |
| Railway, Vercel, Supabase, GitHub or Meta accounts           | the platform's session and token revocation                                                                                                                        | rotate every secret that platform could read                                                                                          |

### Rollback

- **API and worker**: Railway → service → Deployments → the last good
  deployment → Rollback (or, from a checkout of that commit,
  `railway up -s api -e production -d`, then the worker). Migrations are
  additive, so the previous release runs on the newer schema and its
  schema gate is already satisfied.
- **Console**: `vercel rollback <deployment-url> --yes` (or Instant
  Rollback in the Vercel dashboard).
- **Database**: never rolled back by hand. A bad migration is corrected by a
  new forward migration; data loss or corruption is a
  [Restore](#restore).
- **A variable change**: set the previous value again (the service
  redeploys).
- Afterwards: `/ready` on both services and the smoke steps of the staging
  acceptance sequence (DEPLOYMENT.md) against production, without
  patient-facing actions.

### Restore

Supabase point-in-time recovery (Dashboard → Database → Backups) restores
the whole database to a moment: use it for data loss or corruption, not for
a single mistake. Single mistakes are corrected in the product (cancel,
rebook, edit), which keeps the audit trail. Rehearse on staging first.

1. Stop the worker so nothing is sent from a state about to change:
   Railway → worker → the active deployment → Remove (or
   `railway down -s worker -e production -y`).
2. Restore to the chosen moment in Supabase.
3. Deploy `migrate` (migrations applied after that moment are re-applied);
   the API and worker stay not-ready until it has run.
4. Check that the runtime logins still work (their passwords are restored
   too: if they were changed after that moment, set them again).
5. Start the worker again: Railway → worker → Deployments → Redeploy the
   release's deployment (or `railway up -s worker -e production -d` from
   the release's commit).
6. Reconcile: appointments made after the restore point are gone, but their
   patients may have been messaged. Worker logs and Meta's message history
   for that window show whom; reception contacts them. Documents uploaded
   after that moment remain in Storage unreferenced (encrypted; delete them
   with the retention procedure).
7. Record the restore and its window in the incident log.

## Everyday questions

### A patient did not get a message

See [Notifications failing](#notifications-failing), step 1 and the
console's reasons.

### A double booking is reported

It cannot be stored: `appointments_no_practitioner_overlap` refuses any
second occupying appointment for the practitioner (the invariant query
above proves it for all data). Check whether the two appointments are for
different practitioners or locations, or whether one is
`CANCELLED`/`RESCHEDULED`/`EXPIRED`. The appointment's **History** and the
**Audit** view show who booked each and through which channel.

## Capacity

Runtime logins have connection limits (`supabase/provisioning/runtime-roles.sql`:
API 20, worker 10); each API replica's pool holds up to 10. Before adding API
replicas beyond two, raise the limit:
`ALTER ROLE access_request CONNECTION LIMIT 40;` and check the Supabase
plan's connection ceiling (the pooler multiplexes).

## Retention (automatic, worker `retention` job, hourly)

| Data                                       | Kept                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| WhatsApp message bodies                    | `CHANNEL_MESSAGE_RETENTION_DAYS` (90), then redacted; the conversation's status and times stay                                                   |
| Notification content (rendered parameters) | `NOTIFICATION_CONTENT_RETENTION_DAYS` (90)                                                                                                       |
| EMR webhook payloads                       | `INTEGRATION_PAYLOAD_RETENTION_DAYS` (30)                                                                                                        |
| Idempotency keys, webhook receipts         | purged after expiry (hours to days)                                                                                                              |
| Appointments, patients, audit              | not purged (practice records; audit is append-only)                                                                                              |
| Referral documents                         | `retention_until` recorded at upload (`ARTIFACT_RETENTION_DAYS`, default 2555 days ≈ 7 years); deletion at that date is an operator task (below) |

Deleting documents past retention (owner credential): list them with
`SELECT id, object_key FROM scheduling.referral_documents WHERE retention_until < now()`,
delete the objects from the bucket (Supabase Storage API or dashboard) and
then the rows, and record the action in the practice's records register.

## Patient requests (POPIA)

- **Access**: the patient's record page shows details, contacts,
  identifiers (as hints), consent, appointments, waitlist and referrals;
  the audit view filtered to the patient shows who changed what.
- **Correction**: edit in the console; the change is audited.
- **Objection to messages**: turn consent off in **Messages and consent**,
  or the patient sends STOP on WhatsApp (honoured for every patient on
  that number).
- **Deletion**: appointments and audit are practice records that the
  practice must keep; archive the patient (no further bookings or
  messages). Message bodies are redacted by retention; request earlier
  redaction by lowering `CHANNEL_MESSAGE_RETENTION_DAYS` or an owner
  `UPDATE` of that patient's messages.

## Security incidents

1. Contain: suspend the affected memberships and revoke credentials
   ([Credential compromise](#credential-compromise)).
2. Preserve evidence: export the audit trail for the window before anything
   else changes:
   `SELECT occurred_at, actor_type, actor_id, actor_role, action, resource_type, resource_id, channel, request_id FROM platform.audit_events WHERE tenant_id = '<tenant>' AND occurred_at > '<start>' ORDER BY id;`
   plus Railway logs for the same window and the Supabase Auth logs.
3. Assess which personal information was accessed, for which practices.
4. POPIA section 22: the practice (responsible party) notifies the
   Information Regulator and affected patients as soon as reasonably
   possible when personal information was accessed by an unauthorised
   person; ACCESS operators notify the practice without delay.

### Key rotation

`ARTIFACT_ENCRYPTION_KEY` encrypts stored documents and derives the signing
key of document links; `IDENTIFIER_HASH_KEY` keys the hashes used to find
patients by national id. Neither can simply be replaced: the old documents
and hashes would become unreadable/unmatchable. Rotate by a planned
re-encryption (read each document with the old key, write with the new)
and re-hash (from identifiers re-captured at the desk), during a maintenance
window, with both keys available to the job.
