# Implementation report

Branch `claude/gifted-euler-rw1pn5`, September 2026. What was built, how it
was verified, and what is left outside the repository. Operating details live
in ARCHITECTURE.md, DEPLOYMENT.md, RUNBOOK.md and SECURITY.md; this report
points to them rather than repeating them.

## 1. Repository state before the work

WAW-scheduling held only an initial commit. The working codebase was
imported with its history from `KingsmanRon/Appointments` (commit `2d32f41`):

- **ACCESS v1.1**, an organisation-level referral operations product:
  an `access_cases` aggregate, versioned rule sets, an evidence chain and a
  dispatcher behind a destination-connector port for which only a mock
  connector existed.
- **Appointment operations v1** (migration `0006`): bookings sent through the
  connector port to a mock transaction simulator. There were no practices,
  practitioners, working hours, computed availability, patient registry,
  expiring holds, database-level double-booking protection for a real
  schedule, WhatsApp channel, patient notifications, waitlist or practice
  roles.
- A console for the referral workflow (queue, case, dashboard, booking
  stage), an Azure (Bicep) deployment, migrations `0001`-`0006` and 22 test
  files.

## 2. Architecture adopted

A modular monolith: one repository, one container image, three processes (API,
worker, migration job) and a static console. **The Scheduling Core**
(`packages/scheduling`) is the only code that creates or changes holds and
appointments; the API (staff), the WhatsApp access layer (patients) and the
worker (waitlist offers, hold expiry) all call it. Every mutation is one
PostgreSQL transaction that also writes its audit entry and outbox events.

- Availability is computed from working hours, exceptions, blocks, types,
  appointments and holds in each location's IANA time zone; never stored.
- Double booking is refused by the exclusion constraint
  `appointments_no_practitioner_overlap`, which counts holds.
- The appointment state machine is enforced by the Core and by a trigger.
- A transactional outbox feeds the worker: notifications, WhatsApp replies,
  waitlist offers, EMR webhooks, hold expiry, reminders, retention.
- Tenancy: every row carries `tenant_id` (and `practice_id`), row-level
  security is forced, and the API login is bound to one practice per
  transaction.
- A language model is optional and may only map free text to a menu intent;
  every scheduling decision stays with the Core.

The booking and hold transactions are written out step by step in
ARCHITECTURE.md.

## 3. Schema and migrations

Ten migrations (`0007`-`0016`) add 36 tables in five schemas (`platform`,
`directory`, `scheduling`, `messaging`, `integration`):

