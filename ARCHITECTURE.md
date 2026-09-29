# Architecture

ACCESS is a multi-channel appointment and scheduling platform for medical
practices. Reception books over the phone and at the desk, patients book on
WhatsApp, referrals and waitlists feed the schedule, and every one of those
paths goes through one **Scheduling Core** that owns availability, holds,
bookings and the appointment lifecycle. No channel writes appointments any
other way.

```text
 Browser (Vercel)          WhatsApp (Meta Cloud API)        EMR / clinic systems
 practice console          patient's phone                  (signed webhooks out)
       │ HTTPS + JWT              │ signed webhook                  ▲
       ▼                          ▼                                 │
 ┌──────────────────────── Railway ──────────────────────────────────────────┐
 │  API (Fastify, apps/core-api)                 Worker (apps/worker)        │
 │  auth → practice role → validation →          outbox router, WhatsApp     │
 │  one transaction: Scheduling Core command     access layer, notifications,│
 │  + audit + outbox event                       waitlist offers, webhooks,  │
 │                                               hold expiry, reminders,     │
 │                                               retention, health/metrics   │
 └───────────────┬─────────────────────────────────────────┬─────────────────┘
                 │ access_request login (RLS)               │ access_worker login (RLS)
                 ▼                                          ▼
 ┌──────────────────────────── Supabase ─────────────────────────────────────┐
 │  PostgreSQL: scheduling · directory · messaging · integration · platform  │
 │  (exclusion constraints, RLS, append-only audit, transactional outbox)    │
 │  Auth (staff sign-in, JWT)   Storage (private, encrypted documents)       │
 │  Realtime: scheduling.schedule_signals → console refresh                  │
 └───────────────────────────────────────────────────────────────────────────┘
```

## Modular monolith

One repository, one image, three processes (API, worker, migration job) and
a static console. Packages have one-way dependencies:

| Package                    | Responsibility                                                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`       | Versioned request/response schemas (zod), enums: channels, roles, statuses, event and notification types                                                                                                                                                  |
| `packages/scheduling`      | **Scheduling Core.** Pure domain (`domain/`: availability engine, state machine, booking rules, time in IANA zones) and the transactional commands (`core/`: holds, bookings, lifecycle, reschedule, cancel, configuration, waitlist, referrals, queries) |
| `packages/patients`        | Patient registry: normalised identifiers (E.164 mobiles, lower-cased e-mails, keyed hashes of national ids), search, duplicate review (never merged automatically)                                                                                        |
| `packages/notifications`   | What to tell patients and when: planner (consent, contact, allow-list), dispatcher (leases, bounded retries), catalogue of message templates                                                                                                              |
| `packages/integrations`    | Providers: WhatsApp Cloud API, SMTP, signed EMR webhooks; secret references; outbound target checks                                                                                                                                                       |
| `packages/access`          | WhatsApp access layer: deterministic interpreter and conversation state machine over Scheduling Core commands; optional intent classifier                                                                                                                 |
| `packages/policy`          | Practice roles → permissions; organisation roles for the referral workspace                                                                                                                                                                               |
| `packages/db`              | Pools, tenant/practice transactions (RLS context), idempotency, audit, outbox, ledger migrations, bootstrap                                                                                                                                               |
| `packages/config`          | Fail-closed configuration per deployment profile                                                                                                                                                                                                          |
| `packages/observability`   | Structured JSON logs, Prometheus metrics                                                                                                                                                                                                                  |
| `packages/domain`, `rules` | The organisation referral pipeline (below)                                                                                                                                                                                                                |
| `apps/core-api`            | HTTP API: practice routes, WhatsApp webhook, referral documents, organisation referral intake                                                                                                                                                             |
| `apps/worker`              | Background work and operator commands (`src/cli`)                                                                                                                                                                                                         |
| `apps/console`             | React practice console (and the organisation referral workspace)                                                                                                                                                                                          |

## The Scheduling Core

Every mutation is a Core command run inside one database transaction that
also writes its audit entry and outbox event(s):

```text
request → authenticate (Supabase JWT) → resolve practice membership and role
→ permission check → schema validation → Idempotency-Key check
→ BEGIN; set tenant/practice/actor context (RLS)
     lock rows in a fixed order → re-read state → apply rules
     → write appointment + appointment_event + audit_event + outbox_event
  COMMIT → store the response under the Idempotency-Key
