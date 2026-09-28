# Runbook

Operating ACCESS in production: health, logs, metrics and alerts, and what
to do when something goes wrong. Deployment itself is in DEPLOYMENT.md.

## Health

| Endpoint       | API                                                | Worker (its `PORT`)                      |
| -------------- | -------------------------------------------------- | ---------------------------------------- |
| `GET /health`  | process up (liveness)                              | loop completed a cycle in the last 5 min |
| `GET /ready`   | database reachable                                 | database reachable                       |
| `GET /metrics` | Prometheus, `Authorization: Bearer $METRICS_TOKEN` | same                                     |

Railway gates each deploy on `/ready`. A worker whose `/health` fails is
stuck (a provider call hanging past its timeout, or the database gone):
restart it; leases held by the stuck cycle expire and another cycle takes
the work.

## Logs

Every process writes one JSON object per line to stdout (Railway → service
→ Logs). Fields: `timestamp`, `level`, `message`, `service`, `environment`,
`build`, and per event `request_id`, `correlation_id`, `tenant_id`,
`practice_id`, `actor_id`, `route` (the pattern, never the URL),
`status_code`, `duration_ms`, error `code` and `error_name`.

Never logged: request or response bodies, patient names, numbers, e-mail
addresses or identifiers, message text, tokens, keys, passwords or
webhook secrets (a static test scans every server source file for logging
calls that could).

Tracing one booking across processes: the API returns `x-request-id`; the
console sends `x-correlation-id`, which is stored on the audit entry and the
outbox event and appears on the worker's log lines for that event and the
notifications it plans.

## Metrics and alerts

`infra/observability/prometheus.yml` scrapes both services over Railway's
private network; `infra/observability/alerts.yml` holds the rules below.

| Alert                                                      | Meaning                                    | First checks and actions                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccessTargetDown`                                         | API or worker not answering                | Railway deploy status and logs; restart; check the database (`/ready`)                                                                        |
| `AccessApiServerErrors`, `AccessSchedulingServerErrors`    | requests failing with 5xx                  | logs `level=error message=request_failed` by `route`; recent deploy (roll back); database health                                              |
| `AccessApiSlow`                                            | p95 latency above 1.5 s                    | database CPU and connections (Supabase dashboard); pool exhaustion (see Capacity)                                                             |
| `AccessDatabaseErrors`                                     | unexpected PostgreSQL errors               | the `code` label; `23505`/`23P01` are conflicts and are answered 409, others need a look                                                      |
| `AccessOutboxBacklog`                                      | oldest pending event older than 5 minutes  | worker running? `worker_job_errors_total{job="outbox"}`; a handler failing repeatedly (logs `outbox_event_retry`, then `outbox_event_failed`) |
| `AccessOutboxFailed`                                       | events gave up after `OUTBOX_MAX_ATTEMPTS` | see "Failed outbox events"                                                                                                                    |
| `AccessNotificationsBacklog`, `AccessNotificationFailures` | messages not going out                     | provider status; token expiry (Graph 401/190); template not approved; see "A patient did not get a message"                                   |
| `AccessWorkerJobErrors`                                    | a worker job keeps failing                 | logs `worker_job_failed` with `job`                                                                                                           |
| `AccessSlotConflictSpike`                                  | many `SLOT_UNAVAILABLE` answers            | usually heavy contention (fine); if one channel dominates, it may be showing stale times                                                      |
| `AccessWebhookSignatureRejections`                         | WhatsApp calls with bad signatures         | `WHATSAPP_APP_SECRET` changed in Meta but not in Railway, or probing; nothing is processed                                                    |
| `AccessClassifierFailing`                                  | the optional classifier failing            | nothing breaks (menus take over); provider status or key; or set `INTENT_CLASSIFIER=off`                                                      |

Useful series: `scheduling_commands_total{operation,outcome}` (bookings and
refusals by code), `scheduling_command_seconds`, `slot_conflicts_total`,
`holds_expired_total`, `outbox_pending`, `outbox_oldest_pending_seconds`,
`notifications_pending`, `notifications_{sent,failed,skipped,retried}_total`,
`channel_messages_sent_total`, `waitlist_offers_total`,
`whatsapp_webhook_{statuses,rejected}_total`, `worker_job_seconds{job}`.

## Common situations

### A patient did not get a message

Console → **Notifications** (or the appointment's "Messages to the patient"):
each planned message shows its status and, when not sent, why:
no consent on that channel, no usable number, channel not set up, reminders
turned off, appointment changed, too late to be useful, record archived,
test recipient not allowed (synthetic environments), already confirmed in
the WhatsApp conversation. `FAILED` shows the provider's error code. Record
consent in the patient's **Messages and consent** panel only after asking
the patient.

### Failed outbox events

```sql
-- as the owner (Supabase SQL editor or psql with MIGRATION_DATABASE_URL)
SELECT id, event_type, aggregate_id, attempts, last_error_code, created_at
  FROM platform.outbox_events WHERE status = 'FAILED' ORDER BY id;
