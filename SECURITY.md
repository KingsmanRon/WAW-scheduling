# Security

ACCESS holds personal information of patients (names, dates of birth,
contact details, identifiers, appointment history, referral letters) on
behalf of medical practices. This document describes how it is protected,
what the tests prove, and what remains for an operator to do.

**Reporting a vulnerability:** e-mail the maintainers privately (see the
repository owner's profile); do not open a public issue.

## Boundaries and trust

| Component                 | Trusted with                                                                               | Never holds                                               |
| ------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Console (browser)         | the signed-in user's Supabase session, the anon key                                        | service keys, database credentials, other practices' data |
| API (Railway)             | `access_request` login, Storage service key, document and identifier keys, Meta app secret | owner credential, provider tokens                         |
| Worker (Railway)          | `access_worker` login, provider tokens (WhatsApp, SMTP, EMR), identifier key               | owner credential, Storage service key                     |
| Migration job             | owner credential                                                                           | anything else                                             |
| Language model (optional) | a masked, truncated message text                                                           | availability, identities, the power to act                |

The browser never writes to the database: every authoritative change goes
browser → API → authentication → practice role → validation → one
transaction (Scheduling Core + audit + outbox) → PostgreSQL. The browser's
only direct Supabase use is sign-in and a Realtime subscription to
`scheduling.schedule_signals`, which carries a practice id, a practitioner
id and a change counter (no patient data) and is readable only by members of
that practice.

## Authentication

- Staff sign in with Supabase Auth; the API verifies the JWT (JWKS or the
  project's signing secret), issuer and audience on every request.
- The practice and the role come from `directory.practice_memberships`,
  resolved server-side for the practice in the URL on every request. A
  token without an active membership of that practice gets nothing.
- The development identity bridge (`ACCESS_AUTH_MODE=synthetic`) is refused
  in client-pilot and production; in JWT mode its headers are ignored
  (tested).
- Patients authenticate by the WhatsApp number Meta delivers the message
  from; a conversation acts only for patients registered with that number,
  and registration from WhatsApp creates an unverified identity until
  reception verifies it.
- MFA and password policy are Supabase Auth settings (DEPLOYMENT.md).

## Authorisation

Five practice roles, each a fixed set of permissions (`packages/policy`):

| Permission                                               | Admin | Doctor |   Reception   | Clinical staff | Read-only |
| -------------------------------------------------------- | :---: | :----: | :-----------: | :------------: | :-------: |
| See the schedule (calendar, appointments)                |   ✓   |   ✓    |       ✓       |       ✓        |     ✓     |
| See and edit patients                                    |   ✓   |  see   |       ✓       |      see       |           |
| Book, reschedule, cancel                                 |   ✓   |   ✓    |       ✓       |                |           |
| Check in, start, complete, no-show, notes                |   ✓   |   ✓    |       ✓       |       ✓        |           |
| Block time, leave and exceptions                         |   ✓   |  own   |       ✓       |                |           |
| Working hours, types, practitioners, locations, settings |   ✓   |        |               |                |           |
| Waitlist (see / manage)                                  |   ✓   |   ✓    |       ✓       |      see       |           |
| Referrals (see, register / verify)                       |   ✓   |   ✓    | see, register |       ✓        |           |
| Open referral documents                                  |   ✓   |   ✓    |               |       ✓        |           |
| WhatsApp conversations                                   |   ✓   |        |       ✓       |                |           |
| Notifications (see / manage consent)                     |   ✓   |  see   |       ✓       |      see       |           |
| Staff, integrations, audit trail                         |   ✓   |        |               |                |           |

Every route checks exactly one permission before it validates anything.
`tests/security/authorization-matrix.test.ts` holds the reviewed
route-to-permission table, fails if the API serves a route missing from it,
and calls every route as every role (and anonymously, and as another
practice's administrator), requiring the policy's answer each time.

## Tenant isolation

- Every table carries `tenant_id` (practice data also `practice_id`);
  row-level security is enabled and forced on all of them. Each
  transaction sets its tenant, practice and actor; the API login is bound to
  one practice per transaction. Ids from another practice are `404`.
- Runtime logins own nothing, cannot bypass RLS and have only the
  privileges they use; the browser roles (`anon`, `authenticated`) can read
  nothing but their own practices' change signals (tested in
  `tests/integration/scheduling-rls.test.ts`).

## Integrity

- Double booking is refused by an exclusion constraint, not by application
  checks; appointment and referral transitions by triggers as well as by
  the Core. Holds, idempotency keys and optimistic versions make retries
  and concurrent edits safe.
- The audit trail (`platform.audit_events`) is append-only (triggers refuse
  update, delete and truncate) and records actor, role, channel, the record
  and the administrative before/after of every change, document link
  issued and document downloaded.

## Data protection

- **In transit**: HTTPS to the console and API; TLS to PostgreSQL
  (`DATABASE_SSL=require` is mandatory in client-pilot and production).
- **Documents**: type-checked by content, malware-scanned (ClamAV;
  refused if the scanner is unavailable), encrypted with AES-256-GCM by the
  API before they reach the private bucket, stored under opaque keys,
  de-duplicated by digest. They are served only by the API through a
  one-minute link signed with a key derived from the storage key (HKDF),
  bound to one document and one user, re-checked against the user's
  current membership and `referral.document.read` permission when used,
  verified against the stored digest, with `no-store`, `nosniff` and a
  sandboxing CSP. Issuing and downloading are both audited.
- **Identifiers**: national ids are stored only as keyed HMAC digests plus
  a short hint; phone numbers and e-mail addresses are normalised (E.164,
  lower case) and shown masked in delivery views.
- **Minimisation**: messages to patients carry first name, practice, time,
  practitioner and location only, never a reason for visit or clinical
  detail. WhatsApp message bodies and rendered notification content are
  redacted after 90 days; the conversation is not a clinical record.
- **Logs** never contain bodies, names, contact details, identifiers,
  message text, tokens or keys (a static test checks every logging call in
  server code). Metrics carry ids and codes only.

## Secrets

Credentials come only from the platform's variable store; `.env.example`
lists names only. CI's `scripts/check-secrets.sh` fails on committed
credentials or tracked `.env` files. Integration credentials are referenced
by environment-variable name (`WHATSAPP_*`, `EMR_WEBHOOK_*`), never stored in
the database, and cannot name platform secrets. The console build is
tested with a service key present in its build environment to prove it
cannot reach the bundle.

## Inputs and outputs

- Strict schemas (unknown fields refused) on every request; 1 MiB body
  limit except the four document routes; errors carry a code and a
  message, never a stack trace or SQL.
- Every change needs an `Idempotency-Key`, bound to the request's content.
- WhatsApp webhooks: HMAC-SHA256 over the raw body with the Meta app secret,
  compared in constant time; duplicates dropped by message id; unknown
  numbers ignored. Download-link signatures accept exactly one encoding.
- Outbound: EMR webhooks are signed (HMAC over timestamp and body) and may
  only target public HTTPS hosts, re-checked at connection time (no SSRF to
  private networks).
- Response headers: `Cache-Control: no-store`, `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a deny-all CSP
  on API responses, HSTS outside local; the console has a build-time CSP
  limited to its API and Supabase project, plus frame-ancestors, HSTS and
  permissions policy from Vercel.

## The language model

The optional intent classifier sees only free text the deterministic
interpreter did not understand, with e-mail addresses and digit runs masked,
cut to 500 characters, never logged. Its answer is validated against a fixed
label set and may only start a menu flow or escalate to staff; every
scheduling decision stays with the Core. It is off by default, needs
`INTENT_CLASSIFIER_PROCESSOR_APPROVED=true` before it may see REAL data, and
the channel keeps working when it fails.

## POPIA

| Condition (Protection of Personal Information Act) | How ACCESS supports it                                                                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accountability (s8)                                | The practice is the responsible party; ACCESS operators act under an operator agreement (s21) with it.                                                                |
| Processing limitation, minimality (s9-s12)         | Only scheduling and contact data; administrative notes only; message content minimised.                                                                               |
| Purpose specification, retention (s13-s14)         | Retention periods per data type (RUNBOOK.md, "Retention"); message bodies redacted after 90 days.                                                                     |
| Information quality (s16)                          | Normalised contacts, duplicate review without automatic merging, staff verification of identity.                                                                      |
| Openness and notification (s17-s18)                | Consent recorded per channel with source and time; the practice informs patients.                                                                                     |
| Security safeguards (s19-s22)                      | This document; breach procedure in RUNBOOK.md.                                                                                                                        |
| Data subject participation (s23-s25)               | Access and correction in the console; STOP on WhatsApp; archive (RUNBOOK.md).                                                                                         |
| Direct marketing (s69)                             | None: only appointment messages, and only with consent.                                                                                                               |
| Cross-border transfer (s72)                        | Hosting regions are chosen per deployment; the operator agreements with Supabase, Railway, Vercel, Meta (and Anthropic, if enabled) must provide adequate protection. |

## What remains for the operator

- An independent penetration test before REAL data (client-pilot checklist).
- Supabase Auth hardening (MFA, sign-up disabled), and access reviews of
  practice memberships.
- Signed operator agreements with every sub-processor listed above.
- Planned (manual) key rotation and document deletion at retention end
  (RUNBOOK.md).
