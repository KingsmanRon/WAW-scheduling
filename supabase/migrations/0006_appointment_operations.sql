-- 0006: appointment operations (availability, holds, booking, confirmation,
-- rescheduling, cancellation). Applied by the ledger runner inside one
-- transaction with its schema_migrations row; no BEGIN/COMMIT here.
--
-- Additive only: three new tenant tables, widened vocabulary and a
-- case-type-aware transition guard. No existing row is rewritten, no table is
-- rebuilt and no existing privilege is widened.

-- ---------------------------------------------------------------------------
-- 1. Vocabulary. Constraints are replaced by supersets of themselves.
-- ---------------------------------------------------------------------------

-- A request withdrawn before it took effect (nothing external changed).
ALTER TABLE access_cases DROP CONSTRAINT access_cases_resolution_code_check;
ALTER TABLE access_cases ADD CONSTRAINT access_cases_resolution_code_check
  CHECK (resolution_code IN ('BOOKED','PATIENT_UNREACHABLE','PATIENT_DECLINED','PROVIDER_DECLINED','DUPLICATE_REFERRAL',
                             'INVALID_REFERRAL','MISSING_INFORMATION','REFERRED_ELSEWHERE','CANCELLED','UNKNOWN','WITHDRAWN'));
ALTER TABLE access_cases ADD CONSTRAINT case_withdrawn_is_request
  CHECK (resolution_code IS DISTINCT FROM 'WITHDRAWN'
         OR case_type IN ('APPOINTMENT_REQUEST','RESCHEDULING_REQUEST','CANCELLATION_REQUEST'));
-- Appointment operations cases never enter the referral-only states, and a
-- cancellation request closes; it never books anything.
ALTER TABLE access_cases ADD CONSTRAINT appointment_case_states
  CHECK (case_type NOT IN ('APPOINTMENT_REQUEST','RESCHEDULING_REQUEST','CANCELLATION_REQUEST')
         OR current_state IN ('RECEIVED','READY_FOR_BOOKING','WAITING','BOOKED','CLOSED','EXCEPTION'));
ALTER TABLE access_cases ADD CONSTRAINT cancellation_request_never_booked
  CHECK (case_type <> 'CANCELLATION_REQUEST' OR current_state <> 'BOOKED');
-- Lets extension tables bind to a case of one specific type.
ALTER TABLE access_cases ADD CONSTRAINT access_cases_typed_key UNIQUE (tenant_id, id, case_type);

-- BLOCKED: a step pre-authorised by a staff command (the later steps of a
-- reschedule) that the worker releases only after the previous step is
-- verified. The claim query never selects it.
ALTER TABLE outbox DROP CONSTRAINT outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('PENDING','LEASED','DONE','POISON','BLOCKED'));

