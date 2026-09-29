-- 0003: ACCESS case aggregate and case-aware execution infrastructure.
--
-- Applied by packages/db/src/migrations.ts inside one transaction together
-- with its schema_migrations ledger row; it therefore contains no BEGIN or
-- COMMIT. Every existing referral becomes exactly one REFERRAL access_case
-- whose id is derived deterministically from (tenant_id, referral_id), so a
-- re-run or an independent re-computation yields the same identifiers.

-- The owner applies the backfill; FORCE RLS would otherwise hide rows from a
-- non-BYPASSRLS owner. 0005 re-forces RLS on every tenant table.
ALTER TABLE referrals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE commands NO FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE work_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE executions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox NO FORCE ROW LEVEL SECURITY;

-- Deterministic RFC 4122-shaped identifier (version nibble 5, variant 8-b)
-- from an md5 of the namespace and two UUIDs. Mirrored by derivedUuid() in TS.
CREATE OR REPLACE FUNCTION access_derived_uuid(namespace text, a uuid, b uuid)
RETURNS uuid LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-'||
          substr('89ab',(('x'||substr(h,17,1))::bit(4)::int % 4)+1,1)||substr(h,18,3)||'-'||
          substr(h,21,12))::uuid
  FROM (SELECT md5(namespace||':'||a::text||':'||b::text) AS h) x
$$;

-- Refuse to migrate over orphaned rows instead of inventing cases for them.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commands','evidence_events','work_items','executions','outbox'] LOOP
    EXECUTE format(
      'DO $inner$ BEGIN IF EXISTS (SELECT 1 FROM %I x WHERE NOT EXISTS (SELECT 1 FROM referrals r WHERE r.tenant_id=x.tenant_id AND r.id=x.referral_id)) THEN RAISE EXCEPTION ''0003: %I has rows whose referral does not exist; resolve before migrating''; END IF; END $inner$', t, t);
  END LOOP;
END $$;

CREATE TABLE access_cases(
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  case_type text NOT NULL CHECK (case_type IN ('REFERRAL','APPOINTMENT_REQUEST','STATUS_ENQUIRY','MISSING_INFORMATION','CANCELLATION_REQUEST','RESCHEDULING_REQUEST')),
  patient_context_id uuid,
  source_channel text NOT NULL CHECK (source_channel IN ('STAFF_UPLOAD','API','EMAIL','WHATSAPP','VOICE','PATIENT_PORTAL')),
  current_state text NOT NULL CHECK (current_state IN ('RECEIVED','IDENTITY_PENDING','INFORMATION_MISSING','READY','DESTINATION_PENDING','READY_FOR_BOOKING','WAITING','BOOKED','CLOSED','EXCEPTION','REJECTED')),
  current_owner text CHECK (current_owner IN ('SYSTEM','ADMIN','PRACTICE_MANAGER','REFERRAL_COORDINATOR')),
  exception_reason text,
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz,
  outcome_at timestamptz,
  resolution_code text CHECK (resolution_code IN ('BOOKED','PATIENT_UNREACHABLE','PATIENT_DECLINED','PROVIDER_DECLINED','DUPLICATE_REFERRAL','INVALID_REFERRAL','MISSING_INFORMATION','REFERRED_ELSEWHERE','CANCELLED','UNKNOWN')),
  resolution_source text CHECK (resolution_source IN ('CONNECTOR','CALLBACK','RECONCILIATION','STAFF','IMPORT','SYSTEM')),
  resolution_actor_id text,
  resolution_reference text,
  legacy_referral_state text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- A case is resolved exactly when it is terminal, and a resolution always
  -- carries its code, outcome time, source and actor.
  CONSTRAINT case_resolution_complete CHECK (
    (current_state IN ('BOOKED','CLOSED','REJECTED')) = (resolution_code IS NOT NULL)
    AND (resolution_code IS NULL OR (resolved_at IS NOT NULL AND outcome_at IS NOT NULL
         AND resolution_source IS NOT NULL AND resolution_actor_id IS NOT NULL))
    AND ((current_state = 'BOOKED') = (resolution_code IS NOT DISTINCT FROM 'BOOKED'))
    AND (current_state <> 'REJECTED' OR resolution_code IN ('INVALID_REFERRAL','DUPLICATE_REFERRAL','UNKNOWN'))
  )
);
CREATE INDEX access_cases_queue ON access_cases(tenant_id, current_state, opened_at);
CREATE INDEX access_cases_opened ON access_cases(tenant_id, opened_at);

