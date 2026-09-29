-- 0007: platform foundations for the Scheduling Core.
--
-- Applied by the ledger runner inside one transaction with its
-- schema_migrations row; no BEGIN/COMMIT here. Additive only: nothing
-- existing is altered.
--
-- New modules get their own PostgreSQL schemas. They are not exposed by
-- Supabase's PostgREST (which serves `public` only by default), so browser
-- credentials can never address them through the Data API, and module
-- boundaries are visible in every query:
--
--   platform     idempotency keys, transactional outbox, audit trail, helpers
--   directory    practices, locations, practice memberships, patients
--   scheduling   the authoritative schedule (Scheduling Core)
--   messaging    notification preferences/deliveries, channel conversations
--   integration  integration connections, events, webhook receipts
--
-- Tenancy: `tenant_id` is the organisation id (public.organisations.id) on
-- every row, exactly as in 0001-0006. Practice-scoped rows also carry
-- `practice_id`, and composite foreign keys include both, so a row can never
-- reference a row of another organisation or practice.
--
-- Row-level security model for the new schemas:
--   * a permissive policy binds every role to the transaction-local
--     app.tenant_id (fails closed when it is unset);
--   * a RESTRICTIVE policy additionally binds the API role (access_request,
--     which serves interactive staff and channel requests) to the
--     transaction-local app.practice_id;
--   * the worker (access_worker) stays tenant-scoped: it processes background
--     work for every practice of an organisation, one tenant per transaction.

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS directory;
CREATE SCHEMA IF NOT EXISTS scheduling;
CREATE SCHEMA IF NOT EXISTS messaging;
CREATE SCHEMA IF NOT EXISTS integration;
REVOKE ALL ON SCHEMA platform, directory, scheduling, messaging, integration FROM PUBLIC;
GRANT USAGE ON SCHEMA platform, directory, scheduling, messaging, integration TO access_request, access_worker;

-- ---------------------------------------------------------------------------
-- Request context helpers. Simple SQL functions so the planner inlines them
-- into policies. Values are set with set_config(..., true) per transaction
-- by packages/db (tenantTx/practiceTx); absent values yield NULL, and NULL
-- never equals a key, so every policy fails closed.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION platform.uuid_or_null(value text) RETURNS uuid
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN value::uuid END
$$;
CREATE OR REPLACE FUNCTION platform.current_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT platform.uuid_or_null(current_setting('app.tenant_id', true))
$$;
CREATE OR REPLACE FUNCTION platform.current_practice() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT platform.uuid_or_null(current_setting('app.practice_id', true))
$$;
CREATE OR REPLACE FUNCTION platform.current_user_uuid() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT platform.uuid_or_null(current_setting('app.user_id', true))
$$;
CREATE OR REPLACE FUNCTION platform.current_actor_role() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.actor_role', true), '')
$$;
-- Subject of the verified Supabase JWT when PostgreSQL is reached through
-- Supabase (Realtime evaluates policies with request.jwt.claims set). NULL
-- everywhere else.
CREATE OR REPLACE FUNCTION platform.jwt_sub() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT platform.uuid_or_null(coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')))
$$;
-- IANA time zone validation against the server's time zone database.
CREATE OR REPLACE FUNCTION platform.enforce_timezone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown time zone %', NEW.timezone USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Optimistic concurrency: every update of a versioned row increments the
-- version exactly once, so a stale writer can always be detected.
CREATE OR REPLACE FUNCTION platform.enforce_version_increment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION '% update must increment version exactly once', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION platform.forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------
-- Idempotency keys. One row per (tenant, scope, key); written inside the
-- same transaction as the mutation it protects, so a concurrent retry with
-- the same key blocks on the primary key until the first attempt commits and
-- then replays its stored response. A rolled-back attempt leaves no row.
-- ---------------------------------------------------------------------------

CREATE TABLE platform.idempotency_keys(
  tenant_id uuid NOT NULL REFERENCES public.organisations(id),
  -- The practice for practice-scoped operations; the tenant otherwise.
  scope_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_.]{2,80}$'),
  -- SHA-256 of the canonical request (operation, target, body).
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (state IN ('PENDING','COMPLETED')),
  response_status integer CHECK (response_status BETWEEN 200 AND 499),
  response_body jsonb,
  resource_type text,
  resource_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, scope_id, idempotency_key),
  CONSTRAINT idempotency_completed CHECK (
    (state = 'COMPLETED') = (response_status IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL)),
  CONSTRAINT idempotency_expiry CHECK (expires_at > created_at)
);
CREATE INDEX idempotency_keys_expiry ON platform.idempotency_keys(tenant_id, expires_at);

-- ---------------------------------------------------------------------------
-- Transactional outbox. Domain mutations append events here in the same
-- transaction; the worker routes them to durable per-consumer work
-- (notification deliveries, integration events, waitlist offers). A failed
-- consumer never rolls back the committed mutation.
-- ---------------------------------------------------------------------------