```

**Availability is computed, never stored.** Working hours
(`availability_rules`, weekly, per practitioner and location, with validity
dates), exceptions (leave, extra sessions), practitioner blocks, appointment
types (duration, buffers, slot interval, notice, advance window) and existing
appointments and holds produce the offered slots, in the location's IANA
time zone (DST-safe; `packages/scheduling/src/domain/time.ts`). Every channel
asks the same function; a slot shown is re-checked when booked.

**Double booking is impossible at the database level.** `scheduling.appointments`
carries an exclusion constraint on `(tenant, practitioner, occupied range)` for
every status that occupies time (`HELD` included). Two transactions racing
for one slot cannot both commit; the loser is answered `409 SLOT_UNAVAILABLE`.
The concurrency suite fires 25 simultaneous bookings at one slot and requires
exactly 1 success and 24 `SLOT_UNAVAILABLE`.

**Holds.** Choosing a time creates a `HELD` appointment and a
`scheduling.slot_holds` row that expires after the practice's hold time
(default 300 s, 60-1800). Confirming converts it in place; the worker expires
lapsed holds through the Core. Purposes: `BOOKING`, `RESCHEDULE`,
`WAITLIST_OFFER`.

**Appointment state machine** (`packages/scheduling/src/domain/state-machine.ts`),
enforced in the Core and by a database trigger:

```text
HELD ──► CONFIRMED ──► CHECKED_IN ──► IN_PROGRESS ──► COMPLETED
  │          │  │  └──► NO_SHOW ──► CHECKED_IN (arrived late, same day)
  │          │  └──► RESCHEDULED (a new appointment takes its place)
  ├──► EXPIRED   └──► CANCELLED ◄── CHECKED_IN
  └──► CANCELLED (hold released)