INSERT INTO access_cases(id,tenant_id,case_type,source_channel,current_state,current_owner,exception_reason,
                         opened_at,resolved_at,outcome_at,resolution_code,resolution_source,resolution_actor_id,
                         legacy_referral_state,version,created_at,updated_at)
SELECT access_derived_uuid('access-case', r.tenant_id, r.id), r.tenant_id, 'REFERRAL', 'API',
       CASE r.state WHEN 'ADMIN_PENDING' THEN 'INFORMATION_MISSING'
                    WHEN 'DISPATCH_PENDING' THEN 'DESTINATION_PENDING'
                    WHEN 'RECONCILING' THEN 'DESTINATION_PENDING'
                    WHEN 'COMPLETED' THEN 'READY_FOR_BOOKING'
                    ELSE r.state END,
       CASE WHEN r.state IN ('DISPATCH_PENDING','RECONCILING','RECEIVED') THEN 'SYSTEM'
            WHEN r.state = 'REJECTED' THEN NULL
            ELSE 'REFERRAL_COORDINATOR' END,
       CASE WHEN r.state = 'EXCEPTION' THEN 'legacy_exception' END,
       r.created_at,
       CASE WHEN r.state = 'REJECTED' THEN r.updated_at END,
       CASE WHEN r.state = 'REJECTED' THEN r.updated_at END,
       CASE WHEN r.state = 'REJECTED' THEN 'UNKNOWN' END,
       CASE WHEN r.state = 'REJECTED' THEN 'SYSTEM' END,
       CASE WHEN r.state = 'REJECTED' THEN 'migration:0003' END,
       r.state, r.version, r.created_at, r.updated_at
FROM referrals r
ON CONFLICT (tenant_id, id) DO NOTHING;

-- Business-state history: the source for stage durations and stall analysis.
CREATE TABLE access_case_transitions(
  id bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  case_id uuid NOT NULL,
  from_state text,
  to_state text NOT NULL,
  version integer NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES access_cases(tenant_id, id)
);
CREATE INDEX access_case_transitions_case ON access_case_transitions(tenant_id, case_id, id);
INSERT INTO access_case_transitions(tenant_id,case_id,from_state,to_state,version,actor_type,actor_id,reason,occurred_at)
SELECT c.tenant_id, c.id, NULL, c.current_state, c.version, 'SYSTEM', 'migration:0003', 'migrated_from_legacy_referral', c.updated_at
FROM access_cases c WHERE c.legacy_referral_state IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM access_case_transitions t WHERE t.tenant_id=c.tenant_id AND t.case_id=c.id);

