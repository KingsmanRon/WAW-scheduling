-- 0004: immutable interactions, outcome observations, effort events and
-- versioned administrative rule sets. Applied inside the runner transaction.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Shared append-only guard.
CREATE OR REPLACE FUNCTION access_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TABLE access_interactions(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  case_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('STAFF_UPLOAD','API','EMAIL','WHATSAPP','VOICE','PATIENT_PORTAL')),
  direction text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  actor_type text NOT NULL CHECK (actor_type IN ('STAFF','SYSTEM','INTEGRATION','CONNECTOR','PATIENT','PROVIDER')),
  actor_id text NOT NULL,
  intent text NOT NULL CHECK (intent IN ('NEW_REFERRAL','MISSING_INFORMATION','STATUS_ENQUIRY','FOLLOW_UP','OUTCOME_REPORT','APPOINTMENT_REQUEST','CANCELLATION_REQUEST','RESCHEDULING_REQUEST','OTHER')),
  received_at timestamptz NOT NULL,
  content_reference uuid,
  identity_verification_level text NOT NULL CHECK (identity_verification_level IN ('NONE','CLAIMED','STAFF_VERIFIED','SYSTEM_VERIFIED')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  command_id uuid,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES access_cases(tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX access_interactions_case ON access_interactions(tenant_id, case_id, received_at);
CREATE TRIGGER access_interactions_append_only BEFORE UPDATE OR DELETE ON access_interactions
  FOR EACH ROW EXECUTE FUNCTION access_forbid_mutation();

CREATE TABLE access_case_observations(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  case_id uuid NOT NULL,
  observation_type text NOT NULL CHECK (observation_type IN ('REFERRAL_RECEIVED','REFERRAL_VERIFIED','REFERRAL_READY','DESTINATION_COMMITTED','BOOKING_REQUESTED','APPOINTMENT_BOOKED','APPOINTMENT_CANCELLED','PATIENT_UNREACHABLE','PROVIDER_DECLINED','PATIENT_DECLINED','REFERRAL_CLOSED')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source_type text NOT NULL CHECK (source_type IN ('CONNECTOR','CALLBACK','RECONCILIATION','STAFF','IMPORT','SYSTEM')),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 200),
  verification_level text NOT NULL CHECK (verification_level IN ('OBSERVED','EXTERNAL_CONFIRMED','HUMAN_ATTESTED','DERIVED','UNKNOWN')),
  actor_id text,
  payload jsonb NOT NULL DEFAULT '{}',
  correlation_id uuid NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('APPLIED','RECORDED','PENDING','REVIEW','SUPERSEDED')),
  disposition_reason text,
  applied_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES access_cases(tenant_id, id),
  -- Replays of the same external fact are idempotent.
  UNIQUE (tenant_id, case_id, observation_type, source_type, source_reference),
  -- A human-entered fact is never presented as machine-verified.
  CONSTRAINT observation_staff_is_attested CHECK (source_type <> 'STAFF' OR verification_level = 'HUMAN_ATTESTED'),
  CONSTRAINT observation_staff_has_actor CHECK (source_type NOT IN ('STAFF','IMPORT') OR actor_id IS NOT NULL),
  CONSTRAINT observation_applied_time CHECK ((disposition = 'APPLIED') = (applied_at IS NOT NULL))
);
CREATE INDEX access_case_observations_case ON access_case_observations(tenant_id, case_id, occurred_at);
CREATE INDEX access_case_observations_pending ON access_case_observations(tenant_id, case_id) WHERE disposition = 'PENDING';
-- Observations are facts. The only permitted change is settling a PENDING
-- observation once the case reaches a state where it can be applied.
CREATE OR REPLACE FUNCTION access_observation_settle_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'access_case_observations is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.disposition <> 'PENDING'
     OR NEW.disposition NOT IN ('APPLIED','REVIEW','SUPERSEDED','RECORDED')
     OR (to_jsonb(NEW) - 'disposition' - 'disposition_reason' - 'applied_at')
        IS DISTINCT FROM (to_jsonb(OLD) - 'disposition' - 'disposition_reason' - 'applied_at') THEN
    RAISE EXCEPTION 'access_case_observations is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER access_case_observations_settle_only BEFORE UPDATE OR DELETE ON access_case_observations
  FOR EACH ROW EXECUTE FUNCTION access_observation_settle_only();

CREATE TABLE case_effort_events(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  case_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('WORK_ITEM_OPENED','WORK_ITEM_RESOLVED','MANUAL_CORRECTION','STATUS_CONTACT','FOLLOW_UP','MANUAL_DESTINATION_ACTION','OUTCOME_RECORDED')),
  seconds integer CHECK (seconds IS NULL OR seconds BETWEEN 1 AND 86400),
  source text NOT NULL CHECK (source IN ('STAFF','SYSTEM','INTEGRATION')),
  actor_id text,
  work_item_id uuid,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES access_cases(tenant_id, id),
  CONSTRAINT effort_staff_has_actor CHECK (source <> 'STAFF' OR actor_id IS NOT NULL)
);
CREATE INDEX case_effort_events_case ON case_effort_events(tenant_id, case_id, created_at);
CREATE UNIQUE INDEX case_effort_events_command ON case_effort_events(tenant_id, command_id, type) WHERE command_id IS NOT NULL;
CREATE TRIGGER case_effort_events_append_only BEFORE UPDATE OR DELETE ON case_effort_events
  FOR EACH ROW EXECUTE FUNCTION access_forbid_mutation();