-- ---------------------------------------------------------------------------
-- 2. Case lifecycle guard. Referral transitions are unchanged; appointment
--    operations cases get their own, narrower table (mirrors
--    packages/domain APPOINTMENT_CASE_TRANSITIONS).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_case_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.current_state = NEW.current_state THEN RETURN NEW; END IF;
  IF NEW.case_type IN ('APPOINTMENT_REQUEST','RESCHEDULING_REQUEST','CANCELLATION_REQUEST') THEN
    IF NOT (
      (OLD.current_state='RECEIVED' AND NEW.current_state IN ('READY_FOR_BOOKING','WAITING','EXCEPTION','CLOSED')) OR
      (OLD.current_state='READY_FOR_BOOKING' AND NEW.current_state IN ('WAITING','EXCEPTION','CLOSED')) OR
      (OLD.current_state='WAITING' AND NEW.current_state IN ('READY_FOR_BOOKING','BOOKED','EXCEPTION','CLOSED')) OR
      (OLD.current_state='EXCEPTION' AND NEW.current_state IN ('READY_FOR_BOOKING','WAITING','BOOKED','CLOSED'))) THEN
      RAISE EXCEPTION 'invalid case transition % -> %', OLD.current_state, NEW.current_state USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NOT (
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

-- ---------------------------------------------------------------------------
-- 3. Appointment request: the extension of APPOINTMENT_REQUEST,
--    RESCHEDULING_REQUEST and CANCELLATION_REQUEST cases.
-- ---------------------------------------------------------------------------

CREATE TABLE appointment_requests(
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  case_id uuid NOT NULL,
  case_type text NOT NULL CHECK (case_type IN ('APPOINTMENT_REQUEST','RESCHEDULING_REQUEST','CANCELLATION_REQUEST')),
  -- The referral this booking serves (always set for APPOINTMENT_REQUEST).
  origin_referral_case_id uuid,
  -- The committed appointment a reschedule or cancellation acts on.
  original_appointment_id uuid,
  -- The appointment this request committed (booking, or replacement B).
  appointment_id uuid,
  -- Administrative booking context (destination referral reference, patient
  -- reference, service, routing). No names or dates of birth.
  booking_context jsonb NOT NULL,
  search jsonb,
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  workflow_status text NOT NULL CHECK (workflow_status IN (
    'AVAILABILITY_REQUESTED','AVAILABILITY_RETURNED','NO_AVAILABILITY','SLOT_SELECTED','HOLD_REQUESTED','HELD',
    'BOOKING_SUBMITTED','COMMITTED','BOOKED','REPLACEMENT_BOOKED','ORIGINAL_CANCELLATION_PENDING','COMPLETED',
    'CANCELLATION_REQUESTED','CANCELLATION_SUBMITTED','CANCELLED','WITHDRAWN')),
  -- Latest availability snapshot returned by the destination (a read, not a
  -- reservation) and when it was observed.
  availability jsonb,
  availability_observed_at timestamptz,
  selected_slot jsonb,
  selected_slot_reference text,
  selected_at timestamptz,
  current_hold_id uuid,
  -- The one execution whose settlement may move this workflow.
  pending_execution_id uuid,
  cancellation_reason text CHECK (cancellation_reason IN ('PATIENT_REQUEST','PROVIDER_REQUEST','DUPLICATE_BOOKING','ADMINISTRATIVE')),
  last_failure_code text CHECK (last_failure_code ~ '^[A-Z0-9_]{2,64}$'),
  last_failure_at timestamptz,
  recheck_requested_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, case_id),
  FOREIGN KEY (tenant_id, case_id, case_type) REFERENCES access_cases(tenant_id, id, case_type),
  FOREIGN KEY (tenant_id, origin_referral_case_id) REFERENCES access_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, pending_execution_id) REFERENCES executions(tenant_id, id),
  CONSTRAINT appointment_request_shape CHECK (
    (case_type = 'APPOINTMENT_REQUEST' AND origin_referral_case_id IS NOT NULL AND original_appointment_id IS NULL
      AND cancellation_reason IS NULL
      AND workflow_status IN ('AVAILABILITY_REQUESTED','AVAILABILITY_RETURNED','NO_AVAILABILITY','SLOT_SELECTED',
                              'HOLD_REQUESTED','HELD','BOOKING_SUBMITTED','COMMITTED','BOOKED','WITHDRAWN'))
    OR (case_type = 'RESCHEDULING_REQUEST' AND original_appointment_id IS NOT NULL AND cancellation_reason IS NULL
      AND workflow_status IN ('AVAILABILITY_REQUESTED','AVAILABILITY_RETURNED','NO_AVAILABILITY','SLOT_SELECTED',
                              'HOLD_REQUESTED','HELD','BOOKING_SUBMITTED','REPLACEMENT_BOOKED',
                              'ORIGINAL_CANCELLATION_PENDING','COMPLETED','WITHDRAWN'))
    OR (case_type = 'CANCELLATION_REQUEST' AND original_appointment_id IS NOT NULL AND appointment_id IS NULL
      AND cancellation_reason IS NOT NULL
      AND workflow_status IN ('CANCELLATION_REQUESTED','CANCELLATION_SUBMITTED','CANCELLED','WITHDRAWN'))),
  CONSTRAINT appointment_request_selection CHECK (
    workflow_status NOT IN ('SLOT_SELECTED','HOLD_REQUESTED','HELD','BOOKING_SUBMITTED')
    OR (selected_slot_reference IS NOT NULL AND selected_slot IS NOT NULL)),
  CONSTRAINT appointment_request_committed CHECK (
    workflow_status NOT IN ('COMMITTED','BOOKED','REPLACEMENT_BOOKED','ORIGINAL_CANCELLATION_PENDING','COMPLETED')
    OR appointment_id IS NOT NULL),
  CONSTRAINT appointment_request_availability_time CHECK ((availability IS NULL) = (availability_observed_at IS NULL))
);
-- One active booking per referral, one active change per appointment, and
-- an execution settles at most one request.
CREATE UNIQUE INDEX appointment_requests_one_active_booking ON appointment_requests(tenant_id, origin_referral_case_id)
  WHERE case_type = 'APPOINTMENT_REQUEST' AND workflow_status NOT IN ('BOOKED','WITHDRAWN');