CREATE TABLE platform.outbox_events(
  tenant_id uuid NOT NULL REFERENCES public.organisations(id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  practice_id uuid,
  event_type text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z_]{1,40}$'),
  aggregate_id uuid NOT NULL,
  -- Identifiers, statuses and instants only; never names or free text.
  payload jsonb NOT NULL DEFAULT '{}',
  correlation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','PROCESSED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{2,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT outbox_processed_time CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
  CONSTRAINT outbox_lease CHECK (status <> 'PROCESSING' OR lease_until IS NOT NULL)
);
CREATE INDEX outbox_events_due ON platform.outbox_events(tenant_id, available_at, id)
  WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX outbox_events_aggregate_order ON platform.outbox_events(tenant_id, aggregate_id, id)
  WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX outbox_events_failed ON platform.outbox_events(tenant_id, created_at) WHERE status = 'FAILED';

-- An event is a fact: only its processing columns ever change.
CREATE OR REPLACE FUNCTION platform.outbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox events are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
     OR NEW.event_type <> OLD.event_type OR NEW.aggregate_type <> OLD.aggregate_type
     OR NEW.aggregate_id <> OLD.aggregate_id OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.correlation_id <> OLD.correlation_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'outbox event content is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'PROCESSED' AND NEW.status <> 'PROCESSED' THEN
    RAISE EXCEPTION 'a processed outbox event is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_events_guard BEFORE UPDATE OR DELETE ON platform.outbox_events
  FOR EACH ROW EXECUTE FUNCTION platform.outbox_guard();

-- ---------------------------------------------------------------------------
-- Audit trail: immutable, append-only record of consequential operations.
-- Application logs are never the audit trail.
-- ---------------------------------------------------------------------------

CREATE TABLE platform.audit_events(
  tenant_id uuid NOT NULL REFERENCES public.organisations(id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  practice_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('STAFF','PATIENT','SYSTEM','INTEGRATION','OPERATOR')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  actor_role text CHECK (actor_role IS NULL OR actor_role ~ '^[A-Z_]{2,40}$'),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{2,80}$'),
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z][a-z_]{1,40}$'),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 200),
  channel text CHECK (channel IS NULL OR channel IN ('PHONE','WALK_IN','WHATSAPP','WEB','INTERNAL','REFERRAL','OTHER','API','SYSTEM')),
  -- {"before": {...}, "after": {...}} of the changed administrative fields.
  changes jsonb NOT NULL DEFAULT '{}',
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  request_id text CHECK (request_id IS NULL OR length(request_id) <= 100),
  correlation_id uuid,
  ip_address inet,
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX audit_events_practice_time ON platform.audit_events(tenant_id, practice_id, occurred_at DESC, id DESC);
CREATE INDEX audit_events_resource ON platform.audit_events(tenant_id, resource_type, resource_id, occurred_at DESC);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON platform.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.access_forbid_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON platform.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.access_forbid_mutation();
CREATE TRIGGER outbox_events_no_truncate BEFORE TRUNCATE ON platform.outbox_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.access_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------

ALTER TABLE platform.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.idempotency_keys
  USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant());
-- The API may only use keys of the practice (or organisation) it acts for.
CREATE POLICY request_scope ON platform.idempotency_keys AS RESTRICTIVE TO access_request
  USING (scope_id = coalesce(platform.current_practice(), platform.current_tenant()))
  WITH CHECK (scope_id = coalesce(platform.current_practice(), platform.current_tenant()));
-- The worker purges expired keys and nothing else.
CREATE POLICY worker_purge_expired ON platform.idempotency_keys AS RESTRICTIVE FOR DELETE TO access_worker
  USING (expires_at < now());

ALTER TABLE platform.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.outbox_events
  USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant());
CREATE POLICY request_scope ON platform.outbox_events AS RESTRICTIVE TO access_request
  USING (practice_id IS NOT DISTINCT FROM platform.current_practice())
  WITH CHECK (practice_id IS NOT DISTINCT FROM platform.current_practice());

ALTER TABLE platform.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.audit_events
  USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant());
CREATE POLICY request_scope ON platform.audit_events AS RESTRICTIVE TO access_request
  USING (practice_id IS NOT DISTINCT FROM platform.current_practice())
  WITH CHECK (practice_id IS NOT DISTINCT FROM platform.current_practice());

-- ---------------------------------------------------------------------------
-- Least privilege. No DELETE/TRUNCATE except the worker's expired-key purge.
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON platform.idempotency_keys TO access_request;
GRANT SELECT, DELETE ON platform.idempotency_keys TO access_worker;
GRANT SELECT, INSERT ON platform.outbox_events TO access_request;
GRANT SELECT, INSERT, UPDATE ON platform.outbox_events TO access_worker;
GRANT SELECT, INSERT ON platform.audit_events TO access_request, access_worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA platform TO access_request, access_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA platform FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA platform TO access_request, access_worker;