```

Check-in is allowed on the appointment's local day only; no-show only after
its start; patients cannot change an appointment inside the practice's
change cut-off (default 120 minutes). Every transition is appended to
`scheduling.appointment_events` with actor, role and channel.

**Lock order** (every command): practitioners (by id) → referral → waitlist
entry → waitlist offers → slot holds → appointments. Consistent ordering
keeps concurrent commands deadlock-free.

**Idempotency.** Every `POST`/`PATCH`/`PUT` needs an `Idempotency-Key`. The
key is bound to the request's material content: a retry replays the stored
response (`Idempotent-Replayed: true`); the same key with different content
is refused (`422`). Keys expire and are purged by the worker.

**Optimistic versions.** Changes that edit an existing record take
`expected_version`; a stale version is `409 VERSION_CONFLICT`.

### The booking transaction

A direct booking (reception on the phone or at the desk,
`POST /v1/practices/:practiceId/appointments`):

1. Verify the JWT; resolve the caller's membership and role for the
   practice in the URL; require `appointment.book`; validate the body
   (strict schema; `source_channel` one of the seven channels).
2. `BEGIN`; bind tenant, practice, user and role for RLS; claim the
   `Idempotency-Key` (a retry replays the stored answer, the same key with
   other content is refused).
3. Lock the practitioner row. Concurrent commands for that practitioner,
   from any channel or process, queue here.
4. Re-read committed state under the lock: practice settings, the
   appointment type (duration, buffers, notice, advance window, who may
   book it, referral rules), the location, the patient, the referral
   (locked: verified, valid, visits left, same patient and type) and the
   waitlist entry when booking from the waitlist.
5. Expire the practitioner's lapsed holds (a lapsed hold never blocks a
   booking).
6. Check the time against availability computed from rules, exceptions,
   blocks, appointments and holds in the location's time zone
   (`SLOT_UNAVAILABLE`, `OUTSIDE_AVAILABILITY`, `OUTSIDE_BOOKING_WINDOW`,
   `NOT_ON_SLOT_GRID`, `PRACTITIONER_NOT_AT_LOCATION`) and the patient's own
   appointments (`PATIENT_SCHEDULE_CONFLICT`). Staff allowed to override
   availability may book outside it; the override is recorded and audited.
7. Insert the appointment `CONFIRMED` with its `source_channel` and the
   signed-in staff member as `booked_by`; the exclusion constraint checks
   it against every occupying appointment of the practitioner.
8. Append the `CONFIRMED` appointment event, the `APPOINTMENT_CONFIRMED`
   outbox event and the `appointment.created` audit entry; a trigger bumps
   the practice's `schedule_signals` counter.
9. Store the answer under the idempotency key; `COMMIT`. Realtime tells the
   consoles to refresh; the worker plans the confirmation from the outbox.

A deadlock or serialization failure retries the whole transaction (up to
three times). A domain refusal rolls the command back to a savepoint and
stores the refusal under the key, so a retry gets the same answer instead
of racing again.

### The hold transaction

Guided booking in the console, WhatsApp, reschedules and waitlist offers
reserve a time first (`POST …/slot-holds`):

1. Steps 1-6 above; a reschedule hold also requires the appointment to be
   `CONFIRMED`, without another pending replacement, and (for patients)
   outside the practice's change cut-off.
2. Insert a `HELD` appointment and its `scheduling.slot_holds` row
   (`ACTIVE`, purpose, owning channel, actor and conversation, expiry = the
   database clock + the practice's hold time). From this commit the time is
   taken for every channel: the exclusion constraint counts `HELD`.
3. Append the `HELD` appointment event; `COMMIT`. The console shows the
   countdown; WhatsApp asks the patient to confirm.

Confirming (`POST …/slot-holds/:holdId/confirm`, or the patient's "Yes"):

1. Lock in the fixed order: practitioner(s), referral, waitlist entry, the
   hold, the appointment.
2. Refuse `HOLD_EXPIRED` once the expiry has passed (checked by the Core and
   by a trigger), `HOLD_NOT_ACTIVE` if it was released, `HOLD_NOT_OWNED` if
   another conversation holds it (staff share staff holds).
3. Re-evaluate the booking rules at commit time (the type or referral may
   have changed while the time was held).
4. Mark the hold `CONSUMED` and the appointment `CONFIRMED` together; a
   reschedule also moves the original to `RESCHEDULED`, linked both ways; a
   waitlist booking closes the entry and withdraws its other offers.
5. Append events, the outbox event and the audit entry (recorded under the
   channel that made the hold); `COMMIT`.

Releasing a hold cancels its `HELD` appointment (`HOLD_RELEASED`); a lapsed
hold becomes `EXPIRED` (the worker sweeps every 15 seconds, and the next
booking for the practitioner expires it inline), emitting `HOLD_EXPIRED` so
the conversation that held it can say so.

## Channels

Every appointment records its `source_channel` (`PHONE`, `WALK_IN`,
`WHATSAPP`, `WEB`, `INTERNAL`, `REFERRAL`, `OTHER`) and who booked it
(`booked_by_actor_type/id/role`): the signed-in staff member for console
bookings, the patient for WhatsApp bookings.

- **Practice console** (`apps/console`): browser → API only. The browser
  never writes a table; Supabase is used for sign-in and to subscribe to
  `scheduling.schedule_signals` (a per-practice change counter), which
  triggers a re-read through the API. Polling every 20 s covers Realtime
  outages.
- **Front page** (`apps/console/welcome`, `apps/console/src/welcome`): a
  second document in the same build, where the console sends signed-out
  visitors (with the route they asked for as `next`). It runs the
  Scheduling Core's pure domain (`@access/scheduling/domain`:
  `findAvailableSlots`, `checkSlot`, the state machine) on sample data in
  the browser, so every time it shows is computed, and it touches no real
  data: its only network use is the console's own sign-in, after which it
  hands over to the console. The scroll-craft engine
  (`apps/console/public/welcome/scrollcraft.js`, vendored unmodified)
  drives the scroll; the page's own code drives its bespoke parts from the
  engine's `--sc-p`. Its design record is `docs/front-page`.
- **WhatsApp** (`packages/access`): Meta calls the API's webhook
  (`X-Hub-Signature-256` verified over the raw body, deduplicated by message
  id, routed by `phone_number_id` to the practice) and the API stores the
  message and an outbox event. The worker's access layer answers: a
  deterministic interpreter offers menus and lists built from Core queries
  (book, my appointments, reschedule, cancel, talk to reception), validates
  every tapped option against what it offered, and calls Core commands as
  the patient. Replies are ordered and sent inside WhatsApp's 24-hour
  service window; business-initiated messages use approved templates.
- **Referrals**: a practice registers referrals (referrer, patient, type,
  validity, visit count), verifies them and files documents; types that
  require a referral book only against a verified, valid, unexhausted one.
- **Waitlist**: when a future slot is freed (cancellation, the old time of a
  move, a declined or lapsed offer, or staff announcing a free time), the
  worker offers it to the first matching waiting patient who can be reached,
  holding it as a `WAITLIST_OFFER` hold. Nothing is booked until the patient
  (or staff for them) accepts.

### The AI boundary

The system is fully functional without a language model. An optional intent
classifier (`INTENT_CLASSIFIER=anthropic`, off by default) may only map an
unrecognised free-text WhatsApp message to one of the menu intents (book,
list, cancel, reschedule, talk to staff, possible emergency, other). It never
sees availability, never books, never decides whether a slot is free, whether
a transition or a cancellation rule applies, whether a referral requirement
can be ignored, or whether a permission can be bypassed: those are Core
decisions. Its input is minimised (e-mail addresses and digit runs masked,
500 characters), its output is schema-validated against the fixed label set,
it has no retries, a short timeout and a per-minute cap, and any failure falls
back to the deterministic menu. It is ignored while staff own a conversation.

## Transactional outbox and the worker

Events (`APPOINTMENT_CONFIRMED`, `_RESCHEDULED`, `_CANCELLED`,
`PATIENT_CHECKED_IN`, `APPOINTMENT_STARTED`, `_COMPLETED`, `_NO_SHOW`,
`HOLD_EXPIRED`, `HOLD_RELEASED`, `WAITLIST_SLOT_AVAILABLE`,
`WAITLIST_OFFER_DECLINED`, `WAITLIST_OFFER_EXPIRED`,
`CHANNEL_MESSAGE_RECEIVED`, `REFERRAL_VERIFIED`) are written in the command's
transaction to `platform.outbox_events`. The worker takes one event per
transaction with `FOR UPDATE SKIP LOCKED`, keeps each aggregate's events in
order, runs its handlers in a savepoint (effects exactly once), and retries
with backoff up to `OUTBOX_MAX_ATTEMPTS` (default 10) before marking it
`FAILED`. Handlers plan notifications, run the WhatsApp access layer, offer
freed slots to the waitlist and queue EMR webhooks.

**Notifications** (`APPOINTMENT_CONFIRMATION`, `_RESCHEDULED`, `_CANCELLED`,
`_REMINDER_24H`, `_REMINDER_NEAR_TERM`, `WAITLIST_OFFER`) are delivery rows
with a status (`PENDING → PROCESSING → SENT → DELIVERED → READ`, or
`FAILED`, `CANCELLED`, `SKIPPED` with a reason). A delivery is skipped when
the patient has not consented on that channel, has no usable contact, the
channel is not configured, the environment's allow-list excludes the
recipient, or the conversation already confirmed it. The sender re-checks
consent and the appointment immediately before sending, leases rows, fences
on attempt count, and retries by failure kind (transient, ambiguous,
configuration, permanent) up to a bound.

## Data and tenancy

- Organisations (`public.organisations`) own practices
  (`directory.practices`, with an IANA time zone). Every row carries
  `tenant_id`; practice data also `practice_id`. Ids are UUIDs; times are
  `timestamptz`; local times exist only as practice wall-clock rules.
- Row-level security is enabled and forced on every table. Each transaction
  sets its tenant, practice and actor; policies admit only matching rows,
  and the API login is further bound to one practice per transaction.
- Runtime logins `access_request` (API) and `access_worker` (worker) have
  only the privileges they use; neither owns a table or bypasses RLS. The
  migration owner is used only by the migration job and operator commands.
- `platform.audit_events` is append-only (triggers refuse update, delete and
  truncate): who, what, which record, the channel, and the administrative
  before/after, never request bodies or clinical content.
- Scheduling data is kept apart from clinical records: appointment notes are
  administrative; WhatsApp message bodies are redacted after
  `CHANNEL_MESSAGE_RETENTION_DAYS` (default 90) and the conversation is not
  a clinical record.

Migrations (`supabase/migrations`, applied by a ledger runner in order,
each in one transaction with its ledger row, never edited once applied):
`0001`-`0005` the organisation referral pipeline; `0006` appointment
operations v1 (retired); `0007` platform foundations (audit, outbox,
idempotency); `0008` practice directory; `0009` Scheduling Core; `0010`
messaging and integrations; `0011` retirement of appointment operations
v1; `0012` notification worker; `0013` channel access layer; `0014`
Supabase's browser and service roles lose their default grants in
`public`; `0015` configuration rows (hours, leave, blocks) can be removed;
`0016` the runtime logins read the migration ledger.

**Releases follow the schema.** Each build ships its migrations and knows
the newest one. The API's and the worker's `/ready` answer 503
(`schema_behind`) until the database has applied it, and the worker does
no work until then, so a release deployed before its migration job (or
after a failed one) never takes traffic or processes events on an older
schema. Migrations are additive (expand, migrate, contract), so the
previous release keeps working on the newer schema and can be rolled back
to.

## The organisation referral workspace

The repository began as an organisation-level referral operations product
(`access_cases`, rule sets, a destination connector). That workspace is
still available to organisation roles in the console (`#/queue`) and its
suites still run. Its v1 appointment-operations path (a connector booking
into an in-memory appointment book) is retired by `0011`: the tables remain
read-only history and no runtime login can write them. Dropping them is a
later contract migration once every environment has applied `0011` and the
rows are exported or judged disposable (DEPLOYMENT.md, "Schema changes").
