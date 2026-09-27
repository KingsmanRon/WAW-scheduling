-- 0005: workforce membership, administrative audit log, append-only
-- evidence/commands, and the complete least-privilege grant matrix.
-- Applied inside the runner transaction.

CREATE TABLE organisation_memberships(
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  -- Subject of the verified workforce JWT (Supabase Auth user id).
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('ADMIN','PRACTICE_MANAGER','REFERRAL_COORDINATOR','READ_ONLY')),
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX organisation_memberships_user ON organisation_memberships(user_id) WHERE status = 'ACTIVE';

CREATE TABLE access_audit_log(
  id bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  actor_role text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TRIGGER access_audit_log_append_only BEFORE UPDATE OR DELETE ON access_audit_log
  FOR EACH ROW EXECUTE FUNCTION access_forbid_mutation();

-- Evidence and command records are immutable facts. (A superuser can still
-- bypass triggers; the hash chain detects that - see verifyEvidenceChain.)
DROP TRIGGER IF EXISTS evidence_events_append_only ON evidence_events;
CREATE TRIGGER evidence_events_append_only BEFORE UPDATE OR DELETE ON evidence_events
  FOR EACH ROW EXECUTE FUNCTION access_forbid_mutation();
DROP TRIGGER IF EXISTS commands_append_only ON commands;
CREATE TRIGGER commands_append_only BEFORE UPDATE OR DELETE ON commands
  FOR EACH ROW EXECUTE FUNCTION access_forbid_mutation();
DROP TRIGGER IF EXISTS access_case_transitions_append_only ON access_case_transitions;
CREATE TRIGGER access_case_transitions_append_only BEFORE UPDATE OR DELETE ON access_case_transitions
  FOR EACH ROW EXECUTE FUNCTION access_forbid_mutation();

-- TRUNCATE bypasses row triggers; forbid it on every append-only table.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['evidence_events','commands','access_case_transitions','access_interactions',
                           'access_case_observations','case_effort_events','access_audit_log'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION access_forbid_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Row-level security. Memberships are readable by their own user (to resolve
-- the tenant from a verified JWT) and by the tenant; only an ADMIN request
-- context may write them. Rule sets are likewise ADMIN-write.
ALTER TABLE organisation_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY membership_self_read ON organisation_memberships FOR SELECT
  USING (user_id = nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY membership_tenant_read ON organisation_memberships FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY membership_admin_insert ON organisation_memberships FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid
              AND current_setting('app.actor_role',true) = 'ADMIN');
CREATE POLICY membership_admin_update ON organisation_memberships FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid
         AND current_setting('app.actor_role',true) = 'ADMIN')
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid
              AND current_setting('app.actor_role',true) = 'ADMIN');

DROP POLICY IF EXISTS tenant_isolation ON access_rule_sets;
CREATE POLICY rule_set_tenant_read ON access_rule_sets FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY rule_set_admin_insert ON access_rule_sets FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid
              AND current_setting('app.actor_role',true) = 'ADMIN');
CREATE POLICY rule_set_admin_update ON access_rule_sets FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid
         AND current_setting('app.actor_role',true) = 'ADMIN')
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid
              AND current_setting('app.actor_role',true) = 'ADMIN');

ALTER TABLE access_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_audit_log
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['referrals','artifacts','commands','evidence_events','work_items','executions','outbox',
                           'access_cases','access_case_transitions','access_interactions','access_case_observations',
                           'case_effort_events','access_rule_sets','organisation_memberships','access_audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Least-privilege matrix. Everything is revoked and granted explicitly so the
-- effective privileges are exactly what this block states.
ALTER ROLE access_request NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE access_worker NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM access_request, access_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM access_request, access_worker;
GRANT USAGE ON SCHEMA public TO access_request, access_worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO access_request, access_worker;

-- API (access_request): commands, intake, staff actions, enqueue only.
GRANT SELECT ON organisations TO access_request;
GRANT SELECT, INSERT, UPDATE ON access_cases, referrals, work_items, access_case_observations,
  access_rule_sets, organisation_memberships TO access_request;
GRANT SELECT, INSERT ON artifacts, commands, evidence_events, access_interactions, case_effort_events,
  access_case_transitions, access_audit_log, outbox, executions TO access_request;
-- The API may only mark an escalated execution as superseded by a staff decision.
GRANT UPDATE (superseded_at, superseded_by, superseded_reason) ON executions TO access_request;

-- Worker (access_worker): dispatch, reconciliation, readback, timers.
GRANT SELECT ON organisations, access_rule_sets TO access_worker;
GRANT SELECT, UPDATE ON access_cases, referrals, outbox TO access_worker;
GRANT SELECT, INSERT, UPDATE ON executions, work_items, access_case_observations TO access_worker;
GRANT SELECT, INSERT ON evidence_events, access_case_transitions, case_effort_events TO access_worker;
