BEGIN;
ALTER TABLE evidence_events ADD COLUMN IF NOT EXISTS aggregate_version integer;
UPDATE evidence_events SET aggregate_version=sequence WHERE aggregate_version IS NULL;
ALTER TABLE evidence_events ALTER COLUMN aggregate_version SET NOT NULL;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS reconcile_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS first_ambiguous_at timestamptz;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS last_reconcile_at timestamptz;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS next_reconcile_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_connector_work_item ON work_items(tenant_id,referral_id,kind) WHERE status='OPEN' AND kind='CONNECTOR';
CREATE OR REPLACE FUNCTION enforce_referral_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state=NEW.state THEN RETURN NEW; END IF;
  IF NOT ((OLD.state='RECEIVED' AND NEW.state IN ('IDENTITY_PENDING','ADMIN_PENDING','READY','DISPATCH_PENDING','EXCEPTION')) OR
          (OLD.state='IDENTITY_PENDING' AND NEW.state IN ('ADMIN_PENDING','READY','DISPATCH_PENDING','REJECTED')) OR
          (OLD.state='ADMIN_PENDING' AND NEW.state IN ('READY','DISPATCH_PENDING','REJECTED')) OR
          (OLD.state='READY' AND NEW.state='DISPATCH_PENDING') OR
          (OLD.state='DISPATCH_PENDING' AND NEW.state IN ('COMPLETED','RECONCILING','EXCEPTION')) OR
          (OLD.state='RECONCILING' AND NEW.state IN ('COMPLETED','EXCEPTION')) OR
          (OLD.state='EXCEPTION' AND NEW.state IN ('READY','REJECTED'))) THEN
    RAISE EXCEPTION 'invalid referral transition % -> %',OLD.state,NEW.state USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS referral_transition_guard ON referrals;
CREATE TRIGGER referral_transition_guard BEFORE UPDATE OF state ON referrals FOR EACH ROW EXECUTE FUNCTION enforce_referral_transition();
ALTER ROLE access_request NOSUPERUSER NOBYPASSRLS NOINHERIT;
ALTER ROLE access_worker NOSUPERUSER NOBYPASSRLS NOINHERIT;
REVOKE ALL ON executions,outbox FROM access_request;
GRANT SELECT ON executions,outbox TO access_request;
REVOKE ALL ON artifacts,commands FROM access_worker;
GRANT SELECT,INSERT,UPDATE ON referrals,evidence_events,work_items,executions,outbox TO access_worker;
INSERT INTO schema_migrations(version) VALUES('0002_staging_hardening') ON CONFLICT DO NOTHING;
COMMIT;