-- Referral becomes the referral-specific extension of its case.
ALTER TABLE referrals ADD COLUMN case_id uuid;
UPDATE referrals SET case_id = access_derived_uuid('access-case', tenant_id, id) WHERE case_id IS NULL;
ALTER TABLE referrals ALTER COLUMN case_id SET NOT NULL;
ALTER TABLE referrals ADD CONSTRAINT referrals_case_fk FOREIGN KEY (tenant_id, case_id) REFERENCES access_cases(tenant_id, id);
CREATE UNIQUE INDEX referrals_one_per_case ON referrals(tenant_id, case_id);
ALTER TABLE referrals RENAME COLUMN external_id TO destination_reference;
ALTER TABLE referrals
  ADD COLUMN referring_provider text,
  ADD COLUMN requested_service text,
  ADD COLUMN referral_date date,
  ADD COLUMN completeness_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (completeness_status IN ('UNKNOWN','COMPLETE','INCOMPLETE')),
  ADD COLUMN supplied_documents text[] NOT NULL DEFAULT '{}',
  ADD COLUMN supplied_fields jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN identity_confirmed_by text,
  ADD COLUMN rule_set_id uuid,
  ADD COLUMN rule_set_version integer,
  ADD COLUMN rule_decision jsonb,
  ADD COLUMN destination_mode text CHECK (destination_mode IN ('CONNECTOR','MANUAL')),
  ADD COLUMN destination_reference_source text CHECK (destination_reference_source IN ('CONNECTOR','MANUAL')),
  ADD COLUMN destination_committed_at timestamptz,
  ADD COLUMN outcome_next_poll_at timestamptz,
  ADD COLUMN follow_up_due_at timestamptz,
  ADD COLUMN follow_up_count integer NOT NULL DEFAULT 0;
UPDATE referrals SET destination_reference_source = 'CONNECTOR', destination_mode = 'CONNECTOR',
                     destination_committed_at = updated_at
 WHERE destination_reference IS NOT NULL;
-- Added after the backfill so legacy committed referrals satisfy it.
ALTER TABLE referrals ADD CONSTRAINT referral_destination_reference_sourced
  CHECK ((destination_reference IS NULL) = (destination_reference_source IS NULL));
-- Provider name is administrative, not patient data.
UPDATE referrals SET referring_provider = extraction->'referrer'->>'name' WHERE extraction IS NOT NULL;
UPDATE referrals SET completeness_status = CASE
    WHEN state = 'ADMIN_PENDING' THEN 'INCOMPLETE'
    WHEN state IN ('READY','DISPATCH_PENDING','RECONCILING','COMPLETED') THEN 'COMPLETE'
    ELSE 'UNKNOWN' END;
-- The legacy referral lifecycle is superseded by access_cases.current_state;
-- the original value is preserved in access_cases.legacy_referral_state.
DROP TRIGGER IF EXISTS referral_transition_guard ON referrals;
DROP FUNCTION IF EXISTS enforce_referral_transition();
ALTER TABLE referrals DROP COLUMN state, DROP COLUMN version;

-- Generic infrastructure identity: case_id + subject(type,id).
ALTER TABLE commands
  ADD COLUMN case_id uuid,
  ADD COLUMN subject_type text CHECK (subject_type IN ('referral','case')),
  ADD COLUMN subject_id uuid,
  ADD COLUMN command_type text,
  ADD COLUMN request_hash text CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN actor_type text,
  ADD COLUMN actor_id text,
  ADD COLUMN actor_role text;
UPDATE commands SET case_id = access_derived_uuid('access-case', tenant_id, referral_id),
                    subject_type = 'referral', subject_id = referral_id, command_type = 'legacy.v1'
 WHERE case_id IS NULL;
ALTER TABLE commands ALTER COLUMN referral_id DROP NOT NULL;
ALTER TABLE commands ALTER COLUMN command_type SET NOT NULL;
ALTER TABLE commands ADD CONSTRAINT commands_case_fk FOREIGN KEY (tenant_id, case_id) REFERENCES access_cases(tenant_id, id);

ALTER TABLE evidence_events
  ADD COLUMN case_id uuid,
  ADD COLUMN subject_type text CHECK (subject_type IN ('referral','case')),
  ADD COLUMN subject_id uuid,
  ADD COLUMN actor_type text,
  ADD COLUMN actor_id text,
  ADD COLUMN hash_version smallint NOT NULL DEFAULT 1 CHECK (hash_version IN (1,2));
UPDATE evidence_events SET case_id = access_derived_uuid('access-case', tenant_id, referral_id),
                           subject_type = 'referral', subject_id = referral_id
 WHERE case_id IS NULL;