CREATE TABLE access_rule_sets(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  case_type text NOT NULL DEFAULT 'REFERRAL' CHECK (case_type = 'REFERRAL'),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  effective_from timestamptz,
  effective_to timestamptz,
  published_by text,
  published_at timestamptz,
  created_by text NOT NULL,
  definition jsonb NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, case_type, version),
  CONSTRAINT rule_set_window CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from),
  CONSTRAINT rule_set_published CHECK (status = 'DRAFT' OR (effective_from IS NOT NULL AND published_by IS NOT NULL AND published_at IS NOT NULL)),
  -- One applicable ACTIVE version per tenant and instant.
  CONSTRAINT rule_set_single_active EXCLUDE USING gist (
    tenant_id WITH =, case_type WITH =,
    tstzrange(effective_from, coalesce(effective_to, 'infinity'::timestamptz), '[)') WITH &&
  ) WHERE (status = 'ACTIVE')
);
-- Published versions are immutable: only status DRAFT->ACTIVE->RETIRED and
-- closing an open effective window are allowed; a change is a new version.
CREATE OR REPLACE FUNCTION access_rule_set_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'published rule sets cannot be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.case_type <> OLD.case_type
     OR NEW.version <> OLD.version OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'rule set identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status NOT IN ('DRAFT','ACTIVE') THEN
      RAISE EXCEPTION 'a draft can only be published' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.definition IS DISTINCT FROM OLD.definition OR NEW.definition_hash <> OLD.definition_hash
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.published_by IS DISTINCT FROM OLD.published_by
     OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'published rule set versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT ((OLD.status = 'ACTIVE' AND NEW.status IN ('ACTIVE','RETIRED')) OR (OLD.status = 'RETIRED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'invalid rule set status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'a closed effective window cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER access_rule_set_immutable BEFORE UPDATE OR DELETE ON access_rule_sets
  FOR EACH ROW EXECUTE FUNCTION access_rule_set_immutable();
ALTER TABLE referrals ADD CONSTRAINT referrals_rule_set_fk FOREIGN KEY (tenant_id, rule_set_id) REFERENCES access_rule_sets(tenant_id, id);

-- Legacy backfill. Facts that were not observed are marked DERIVED; the
-- timestamps come from the legacy rows, nothing is invented.
INSERT INTO access_interactions(tenant_id,case_id,channel,direction,actor_type,actor_id,intent,received_at,content_reference,identity_verification_level,idempotency_key,correlation_id,created_at)
SELECT c.tenant_id, c.id, 'API', 'INBOUND', 'STAFF', 'legacy:local-uploader', 'NEW_REFERRAL', c.opened_at,
       (SELECT a.id FROM artifacts a WHERE a.tenant_id = c.tenant_id AND a.case_id = c.id ORDER BY a.created_at LIMIT 1),
       'NONE', 'legacy-referral:' || r.id::text, c.id, c.opened_at
FROM access_cases c JOIN referrals r ON r.tenant_id = c.tenant_id AND r.case_id = c.id
WHERE c.legacy_referral_state IS NOT NULL
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
INSERT INTO access_case_observations(tenant_id,case_id,observation_type,occurred_at,recorded_at,source_type,source_reference,verification_level,payload,correlation_id,disposition,disposition_reason)
SELECT tenant_id, id, 'REFERRAL_RECEIVED', opened_at, now(), 'SYSTEM', 'milestone', 'DERIVED', '{"backfill":"0004"}', id, 'RECORDED', 'milestone'
FROM access_cases WHERE legacy_referral_state IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO access_case_observations(tenant_id,case_id,observation_type,occurred_at,recorded_at,source_type,source_reference,verification_level,payload,correlation_id,disposition,disposition_reason)
SELECT c.tenant_id, c.id, 'DESTINATION_COMMITTED', r.destination_committed_at, now(), 'SYSTEM', 'milestone', 'DERIVED', '{"backfill":"0004"}', c.id, 'RECORDED', 'milestone'
FROM access_cases c JOIN referrals r ON r.tenant_id = c.tenant_id AND r.case_id = c.id
WHERE c.legacy_referral_state IS NOT NULL AND r.destination_reference IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE artifacts a SET interaction_id = i.id
  FROM access_interactions i
 WHERE i.tenant_id = a.tenant_id AND i.content_reference = a.id AND a.interaction_id IS NULL;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['access_interactions','access_case_observations','case_effort_events','access_rule_sets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
  END LOOP;
END $$;