CREATE UNIQUE INDEX appointment_requests_one_active_change ON appointment_requests(tenant_id, original_appointment_id)
  WHERE case_type IN ('RESCHEDULING_REQUEST','CANCELLATION_REQUEST') AND workflow_status NOT IN ('COMPLETED','CANCELLED','WITHDRAWN');
CREATE UNIQUE INDEX appointment_requests_pending_execution ON appointment_requests(tenant_id, pending_execution_id)
  WHERE pending_execution_id IS NOT NULL;
CREATE INDEX appointment_requests_origin ON appointment_requests(tenant_id, origin_referral_case_id);
CREATE INDEX appointment_requests_original ON appointment_requests(tenant_id, original_appointment_id);

-- ---------------------------------------------------------------------------
-- 4. Appointment: a committed foreign appointment. Only the worker creates
--    one, from a result bound to its execution.
-- ---------------------------------------------------------------------------

CREATE TABLE appointments(
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  -- The APPOINTMENT_REQUEST or RESCHEDULING_REQUEST that committed it.
  source_case_id uuid NOT NULL,
  origin_referral_case_id uuid,
  destination text NOT NULL CHECK (destination ~ '^[a-z0-9_-]{1,40}$'),
  external_reference text NOT NULL CHECK (length(external_reference) BETWEEN 1 AND 200),
  slot_reference text NOT NULL CHECK (length(slot_reference) BETWEEN 1 AND 120),
  provider_reference text,
  location_reference text,
  service_code text,
  patient_reference text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  status text NOT NULL CHECK (status IN ('BOOKED','CANCELLED','SUPERSEDED')),
  committed_at timestamptz NOT NULL,
  commit_source text NOT NULL CHECK (commit_source IN ('CONNECTOR','RECONCILIATION')),
  create_execution_id uuid NOT NULL,
  cancelled_at timestamptz,
  cancellation_source text CHECK (cancellation_source IN ('CONNECTOR','RECONCILIATION','STAFF')),
  replaces_appointment_id uuid,
  superseded_by_id uuid,
  confirmation_status text NOT NULL DEFAULT 'UNCONFIRMED' CHECK (confirmation_status IN ('UNCONFIRMED','CONFIRMED')),
  confirmed_at timestamptz,
  confirmation_source text CHECK (confirmation_source IN ('STAFF')),
  confirmation_method text CHECK (confirmation_method IN ('PHONE','IN_PERSON','WRITTEN','OTHER')),
  confirmed_by text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, source_case_id) REFERENCES access_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, origin_referral_case_id) REFERENCES access_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, create_execution_id) REFERENCES executions(tenant_id, id),
  FOREIGN KEY (tenant_id, replaces_appointment_id) REFERENCES appointments(tenant_id, id),
  FOREIGN KEY (tenant_id, superseded_by_id) REFERENCES appointments(tenant_id, id),
  -- One ACCESS record per foreign appointment, and per committing execution.
  UNIQUE (tenant_id, destination, external_reference),
  UNIQUE (tenant_id, create_execution_id),
  CONSTRAINT appointment_times CHECK (ends_at > starts_at),
  CONSTRAINT appointment_cancellation_complete CHECK (
    (status = 'BOOKED') = (cancelled_at IS NULL) AND (status = 'BOOKED') = (cancellation_source IS NULL)),
  CONSTRAINT appointment_superseded_link CHECK ((status = 'SUPERSEDED') = (superseded_by_id IS NOT NULL)),
  CONSTRAINT appointment_not_self_linked CHECK (superseded_by_id IS DISTINCT FROM id AND replaces_appointment_id IS DISTINCT FROM id),
  CONSTRAINT appointment_confirmation_complete CHECK (
    (confirmation_status = 'CONFIRMED') = (confirmed_at IS NOT NULL AND confirmation_source IS NOT NULL
                                           AND confirmation_method IS NOT NULL AND confirmed_by IS NOT NULL))
);
CREATE INDEX appointments_origin ON appointments(tenant_id, origin_referral_case_id);
CREATE INDEX appointments_source ON appointments(tenant_id, source_case_id);