| Migration | Adds                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0007`    | platform foundations: append-only audit, transactional outbox, idempotency keys, request-context helpers                                                                                     |
| `0008`    | practice directory: practices (IANA zone, hold time, cut-offs), locations, memberships with practice roles, patients, normalised contacts, hashed identifiers, duplicate review              |
| `0009`    | Scheduling Core: practitioners, types, working hours, exceptions, blocks, referrals and documents, waitlist and offers, appointments (exclusion constraint), holds, events, schedule signals |
| `0010`    | notification preferences and deliveries, integration connections and routes, integration events, webhook receipts, WhatsApp conversations and messages; Realtime publication of the signals  |
| `0011`    | retires appointment operations v1: its tables become read-only history                                                                                                                       |
| `0012`    | notification worker refinements: skip and withdrawal reasons (allow-list, confirmed in the conversation), staff visibility of failed and skipped messages                                    |
| `0013`    | privileges of the WhatsApp access layer in the worker: booking locks, self-registration as unverified patients, consent given or withdrawn in the conversation                               |
| `0014`    | Supabase's `anon`, `authenticated` and `service_role` lose all grants in `public` (see section 7)                                                                                            |
| `0015`    | working hours, leave and blocks can be removed (see section 7)                                                                                                                               |
| `0016`    | the runtime logins may read the migration ledger (the release schema gate)                                                                                                                   |

Invariants held by the database, not only by code: the practitioner overlap
exclusion (holds included), non-overlapping working hours, one live
replacement per rescheduled appointment, one open waitlist entry per patient
and type, an expired hold or offer can never be consumed, legal state
transitions only, append-only audit and outbox, immutable configuration rows
(removal only), forced RLS with a restrictive practice policy for the API
login, and least-privilege runtime logins that own nothing.

## 4. APIs added and changed

Versioned under `/v1`, strict schemas, domain error codes
(`SLOT_UNAVAILABLE`, `HOLD_EXPIRED`, `HOLD_NOT_OWNED`, `INVALID_TRANSITION`,
`PATIENT_SCHEDULE_CONFLICT`, `REFERRAL_REQUIRED`, `VERSION_CONFLICT`,
`IDEMPOTENCY_KEY_REUSED`, …), `Idempotency-Key` on every change.

- **77 practice routes** under `/v1/practices/:practiceId`, each requiring
  exactly one permission: context and settings; locations, practitioners,
  appointment types; working hours, exceptions, blocks; availability and
  calendar; appointments (book, search, detail, history, reschedule, cancel,
  check-in, start, complete, no-show, notes, messages); slot holds (create,
  read, confirm, release); patients (search, register, edit, contacts,
  identifiers, consent, duplicate review); waitlist and offers; referrals
  and documents; conversations; notifications; integrations; memberships;
  audit events.
- `/v1/me`, `/v1/referral-documents/download` (one-minute signed links),
  the WhatsApp webhook (`GET` verification, `POST` signed notifications),
  `/health`, `/ready` (database and schema gate), `/metrics` (bearer token).
- Changed: appointment operations v1 commands removed; the organisation
  referral routes remain for the referral workspace; every response carries
  `no-store`, `nosniff`, `DENY`, `no-referrer`, a deny-all CSP and HSTS
  outside local; 1 MiB body limit except the document routes.

## 5. UI implemented (practice console)

Supabase sign-in (a synthetic bridge only in local and staging) at the end
of the front page signed-out visitors land on (section 17), practice
selection when a user belongs to several, and per role: **Today** (arrivals,
waiting, no-shows, attention list), **Calendar** (day and week, by
practitioner or location, block time), **Appointments** search,
**appointment detail** (history, notes, messages, check-in, start, complete,
no-show, reschedule, cancel), guided **booking** with a live hold countdown
and the source channel (phone, walk-in, WhatsApp, web, internal, referral,
other; the signed-in staff member is recorded), **Patients** (search by
name, patient number, mobile, e-mail, national id or date of birth;
registration; duplicate review; contacts, identifiers and consent), **Waitlist**, **Referrals** (register, verify,
reject, withdraw, documents), **Conversations** (WhatsApp hand-off to
reception), **Notifications** (every message with status and reason),
**Schedule setup** (working hours, leave and extra sessions, types,
practitioners, locations, settings) and **Audit**.

Loading, empty and error states throughout; a taken slot shows
"The requested time is no longer available." and refreshed alternatives;
removals and no-shows ask first (Escape or "Keep" backs out); dialogs and
forms are keyboard-usable; views refresh on Realtime signals and every 20
seconds; phone layout tested; a build-time Content-Security-Policy limits
connections to the API and the Supabase project.

## 6. WhatsApp integration

Meta WhatsApp Cloud API, complete in code and tested against a local Graph
API stand-in; activation needs only Meta credentials (section 12).

- Inbound: subscription verification, `X-Hub-Signature-256` HMAC over the raw
  body in constant time, de-duplication by message id, routing by
  `phone_number_id` to the practice, delivery-status callbacks.
- The access layer answers with interactive buttons and lists built from Core
  queries (book, my appointments, reschedule, cancel, talk to reception),
  accepts only options it offered, acts through Core commands as the
  patient, honours STOP, hands anything else to reception, and works with no
  language model.
- Outbound: replies in order per conversation within the 24-hour window;
  appointment confirmations, changes, cancellations, two reminders and
  waitlist offers ("Book it" / "No thanks") as six approved templates, sent
  only with consent; failures classified (transient, ambiguous,
  configuration, permanent) with bounded retries.

## 7. Security and RLS

As designed: forced RLS on every table with tenant, practice, user and role
bound per transaction; runtime logins that cannot bypass RLS, own nothing and
are checked at start-up; the browser limited to sign-in and the practice's
change signal; a role-permission matrix enforced on every route; the
service key only in the API and only for Storage; documents malware-scanned,
AES-256-GCM encrypted and served through signed one-minute links; national
ids stored as keyed hashes; minimised patient messages; logs without bodies,
names, numbers or secrets; message bodies redacted after 90 days. Details
and the POPIA mapping: SECURITY.md.

Defects found and fixed during final validation:

| Found                                                                                                                                                                                                                                                            | Fix                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Supabase grants `anon`/`authenticated`/`service_role` everything the owner creates in `public`; the legacy tables there kept those grants, including the tenant catalogue and migration ledger (no RLS), reachable through the Data API with the public anon key | `0014`; validator and test databases now reproduce Supabase's default grants; the schema check covers `public` and sequences |
| Removing working hours, leave or a block always failed (500): the immutability guard compared whole rows, and generated columns are not yet computed in `BEFORE` triggers                                                                                        | `0015`; API tests for every removal                                                                                          |
| A dropped idle database connection (restart, pooler timeout) crashed the API or worker process                                                                                                                                                                   | every pool handles it; regression test                                                                                       |
| A release could go live before its migration had run                                                                                                                                                                                                             | schema gate: `/ready` 503 and an idle worker until the database has the build's newest migration                             |
| `channel:whatsapp:connect` connected with the owner credential without TLS settings                                                                                                                                                                              | uses the shared pool factory with `DATABASE_SSL` and the CA certificate                                                      |
| The migration validator could crash when dropping its scratch database (a CI failure)                                                                                                                                                                            | reproduced (20 rounds); the validator and migration tests use error-tolerant pools                                           |

## 8. Concurrency safeguards

- The exclusion constraint is the final authority; its violation is answered
  `409 SLOT_UNAVAILABLE`.
- Every command locks the practitioner row first and then referral, waitlist
  entry, offers, holds and appointments in a fixed order, then re-reads
  committed state (no deadlock cycles; deadlocks and serialization failures
  retry the whole transaction).
- Holds are appointments in `HELD`, counted by the constraint; expiry uses
  the database clock and is re-checked by trigger; lapsed holds are expired
  inline by the next booking.
- Idempotency keys are written in the same transaction; a concurrent retry
  waits on the key and replays the answer; refusals are stored too.
- Optimistic versions on edits; `FOR UPDATE SKIP LOCKED` leases in the
  worker; per-record ordering of outbox events; a waitlist offer can be
  taken once.

The concurrency suite: 25 simultaneous bookings of one slot give exactly one
booking and 24 `SLOT_UNAVAILABLE`; 25 raw overlapping inserts, one admitted;
hold against hold, hold against booking, partially overlapping bookings,
reschedule against booking; waitlist offers answered concurrently, accepted
and declined at once, two offers of one slot.

## 9. Tests

| Suite                                            | Tests | What it covers                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                                             |   151 | availability engine and time zones, rules, state machine, patients, notifications, WhatsApp interpreter and classifier, policy, configuration, migrations, links, the front page's sample scheduling                                                                                                    |
| Integration (real PostgreSQL, real logins)       |   129 | RLS and schema security, Scheduling Core, practice API, patients, worker, WhatsApp channel, referrals, documents, waitlist, schema gate, connection loss                                                                                                                                                |
| Acceptance and qualification (vitest)            |    39 | the referral workspace's acceptance and qualification suites, including the runtime logins' least privilege                                                                                                                                                                                             |
| Security                                         |    12 | the authorisation matrix (every route × every role, anonymous, other practice), API hardening, console bundle secrets                                                                                                                                                                                   |
| Concurrency                                      |     9 | section 8                                                                                                                                                                                                                                                                                               |
| Browser (Playwright, built console, API, worker) |    23 | reception booking and visit, walk-in, reschedule and cancel, two desks racing, five roles, blocks and leave with confirmations, WhatsApp to console and back, waitlist on WhatsApp, reception replying on WhatsApp then linking and closing, the front page and its sign-in hand-off; desktop and phone |
| Migration validation                             |     2 | all migrations on a clean database standing in for Supabase and on plain PostgreSQL, twice, schema invariants                                                                                                                                                                                           |

All pass locally (unit 151/151, PostgreSQL suites 189/189, browser 23/23)
and in CI, which fails on any skipped test and runs lint, format, type
checks, the builds, the image and the secret scan.

## 10. Validation checklist

| #   | Check                                  | Result | Evidence                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Full test suite                        | pass   | 151 unit, 189 PostgreSQL (integration, e2e, security, concurrency), 23 browser; no skips                                                                                                                                                                                                                     |
| 2   | Lint                                   | pass   | `npm run lint`; `npm run format` (Prettier)                                                                                                                                                                                                                                                                  |
| 3   | Type checking                          | pass   | `npm run typecheck` (runtime and tests, strict)                                                                                                                                                                                                                                                              |
| 4   | Production builds                      | pass   | `npm run build` (all workspaces, console via Vite); CI builds and checks the runtime image                                                                                                                                                                                                                   |
| 5   | Migrations from a clean database       | pass   | `npm run db:validate`, with and without the Supabase stand-in: 16 applied, second run applies nothing, schema invariants hold                                                                                                                                                                                |
| 6   | RLS                                    | pass   | `scheduling-rls` suite (7), authorisation matrix, cross-practice tests; schema check forbids unforced RLS and browser grants                                                                                                                                                                                 |
| 7   | Concurrency                            | pass   | 9 concurrency tests (section 8)                                                                                                                                                                                                                                                                              |
| 8   | End-to-end scheduling                  | pass   | 23 browser tests against the built console, API and worker (reception, WhatsApp, waitlist, roles, setup)                                                                                                                                                                                                     |
| 9   | No secrets in the repository           | pass   | `npm run check:secrets`; a pattern sweep finds only test fixtures; only `.env.example` is tracked; the console bundle test proves no server secret reaches it                                                                                                                                                |
| 10  | TODO / mock / stub inspection          | pass   | no TODO, FIXME or stubs in production code. Two mocks remain, both refused with REAL data and in secure profiles: the synthetic malware scanner (ClamAV in production) and the referral workspace's destination connector (production uses `CONNECTOR_KIND=none`, manual entry). Neither touches scheduling. |
| 11  | Vercel build configuration             | pass   | `apps/console/vercel.json` (monorepo install/build, headers), build-time CSP; checked by `npm run validate:infra`; the console build runs in CI                                                                                                                                                              |
| 12  | Railway API configuration              | pass   | `infra/railway/api.railway.toml`: start command, `/ready` health check, replicas, draining; checked by `validate:infra`                                                                                                                                                                                      |
| 13  | Railway worker configuration           | pass   | `infra/railway/worker.railway.toml` and `migrate.railway.toml` (never restarted, sole owner credential); checked by `validate:infra`                                                                                                                                                                         |
| 14  | Health and readiness                   | pass   | live run of the built API and worker: `/health` and `/ready` 200, `/metrics` 401 without and 200 with the token; on a database one migration behind, `/ready` 503 `schema_behind`, then 200 once migrated                                                                                                    |
| 15  | Audit generation                       | pass   | live booking recorded `appointment.created` with actor, role and channel PHONE; audit assertions in API and browser tests                                                                                                                                                                                    |
| 16  | Outbox processing                      | pass   | live: `APPOINTMENT_CONFIRMED` processed by the worker on its first attempt and planned the confirmation and reminder; worker suites                                                                                                                                                                          |
| 17  | Idempotency                            | pass   | live: no key 400; retry replays the same appointment (`Idempotent-Replayed: true`); same key with another body 422; API tests                                                                                                                                                                                |
| 18  | Cross-channel availability consistency | pass   | live: a second desk refused `SLOT_UNAVAILABLE`, one appointment stored, the slot no longer offered and offered again after cancelling; browser tests book on WhatsApp and change in the console and back                                                                                                     |

## 11. Deployment configuration

- `Dockerfile`: one production image (API default command; worker and
  migration job override it); no dev dependencies or local state (checked in
  CI).
- Railway: `infra/railway/{api,worker,migrate}.railway.toml` plus a ClamAV
  service; one project with `staging` and `production` environments.
- Vercel: `apps/console/vercel.json` and the Vite CSP plugin.
- `docker-compose.yml` for local development; `infra/observability` with
  Prometheus scrape configuration and alert rules; `.env.example` with names
  only; `.github/workflows/ci.yml` (checks, browser suite, image).
- Every process validates its configuration at start and exits 78 naming the
  offending variables.

## 12. External configuration still required

Nothing below can be done from the repository; DEPLOYMENT.md gives the steps.

1. Supabase projects for staging and production: region, point-in-time
   recovery, Auth (sign-ups off, MFA policy, staff users), runtime logins and
   the private bucket (provisioning scripts), Data API off or `public`
   removed from it.
2. Railway project and services with their variables; ClamAV service.
3. Vercel projects for the staging and production consoles, with the four
   public variables and domains; the console origins on the API.
4. Meta: WhatsApp Business Account, registered number, app with webhook
   (callback URL, verify token, `messages`), app secret, system-user token,
   and approval of the six templates.
5. Optional: SMTP, EMR webhook receivers, the Anthropic key with the
   processor approval.
6. Prometheus and Alertmanager (or a hosted equivalent) and an uptime check
   on `/ready`.
7. Before REAL data: operator agreements with every sub-processor, an
   independent penetration test, and the client-pilot checklist
   (`docs/client-pilot-checklist.md`).

## 13. Risks

- **Not yet run on the real platforms.** Everything is tested against
  PostgreSQL 16 with Supabase's roles, grants and Realtime publication
  simulated, and against a Graph API stand-in. First deployments may surface
  platform differences (pooler behaviour, Realtime authorisation, health
  check timing); staging acceptance (section 15) is where they must show.
- **No API rate limiting.** Every route needs authentication and webhooks a
  signature, but request floods are not throttled in the application; put
  the API behind an edge with rate limiting (or add it) before exposure to
  hostile traffic.
- **Template approval** is Meta's decision; rejected wording must be
  re-submitted and mapped in the connection's configuration.
- **Manual operations**: key rotation for stored documents and identifier
  hashes, document deletion at retention end, and restores are documented
  procedures, not automated jobs.
- **Single worker replica** by design (safe to scale, not needed at practice
  volumes); load beyond a few practices per worker has not been measured.
- **Legacy workspace**: the organisation referral workspace and the
  read-only appointment-operations v1 tables remain until a later contract
  migration.
- **Browsers**: the browser suite runs in Chromium (desktop and phone
  emulation); Safari and Firefox are untested.

## 14. Deploying to staging (exact commands)

Once per machine: `npm i -g @railway/cli vercel`, `railway login`,
`vercel login`, then in a checkout `railway link` (the `access` project) and
`vercel link` (the staging console project). For a commit whose CI run is
green:

```bash
git fetch origin && git checkout <commit>
railway up -s migrate -e staging --ci
railway logs -s migrate -e staging -n 20          # {"applied":[…],…}
railway up -s api -e staging --ci
railway deployment list -s api -e staging --limit 2
curl -fsS https://<staging-api-domain>/health
curl -fsS https://<staging-api-domain>/ready
railway up -s worker -e staging --ci
railway ssh -s worker -e staging -- node -e "fetch('http://localhost:'+process.env.PORT+'/ready').then(async r=>console.log(r.status,await r.text()))"
vercel deploy --prod
```

Synthetic data for staging (`railway run -s migrate -e staging -- …` with
`practice:bootstrap`, `practice:demo`, `channel:whatsapp:connect`) is in
DEPLOYMENT.md, sections 5 and 6.

## 15. Staging acceptance sequence

On the exact commit to be released (DEPLOYMENT.md, section 7, has the full
wording):

1. Health, readiness, metrics token, Prometheus targets.
2. Sign in as each of the five roles; menus and API refusals match.
3. Phone booking through the hold; appears in every view; history and audit
   show the receptionist and PHONE.
4. Two desks race one time: one books, the other is told and offered
   alternatives.
5. Reschedule and cancel; the allow-listed phone receives the templates.
6. WhatsApp: book, see it in the console, cancel on WhatsApp, see it
   cancelled; "Talk to reception" reaches Conversations.
7. Waitlist: a freed matching time is offered and taken with "Book it".
8. Add and remove hours, leave and a block; times disappear and return in
   the console and on WhatsApp.
9. Check-in, start, complete; a no-show after the start.
10. A referral with a PDF: a doctor opens it, reception cannot.
11. Worker outage: a booking made meanwhile is confirmed once, late.
12. Isolation: 401 without a token, 404 for another practice, and the live
    Supabase grant query returns no rows.
13. Roll the API back and forward.

## 16. Production release sequence

1. Staging accepted on the same commit; no open incident; outbox not backed
   up.
2. Point-in-time recovery on; note the time as the restore point.
3. Release:

   ```bash
   git checkout <accepted commit>
   railway up -s migrate -e production --ci
   railway logs -s migrate -e production -n 20      # applied, or stop (RUNBOOK.md)
   railway up -s api -e production --ci
   railway deployment list -s api -e production --limit 2
   curl -fsS https://<api-domain>/ready
   railway up -s worker -e production --ci
   railway ssh -s worker -e production -- node -e "fetch('http://localhost:'+process.env.PORT+'/ready').then(async r=>console.log(r.status,await r.text()))"
   vercel deploy --prod                               # production console, if changed
   ```

4. Smoke test without patient-facing actions; console security headers.
5. Watch errors, slot conflicts, outbox age and notification failures for
   30 minutes; roll back (RUNBOOK.md) on any doubt.

## 17. Second iteration: the front end

Asked for: every console view working, and the front end built with the
[scroll-craft](https://github.com/nateherkai/scroll-craft) skill as the
reference.

### Console audit

Every view was opened at desktop (1440 x 900) and phone (390 x 844) sizes
against the built console, API and worker, on a practice filled through
the API: 46 view and size combinations, checked for console errors, failed
requests, horizontal overflow and contrast. Then every form and action the
browser suite does not cover was driven in a browser on a fresh database
(18 flows: registering and editing a patient, contacts, identifiers and
consent, referrals, the waitlist and its offers, schedule setup, practice
settings, conversation replies and links, appointment notes, the audit
filter). All 18 pass. Found and fixed:

| Defect                                                                                                                                              | Fix                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linking a WhatsApp conversation to a patient also handed it back to the assistant                                                                   | `PATCH /conversations/:id` accepts `patient_id` alone; the conversation stays with reception; audited as `conversation.patient_linked`; an empty change is refused (400)                                                                        |
| Handing back, closing or linking straight after a staff reply was refused as a conflicting change (the worker records the send on the conversation) | The console holds those actions until the reply has left (up to 6 s); a link still refused that way is applied once to the current version if nobody has linked a patient since. Handing back and closing stay refused, for staff to look first |
| Opening a conversation from the "With the assistant" or "Closed" tab sent the list back to "Needs reception"                                        | The tab is part of the address, so opening, resolving and going back keep it                                                                                                                                                                    |
| "Offer a free time" defaulted to 10:00, which was usually too soon to be answered and refused                                                       | It defaults to the first time an offer can still be answered                                                                                                                                                                                    |
| Calendar: titles and hours scrolled out of view on a long day; next and previous used mismatched, unnamed icons                                     | Scroll area with fixed titles and hour column; matching icons named "Next day" / "Previous week"                                                                                                                                                |
| Notifications showed message codes, no due or sent times, no way to the appointment                                                                 | Names staff use, a "Queued" column with the due time, sent times, "Open appointment"                                                                                                                                                            |
| "Whatsapp", "Sms", "Emr" in labels                                                                                                                  | WhatsApp, SMS, EMR, ID and API keep their capitals                                                                                                                                                                                              |
| Muted text under 4.5:1 on some surfaces                                                                                                             | Darkened to clear 4.5:1 wherever it is used                                                                                                                                                                                                     |
| An empty cell in the referral form; phone tables with unnamed columns; the setup header overflowing on phones                                       | Form regrouped; phone tables name their columns; the header wraps                                                                                                                                                                               |
| Em dashes as empty values                                                                                                                           | "Not recorded" and "(empty)"                                                                                                                                                                                                                    |

### Front page

Signed-out visitors to the console now land on `/welcome/` instead of a
bare login form. It follows the scroll-craft procedure (brief, grammar,
fingerprint gate, score, harness, feel check), recorded in
[docs/front-page](front-page/builds/access/BRIEF.md), and uses its engine
vendored unmodified (MIT; the licence sits beside it). The page looks and
behaves like the console and runs the Scheduling Core's pure domain
(`@access/scheduling/domain`) on a labelled, fictional sample practice:
requests from every channel placed on the book, a WhatsApp patient
choosing a time the visitor picks, then 25 simultaneous requests for that
time with one held and 24 given the next free times. The one real figure
is the repository's own concurrency test (25 bookings of one time against
PostgreSQL, exactly one stored).

It reads and writes no practice data; its only network use is the
console's own sign-in (the synthetic bridge in local and staging,
Supabase otherwise), after which it hands back to the console. A deep link
survives the round trip as `next`, accepted only as a console route. The
build-time CSP is unchanged (`script-src 'self'`, `style-src 'self'`).

### Tests added

5 unit tests (the page's placement, the race run for every free time of
the day, confirmation, visit steps), 7 browser tests (the sign-in hand-off
with a deep link, the computed morning, choosing a time by button and by
keyboard, the skip link, reduced motion, the page's chrome on a desktop and
a phone), a browser test in which reception replies on WhatsApp, links
the patient at once, closes the conversation and opens it again from the
"Closed" tab (it fails on the previous console, first with the conflict
above, then with the tab), and the link-only change in the WhatsApp
channel suite. The CI floors rose to 151 unit and 23 browser tests.

### Verification (this commit)

`npm run format`, `lint`, `typecheck`, `build`, `validate:infra` and
`check:secrets` pass; `db:validate` passes with and without the Supabase
stand-in; unit 151/151, PostgreSQL suites 189/189 and browser 23/23 in CI
mode, with no skips or retries.

Not verified: a real phone (iOS Safari, Chrome on Android; phone sizes ran
in Chromium only), the Supabase sign-in in a browser (the suites use the
synthetic identity; that form is the previous login's logic, moved), and a
Vercel deployment of the two-page build.