ALTER TABLE evidence_events ALTER COLUMN case_id SET NOT NULL;
ALTER TABLE evidence_events ALTER COLUMN referral_id DROP NOT NULL;
ALTER TABLE evidence_events ALTER COLUMN hash_version DROP DEFAULT;
ALTER TABLE evidence_events DROP CONSTRAINT evidence_events_tenant_id_referral_id_sequence_key;
CREATE UNIQUE INDEX evidence_case_sequence ON evidence_events(tenant_id, case_id, sequence);
CREATE INDEX evidence_referral ON evidence_events(tenant_id, referral_id) WHERE referral_id IS NOT NULL;
ALTER TABLE evidence_events ADD CONSTRAINT evidence_case_fk FOREIGN KEY (tenant_id, case_id) REFERENCES access_cases(tenant_id, id);
ALTER TABLE evidence_events ADD CONSTRAINT evidence_v2_attributed CHECK (hash_version = 1 OR (subject_type IS NOT NULL AND subject_id IS NOT NULL AND actor_type IS NOT NULL AND actor_id IS NOT NULL));

ALTER TABLE work_items
  ADD COLUMN case_id uuid,
  ADD COLUMN owner_role text CHECK (owner_role IN ('ADMIN','PRACTICE_MANAGER','REFERRAL_COORDINATOR')),
  ADD COLUMN resolved_by text,
  ADD COLUMN due_at timestamptz;
UPDATE work_items SET case_id = access_derived_uuid('access-case', tenant_id, referral_id) WHERE case_id IS NULL;
UPDATE work_items SET owner_role = CASE WHEN kind = 'SAFETY' THEN 'PRACTICE_MANAGER' ELSE 'REFERRAL_COORDINATOR' END WHERE owner_role IS NULL;
ALTER TABLE work_items ALTER COLUMN case_id SET NOT NULL;
ALTER TABLE work_items ALTER COLUMN referral_id DROP NOT NULL;
ALTER TABLE work_items ADD CONSTRAINT work_items_case_fk FOREIGN KEY (tenant_id, case_id) REFERENCES access_cases(tenant_id, id);
ALTER TABLE work_items ADD CONSTRAINT work_items_kind_check CHECK (kind IN ('IDENTITY','COMPLETENESS','SAFETY','FILE_SAFETY','CONNECTOR','MANUAL_DESTINATION','OUTCOME_REVIEW','FOLLOW_UP','ESCALATION'));
ALTER TABLE work_items ADD CONSTRAINT work_items_resolution_complete CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL));
-- Legacy replays could open duplicate items; keep the earliest open item of
-- each kind per case and resolve the rest with an explicit marker.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY tenant_id, case_id, kind ORDER BY created_at, id) AS n
  FROM work_items WHERE status = 'OPEN')
UPDATE work_items w SET status = 'RESOLVED', resolved_at = now(), resolved_by = 'migration:0003',
       resolution = jsonb_build_object('resolution','duplicate_merged_by_migration_0003')
  FROM ranked WHERE ranked.id = w.id AND ranked.n > 1;
DROP INDEX IF EXISTS one_open_connector_work_item;
CREATE UNIQUE INDEX one_open_work_item_per_kind ON work_items(tenant_id, case_id, kind) WHERE status = 'OPEN';
CREATE INDEX work_items_case ON work_items(tenant_id, case_id, created_at);

ALTER TABLE executions
  ADD COLUMN case_id uuid,
  ADD COLUMN subject_type text CHECK (subject_type IN ('referral','case')),
  ADD COLUMN subject_id uuid,
  ADD COLUMN operation text NOT NULL DEFAULT 'referral.create',
  ADD COLUMN correlation_id uuid,
  ADD COLUMN escalated_at timestamptz,
  ADD COLUMN reconcile_lease_until timestamptz,
  -- Set only by an audited staff decision (manual destination reference, or a
  -- retry after attesting the foreign effect is absent).
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN superseded_by text,
  ADD COLUMN superseded_reason text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