```

Fix the cause first (a configuration value, a provider outage). Then
requeue the events you want retried; handlers are idempotent per event:

```sql
UPDATE platform.outbox_events
   SET status = 'PENDING', attempts = 0, available_at = now(),
       lease_until = NULL, last_error_code = NULL
 WHERE status = 'FAILED' AND id IN (…);
```

### The worker was down

Nothing is lost: events wait in the outbox and are handled in order when it
returns. Bookings are not blocked in the meantime (a booking expires any
lapsed hold in its way). Reminders whose moment passed while it was down are
reconciled: those still useful are sent, the rest are skipped as too late.

### WhatsApp stopped answering

1. API: `whatsapp_webhook_rejected_total{reason}` (signature, json) and
   logs `whatsapp_unrouted` (a number not connected to a practice); worker:
   logs `channel_message_send_error` and `notification_send_error` with the
   Graph error code.
2. Graph `190`/`401`: the access token expired or was revoked. Issue a new
   system-user token, set it on the worker (`WHATSAPP_<NAME>_TOKEN`),
   redeploy the worker.
3. Webhook not arriving at all: Meta app → WhatsApp → Configuration:
   callback URL, verify token, `messages` subscription.
4. Patients are never left without a way forward: conversations the
   assistant cannot handle go to **Conversations → Needs reception**.

### A double booking is reported

It cannot be stored: `appointments_no_practitioner_overlap` refuses any
second occupying appointment for the practitioner. Check whether the two
appointments are for different practitioners or locations, or whether one
is `CANCELLED`/`RESCHEDULED`/`EXPIRED`. The appointment's **History** and
the **Audit** view show who booked each and through which channel.

### Restoring data

Supabase point-in-time recovery restores the whole database to a moment:
use it for data loss or corruption, not for single mistakes. Single
mistakes are corrected through the product (cancel, rebook, edit), which
keeps the audit trail. After a restore, redeploy the worker so it re-reads
queue state; documents in Storage are not rolled back (orphaned objects are
harmless: they are encrypted and unreferenced).

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

1. Contain: revoke the affected staff user in Supabase Auth (sessions end
   at token expiry, at most one hour; practice membership can be set
   `SUSPENDED` immediately with `PUT …/memberships/:userId`).
2. Rotate any exposed secret (Railway variable + redeploy). An exposed
   `SUPABASE_SERVICE_ROLE_KEY`: roll it in Supabase, then set it on the API.
3. Investigate with the audit trail:
   `SELECT occurred_at, actor_id, actor_role, action, resource_type, resource_id, channel
FROM platform.audit_events WHERE tenant_id = … AND occurred_at > … ORDER BY id;`
4. POPIA section 22: notify the Information Regulator and affected patients
   as soon as reasonably possible when personal information was accessed
   by an unauthorised person.

### Key rotation

`ARTIFACT_ENCRYPTION_KEY` encrypts stored documents and derives the signing
key of document links; `IDENTIFIER_HASH_KEY` keys the hashes used to find
patients by national id. Neither can simply be replaced: the old documents
and hashes would become unreadable/unmatchable. Rotate by a planned
re-encryption (read each document with the old key, write with the new)
and re-hash (from identifiers re-captured at the desk), during a maintenance
window, with both keys available to the job.