ALTER TABLE appointment_requests
  ADD CONSTRAINT appointment_requests_original_fk FOREIGN KEY (tenant_id, original_appointment_id) REFERENCES appointments(tenant_id, id),
  ADD CONSTRAINT appointment_requests_appointment_fk FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments(tenant_id, id);

-- The foreign identity of an appointment never changes; a cancelled or
-- superseded appointment is final; a confirmation is never withdrawn.
CREATE OR REPLACE FUNCTION access_appointment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'appointments cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.source_case_id <> OLD.source_case_id
     OR NEW.origin_referral_case_id IS DISTINCT FROM OLD.origin_referral_case_id
     OR NEW.destination <> OLD.destination OR NEW.external_reference <> OLD.external_reference
     OR NEW.slot_reference <> OLD.slot_reference OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
     OR NEW.location_reference IS DISTINCT FROM OLD.location_reference OR NEW.service_code IS DISTINCT FROM OLD.service_code
     OR NEW.patient_reference IS DISTINCT FROM OLD.patient_reference
     OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at OR NEW.timezone <> OLD.timezone
     OR NEW.committed_at <> OLD.committed_at OR NEW.commit_source <> OLD.commit_source
     OR NEW.create_execution_id <> OLD.create_execution_id
     OR NEW.replaces_appointment_id IS DISTINCT FROM OLD.replaces_appointment_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'appointment identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'BOOKED' AND (NEW.status <> OLD.status OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
                                 OR NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id) THEN
    RAISE EXCEPTION 'a cancelled or superseded appointment is final' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.confirmation_status = 'CONFIRMED' AND (NEW.confirmation_status <> 'CONFIRMED'
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by) THEN
    RAISE EXCEPTION 'a recorded confirmation cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'appointment update must increment version exactly once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointment_guard BEFORE UPDATE OR DELETE ON appointments
  FOR EACH ROW EXECUTE FUNCTION access_appointment_guard();

-- ---------------------------------------------------------------------------
-- 5. Slot hold: a reservation at the destination, always with an expiry.
-- ---------------------------------------------------------------------------

CREATE TABLE appointment_slot_holds(
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  case_id uuid NOT NULL,
  slot_reference text NOT NULL CHECK (length(slot_reference) BETWEEN 1 AND 120),
  hold_reference text NOT NULL CHECK (length(hold_reference) BETWEEN 1 AND 120),
  execution_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','CONSUMED','RELEASED','EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES appointment_requests(tenant_id, case_id),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES executions(tenant_id, id),
  UNIQUE (tenant_id, execution_id),
  CONSTRAINT hold_closed_time CHECK ((status = 'ACTIVE') = (closed_at IS NULL))
);
CREATE UNIQUE INDEX appointment_slot_holds_one_active ON appointment_slot_holds(tenant_id, case_id) WHERE status = 'ACTIVE';
CREATE INDEX appointment_slot_holds_expiry ON appointment_slot_holds(tenant_id, expires_at) WHERE status = 'ACTIVE';
ALTER TABLE appointment_requests
  ADD CONSTRAINT appointment_requests_hold_fk FOREIGN KEY (tenant_id, current_hold_id) REFERENCES appointment_slot_holds(tenant_id, id);