UPDATE executions SET case_id = access_derived_uuid('access-case', tenant_id, referral_id),
                      subject_type = 'referral', subject_id = referral_id WHERE case_id IS NULL;
UPDATE executions e SET correlation_id = o.correlation_id FROM outbox o
 WHERE o.tenant_id = e.tenant_id AND o.execution_id = e.id AND e.correlation_id IS NULL;
-- DEFERRED was a result, not an execution status: the connector refused to act.
UPDATE executions SET status = 'PERMANENT', last_error = coalesce(last_error, 'DEFERRED') WHERE status = 'DEFERRED';
UPDATE executions SET status = 'PERMANENT' WHERE status NOT IN ('PENDING','LEASED','RETRYABLE','AMBIGUOUS','RECONCILING','SUCCEEDED','PERMANENT','POISON');
ALTER TABLE executions ALTER COLUMN case_id SET NOT NULL;
ALTER TABLE executions ALTER COLUMN referral_id DROP NOT NULL;
ALTER TABLE executions ADD CONSTRAINT executions_status_check CHECK (status IN ('PENDING','LEASED','RETRYABLE','AMBIGUOUS','RECONCILING','SUCCEEDED','PERMANENT','POISON'));
ALTER TABLE executions ADD CONSTRAINT executions_case_fk FOREIGN KEY (tenant_id, case_id) REFERENCES access_cases(tenant_id, id);
ALTER TABLE executions ADD CONSTRAINT executions_succeeded_has_reference CHECK (status <> 'SUCCEEDED' OR external_id IS NOT NULL);
CREATE INDEX executions_reconcile_due ON executions(tenant_id, status, next_reconcile_at) WHERE status IN ('AMBIGUOUS','RECONCILING') AND escalated_at IS NULL;
CREATE INDEX executions_case ON executions(tenant_id, case_id);

ALTER TABLE outbox
  ADD COLUMN case_id uuid,
  ADD COLUMN subject_type text CHECK (subject_type IN ('referral','case')),
  ADD COLUMN subject_id uuid,
  ADD COLUMN operation text NOT NULL DEFAULT 'referral.create';
UPDATE outbox SET case_id = access_derived_uuid('access-case', tenant_id, referral_id),
                  subject_type = 'referral', subject_id = referral_id WHERE case_id IS NULL;
ALTER TABLE outbox ALTER COLUMN case_id SET NOT NULL;
ALTER TABLE outbox ALTER COLUMN subject_type SET NOT NULL;
ALTER TABLE outbox ALTER COLUMN subject_id SET NOT NULL;
ALTER TABLE outbox ALTER COLUMN referral_id DROP NOT NULL;
ALTER TABLE outbox ADD CONSTRAINT outbox_case_fk FOREIGN KEY (tenant_id, case_id) REFERENCES access_cases(tenant_id, id);
CREATE INDEX outbox_case_order ON outbox(tenant_id, case_id, aggregate_version) WHERE status IN ('PENDING','LEASED');

ALTER TABLE artifacts
  ADD COLUMN case_id uuid,
  ADD COLUMN interaction_id uuid,
  ADD COLUMN document_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN storage_backend text NOT NULL DEFAULT 'local-encrypted' CHECK (storage_backend IN ('local-encrypted','supabase-storage','none')),
  ADD COLUMN object_version text,
  ADD COLUMN scanner text NOT NULL DEFAULT 'legacy-placeholder',
  ADD COLUMN scanned_at timestamptz,
  ADD COLUMN retention_until timestamptz,
  ADD COLUMN deleted_at timestamptz;
UPDATE artifacts SET case_id = access_derived_uuid('access-case', tenant_id, referral_id), scanned_at = created_at WHERE case_id IS NULL;
ALTER TABLE artifacts ALTER COLUMN case_id SET NOT NULL;
ALTER TABLE artifacts ALTER COLUMN referral_id DROP NOT NULL;
ALTER TABLE artifacts ALTER COLUMN object_key DROP NOT NULL;
ALTER TABLE artifacts DROP CONSTRAINT artifacts_scan_status_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_scan_status_check CHECK (scan_status IN ('PENDING','CLEAN','REJECTED','ERROR'));
-- Only clean content is ever stored; rejected content is recorded, not kept.
ALTER TABLE artifacts ADD CONSTRAINT artifacts_stored_only_if_clean CHECK ((object_key IS NOT NULL) = (scan_status = 'CLEAN' AND storage_backend <> 'none') OR deleted_at IS NOT NULL);
ALTER TABLE artifacts ADD CONSTRAINT artifacts_case_fk FOREIGN KEY (tenant_id, case_id) REFERENCES access_cases(tenant_id, id);
ALTER TABLE artifacts DROP CONSTRAINT artifacts_tenant_id_referral_id_digest_sha256_key;
CREATE UNIQUE INDEX artifacts_case_digest ON artifacts(tenant_id, case_id, digest_sha256);
CREATE UNIQUE INDEX artifacts_object_key ON artifacts(object_key) WHERE object_key IS NOT NULL;

-- Case lifecycle guard; mirrors packages/domain CASE_TRANSITIONS.
CREATE OR REPLACE FUNCTION enforce_case_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.current_state = NEW.current_state THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.current_state='RECEIVED' AND NEW.current_state IN ('IDENTITY_PENDING','INFORMATION_MISSING','READY','DESTINATION_PENDING','EXCEPTION','REJECTED')) OR
    (OLD.current_state='IDENTITY_PENDING' AND NEW.current_state IN ('INFORMATION_MISSING','READY','DESTINATION_PENDING','EXCEPTION','REJECTED','CLOSED')) OR
    (OLD.current_state='INFORMATION_MISSING' AND NEW.current_state IN ('IDENTITY_PENDING','READY','DESTINATION_PENDING','EXCEPTION','REJECTED','CLOSED')) OR
    (OLD.current_state='READY' AND NEW.current_state IN ('DESTINATION_PENDING','READY_FOR_BOOKING','EXCEPTION','CLOSED')) OR
    (OLD.current_state='DESTINATION_PENDING' AND NEW.current_state IN ('READY_FOR_BOOKING','EXCEPTION')) OR
    (OLD.current_state='READY_FOR_BOOKING' AND NEW.current_state IN ('WAITING','BOOKED','CLOSED','EXCEPTION')) OR
    (OLD.current_state='WAITING' AND NEW.current_state IN ('READY_FOR_BOOKING','BOOKED','CLOSED','EXCEPTION')) OR
    (OLD.current_state='EXCEPTION' AND NEW.current_state IN ('IDENTITY_PENDING','INFORMATION_MISSING','READY','DESTINATION_PENDING','READY_FOR_BOOKING','REJECTED','CLOSED')) OR
    (OLD.current_state='BOOKED' AND NEW.current_state = 'CLOSED') OR
    (OLD.current_state='CLOSED' AND NEW.current_state = 'BOOKED')) THEN
    RAISE EXCEPTION 'invalid case transition % -> %', OLD.current_state, NEW.current_state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'case transition must increment version exactly once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_transition_guard BEFORE UPDATE OF current_state ON access_cases
  FOR EACH ROW EXECUTE FUNCTION enforce_case_transition();
-- Case type and tenant never change after creation.
CREATE OR REPLACE FUNCTION enforce_case_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.case_type <> OLD.case_type OR NEW.opened_at <> OLD.opened_at THEN
    RAISE EXCEPTION 'case identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'case version cannot decrease' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_identity_guard BEFORE UPDATE ON access_cases
  FOR EACH ROW EXECUTE FUNCTION enforce_case_identity();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['access_cases','access_case_transitions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
  END LOOP;
END $$;