-- ACTIVE -> CONSUMED | RELEASED | EXPIRED, once. A hold closed as EXPIRED or
-- RELEASED can therefore never be consumed.
CREATE OR REPLACE FUNCTION access_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'holds cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.case_id <> OLD.case_id
     OR NEW.slot_reference <> OLD.slot_reference OR NEW.hold_reference <> OLD.hold_reference
     OR NEW.execution_id <> OLD.execution_id OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'hold identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'ACTIVE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a % hold cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointment_hold_guard BEFORE UPDATE OR DELETE ON appointment_slot_holds
  FOR EACH ROW EXECUTE FUNCTION access_hold_guard();

-- Request identity: case, type, origin and target never change.
CREATE OR REPLACE FUNCTION access_appointment_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'appointment requests cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.case_id <> OLD.case_id OR NEW.case_type <> OLD.case_type
     OR NEW.origin_referral_case_id IS DISTINCT FROM OLD.origin_referral_case_id
     OR NEW.original_appointment_id IS DISTINCT FROM OLD.original_appointment_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'appointment request identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.appointment_id IS NOT NULL AND NEW.appointment_id IS DISTINCT FROM OLD.appointment_id THEN
    RAISE EXCEPTION 'a committed appointment cannot be rebound' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.workflow_status IN ('BOOKED','COMPLETED','CANCELLED','WITHDRAWN') AND NEW.workflow_status <> OLD.workflow_status THEN
    RAISE EXCEPTION 'a finished appointment request is final' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'appointment request update must increment version exactly once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointment_request_guard BEFORE UPDATE OR DELETE ON appointment_requests
  FOR EACH ROW EXECUTE FUNCTION access_appointment_request_guard();

-- The originating case of a booking request is a referral of the same tenant.
CREATE OR REPLACE FUNCTION access_appointment_request_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin_referral_case_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM access_cases c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.origin_referral_case_id
          AND c.case_type = 'REFERRAL') THEN
    RAISE EXCEPTION 'an appointment request must originate from a referral of the same organisation'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointment_request_origin BEFORE INSERT ON appointment_requests
  FOR EACH ROW EXECUTE FUNCTION access_appointment_request_origin();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['appointment_requests','appointments','appointment_slot_holds'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION access_forbid_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Row-level security and least privilege.
-- ---------------------------------------------------------------------------

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['appointment_requests','appointments','appointment_slot_holds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
    -- Browser-facing roles (Supabase anon/authenticated) never touch these.
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON %I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;

-- API (access_request): opens requests and records staff decisions; it never
-- creates an appointment or a hold, and may change only the staff-owned
-- columns of an appointment (confirmation, attested cancellation) and close a
-- hold it abandons.
GRANT SELECT, INSERT, UPDATE ON appointment_requests TO access_request;
GRANT SELECT ON appointments, appointment_slot_holds TO access_request;
GRANT UPDATE (confirmation_status, confirmed_at, confirmation_source, confirmation_method, confirmed_by,
              status, cancelled_at, cancellation_source, superseded_by_id, version, updated_at)
  ON appointments TO access_request;
GRANT UPDATE (status, closed_at) ON appointment_slot_holds TO access_request;

-- Worker (access_worker): settles connector results.
GRANT SELECT, UPDATE ON appointment_requests TO access_worker;
GRANT SELECT, INSERT, UPDATE ON appointments, appointment_slot_holds TO access_worker;
