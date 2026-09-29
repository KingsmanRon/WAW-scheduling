-- 0009: the Scheduling Core's authoritative schedule.
--
-- Every channel (receptionist console, phone, walk-in, WhatsApp, future web)
-- books through the same Scheduling Core (packages/scheduling) against these
-- tables. The invariants that make double booking impossible live here, not
-- only in application code:
--
--   * appointments_no_practitioner_overlap: an exclusion constraint on
--     (tenant, practitioner, occupied range incl. buffers) over every status
--     that consumes time (HELD, CONFIRMED, CHECKED_IN, IN_PROGRESS,
--     COMPLETED). Two such appointments can never overlap, whichever path,
--     transaction or process writes them.
--   * a hold is an appointment in HELD status plus its slot_holds row; both
--     move together (deferred consistency triggers), a hold can only be
--     consumed before it expires, and only listed transitions are allowed.
--
-- Additive only.

-- ---------------------------------------------------------------------------
-- 1. Practitioners and appointment types (configuration).
-- ---------------------------------------------------------------------------

CREATE TABLE scheduling.practitioners(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  title text CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 20),
  given_name text CHECK (given_name IS NULL OR length(btrim(given_name)) BETWEEN 1 AND 100),
  family_name text NOT NULL CHECK (length(btrim(family_name)) BETWEEN 1 AND 100),
  profession text NOT NULL DEFAULT 'DOCTOR' CHECK (profession IN ('DOCTOR','NURSE','ALLIED_HEALTH','OTHER')),
  registration_number text CHECK (registration_number IS NULL OR registration_number ~ '^[A-Za-z0-9/ -]{1,40}$'),
  calendar_color text CHECK (calendar_color IS NULL OR calendar_color ~ '^#[0-9a-fA-F]{6}$'),
  active boolean NOT NULL DEFAULT true,
  -- Offered to patient self-service channels (WhatsApp, web).
  bookable_by_patients boolean NOT NULL DEFAULT true,
  family_name_key text GENERATED ALWAYS AS (lower(btrim(family_name))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id) REFERENCES directory.practices(tenant_id, id)
);
CREATE TRIGGER practitioners_version BEFORE UPDATE ON scheduling.practitioners
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER practitioners_no_delete BEFORE DELETE ON scheduling.practitioners
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();

ALTER TABLE directory.practice_memberships
  ADD CONSTRAINT practice_memberships_practitioner_fk FOREIGN KEY (tenant_id, practice_id, practitioner_id)
  REFERENCES scheduling.practitioners(tenant_id, practice_id, id);

CREATE TABLE scheduling.practitioner_locations(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid NOT NULL,
  -- Assignments are deactivated, never deleted (availability rules keep
  -- referencing them).
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, practice_id, practitioner_id, location_id),
  FOREIGN KEY (tenant_id, practice_id, practitioner_id) REFERENCES scheduling.practitioners(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, location_id) REFERENCES directory.practice_locations(tenant_id, practice_id, id)
);

CREATE TABLE scheduling.appointment_types(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 500),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 240),
  buffer_after_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 240),
  -- Candidate start-time granularity; NULL uses the practice default.
  slot_interval_minutes integer CHECK (slot_interval_minutes IS NULL OR slot_interval_minutes BETWEEN 5 AND 240),
  requires_referral boolean NOT NULL DEFAULT false,
  new_patient_allowed boolean NOT NULL DEFAULT true,
  -- Only patients with a completed appointment at the practice.
  follow_up_only boolean NOT NULL DEFAULT false,
  -- Booking window for patient self-service channels.
  min_notice_minutes integer NOT NULL DEFAULT 60 CHECK (min_notice_minutes BETWEEN 0 AND 43200),
  max_advance_days integer NOT NULL DEFAULT 90 CHECK (max_advance_days BETWEEN 1 AND 730),
  patient_bookable boolean NOT NULL DEFAULT true,
  calendar_color text CHECK (calendar_color IS NULL OR calendar_color ~ '^#[0-9a-fA-F]{6}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id) REFERENCES directory.practices(tenant_id, id),
  UNIQUE (tenant_id, practice_id, code),
  CONSTRAINT follow_up_excludes_new_patients CHECK (NOT (follow_up_only AND new_patient_allowed))
);
CREATE TRIGGER appointment_types_version BEFORE UPDATE ON scheduling.appointment_types
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER appointment_types_no_delete BEFORE DELETE ON scheduling.appointment_types
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();

-- Explicit allow-lists: a type is bookable only with listed (active)
-- practitioners and at listed (active) locations.
CREATE TABLE scheduling.appointment_type_practitioners(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  appointment_type_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, practice_id, appointment_type_id, practitioner_id),
  FOREIGN KEY (tenant_id, practice_id, appointment_type_id) REFERENCES scheduling.appointment_types(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, practitioner_id) REFERENCES scheduling.practitioners(tenant_id, practice_id, id)
);
CREATE TABLE scheduling.appointment_type_locations(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  appointment_type_id uuid NOT NULL,
  location_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, practice_id, appointment_type_id, location_id),
  FOREIGN KEY (tenant_id, practice_id, appointment_type_id) REFERENCES scheduling.appointment_types(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, location_id) REFERENCES directory.practice_locations(tenant_id, practice_id, id)
);

-- ---------------------------------------------------------------------------
-- 2. Availability configuration. Recurring rules are local wall-clock times
--    in the location's time zone; exceptions and blocks are instants.
--    Rows are never edited in place: removing and re-adding keeps history.
-- ---------------------------------------------------------------------------

CREATE TABLE scheduling.availability_rules(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid NOT NULL,
  -- ISO weekday, 1 = Monday.
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  valid_from date NOT NULL,
  valid_until date,
  minutes int4range GENERATED ALWAYS AS (int4range(start_minute, end_minute)) STORED,
  validity daterange GENERATED ALWAYS AS (daterange(valid_from, valid_until, '[]')) STORED,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by text,
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, practitioner_id, location_id)
    REFERENCES scheduling.practitioner_locations(tenant_id, practice_id, practitioner_id, location_id),
  CONSTRAINT availability_rule_times CHECK (end_minute > start_minute),
  CONSTRAINT availability_rule_validity CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CONSTRAINT availability_rule_removal CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  -- A practitioner cannot be scheduled to work twice at the same time.
  CONSTRAINT availability_rules_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, practitioner_id WITH =, weekday WITH =, minutes WITH &&, validity WITH &&
  ) WHERE (removed_at IS NULL)
);
CREATE INDEX availability_rules_lookup ON scheduling.availability_rules(tenant_id, practice_id, practitioner_id)
  WHERE removed_at IS NULL;

CREATE TABLE scheduling.availability_exceptions(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  -- UNAVAILABLE without a location applies at every location.
  location_id uuid,
  kind text NOT NULL CHECK (kind IN ('UNAVAILABLE','AVAILABLE')),
  reason_code text NOT NULL CHECK (reason_code IN ('LEAVE','SICK_LEAVE','TRAINING','PUBLIC_HOLIDAY','PRACTICE_CLOSED',
                                                   'EXTRA_SESSION','OTHER')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  period tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  note text CHECK (note IS NULL OR length(note) <= 200),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by text,
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, practitioner_id) REFERENCES scheduling.practitioners(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, location_id) REFERENCES directory.practice_locations(tenant_id, practice_id, id),
  CONSTRAINT availability_exception_times CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '400 days'),
  CONSTRAINT availability_exception_location CHECK (kind <> 'AVAILABLE' OR location_id IS NOT NULL),
  CONSTRAINT availability_exception_removal CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX availability_exceptions_period ON scheduling.availability_exceptions
  USING gist (tenant_id, practitioner_id, period) WHERE removed_at IS NULL;

CREATE TABLE scheduling.schedule_blocks(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid,
  reason_code text NOT NULL CHECK (reason_code IN ('ADMIN','MEETING','BREAK','PERSONAL','EMERGENCY','OTHER')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  period tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  note text CHECK (note IS NULL OR length(note) <= 200),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by text,
  removal_reason text CHECK (removal_reason IS NULL OR length(removal_reason) <= 200),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, practitioner_id) REFERENCES scheduling.practitioners(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, location_id) REFERENCES directory.practice_locations(tenant_id, practice_id, id),
  CONSTRAINT schedule_block_times CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '31 days'),
  CONSTRAINT schedule_block_removal CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX schedule_blocks_period ON scheduling.schedule_blocks
  USING gist (tenant_id, practitioner_id, period) WHERE removed_at IS NULL;

-- Configuration rows are facts: only their removal may be recorded, once.
CREATE OR REPLACE FUNCTION scheduling.removable_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a removed % row is final', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'removed_at' - 'removed_by' - 'removal_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'removed_at' - 'removed_by' - 'removal_reason') THEN
    RAISE EXCEPTION '% rows are immutable; remove and re-create instead', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER availability_rules_guard BEFORE UPDATE OR DELETE ON scheduling.availability_rules
  FOR EACH ROW EXECUTE FUNCTION scheduling.removable_only_guard();
CREATE TRIGGER availability_exceptions_guard BEFORE UPDATE OR DELETE ON scheduling.availability_exceptions
  FOR EACH ROW EXECUTE FUNCTION scheduling.removable_only_guard();
CREATE TRIGGER schedule_blocks_guard BEFORE UPDATE OR DELETE ON scheduling.schedule_blocks
  FOR EACH ROW EXECUTE FUNCTION scheduling.removable_only_guard();

-- ---------------------------------------------------------------------------
-- 3. Referral register. The practice's record of referrals that authorise
--    booking appointment types that require one. A referral may originate
--    from an ACCESS intake case (public.access_cases).
-- ---------------------------------------------------------------------------

CREATE TABLE scheduling.patient_referrals(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  patient_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('RECEIVED','VERIFIED','REJECTED','CANCELLED')),
  referring_practitioner_name text NOT NULL CHECK (length(btrim(referring_practitioner_name)) BETWEEN 1 AND 120),
  referring_practice_name text CHECK (referring_practice_name IS NULL OR length(btrim(referring_practice_name)) BETWEEN 1 AND 120),
  referring_practice_number text CHECK (referring_practice_number IS NULL OR referring_practice_number ~ '^[A-Za-z0-9/ -]{1,30}$'),
  referral_date date,
  received_at timestamptz NOT NULL DEFAULT now(),
  valid_until date,
  -- When set, the referral authorises only this appointment type.
  appointment_type_id uuid,
  -- When set, at most this many non-cancelled appointments may use it.
  max_appointments integer CHECK (max_appointments IS NULL OR max_appointments BETWEEN 1 AND 100),
  intake_case_id uuid,
  source_channel text NOT NULL CHECK (source_channel IN ('PHONE','WALK_IN','WHATSAPP','WEB','INTERNAL','REFERRAL','OTHER')),
  verified_by text,
  verified_at timestamptz,
  rejection_reason_code text CHECK (rejection_reason_code IS NULL OR rejection_reason_code IN
    ('EXPIRED','INCOMPLETE','WRONG_PATIENT','NOT_APPLICABLE','OTHER')),
  rejected_by text,
  rejected_at timestamptz,
  cancelled_by text,
  cancelled_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, appointment_type_id) REFERENCES scheduling.appointment_types(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, intake_case_id) REFERENCES public.access_cases(tenant_id, id),
  CONSTRAINT referral_validity CHECK (valid_until IS NULL OR referral_date IS NULL OR valid_until >= referral_date),
  CONSTRAINT referral_verified_complete CHECK (status <> 'VERIFIED' OR (verified_at IS NOT NULL AND verified_by IS NOT NULL)),
  CONSTRAINT referral_rejected_complete CHECK ((status = 'REJECTED') = (rejected_at IS NOT NULL AND rejected_by IS NOT NULL
                                                                        AND rejection_reason_code IS NOT NULL)),
  CONSTRAINT referral_cancelled_complete CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);
CREATE INDEX patient_referrals_patient ON scheduling.patient_referrals(tenant_id, practice_id, patient_id, received_at DESC);
CREATE OR REPLACE FUNCTION scheduling.referral_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'referrals are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.practice_id <> OLD.practice_id OR NEW.id <> OLD.id
     OR NEW.patient_id <> OLD.patient_id OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by
     OR NEW.intake_case_id IS DISTINCT FROM OLD.intake_case_id OR NEW.source_channel <> OLD.source_channel THEN
    RAISE EXCEPTION 'referral identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'RECEIVED' AND NEW.status IN ('VERIFIED','REJECTED','CANCELLED'))
    OR (OLD.status = 'VERIFIED' AND NEW.status = 'CANCELLED')) THEN
    RAISE EXCEPTION 'invalid referral transition % -> %', OLD.status, NEW.status USING ERRCODE = 'SCH02';
  END IF;
  IF OLD.status IN ('REJECTED','CANCELLED') THEN
    RAISE EXCEPTION 'a % referral is final', OLD.status USING ERRCODE = 'SCH02';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_referrals_guard BEFORE UPDATE OR DELETE ON scheduling.patient_referrals
  FOR EACH ROW EXECUTE FUNCTION scheduling.referral_guard();
CREATE TRIGGER patient_referrals_version BEFORE UPDATE ON scheduling.patient_referrals
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();

-- Referral documents: application-encrypted objects in the private bucket.
-- Only content that passed malware scanning is ever stored.
CREATE TABLE scheduling.referral_documents(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  referral_id uuid NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('REFERRAL_LETTER','SUPPORTING_DOCUMENT')),
  media_type text NOT NULL CHECK (media_type IN ('application/pdf','image/jpeg','image/png','text/plain')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  digest_sha256 text NOT NULL CHECK (digest_sha256 ~ '^[0-9a-f]{64}$'),
  storage_backend text NOT NULL CHECK (storage_backend IN ('local-encrypted','supabase-storage')),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 10 AND 300),
  encryption_key_id text NOT NULL CHECK (length(encryption_key_id) BETWEEN 1 AND 60),
  scanner text NOT NULL CHECK (length(scanner) BETWEEN 1 AND 60),
  scanned_at timestamptz NOT NULL,
  uploaded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, referral_id) REFERENCES scheduling.patient_referrals(tenant_id, practice_id, id),
  UNIQUE (tenant_id, practice_id, referral_id, digest_sha256),
  UNIQUE (object_key)
);
CREATE OR REPLACE FUNCTION scheduling.referral_document_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document metadata is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'deleted_at') IS DISTINCT FROM (to_jsonb(OLD) - 'deleted_at') OR OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'document metadata is immutable; only deletion may be recorded' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER referral_documents_guard BEFORE UPDATE OR DELETE ON scheduling.referral_documents
  FOR EACH ROW EXECUTE FUNCTION scheduling.referral_document_guard();

-- ---------------------------------------------------------------------------
-- 4. Waitlist entries (offers follow the appointments table).
-- ---------------------------------------------------------------------------

CREATE TABLE scheduling.waitlist_entries(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  patient_id uuid NOT NULL,
  appointment_type_id uuid NOT NULL,
  practitioner_id uuid,
  location_id uuid,
  earliest_date date NOT NULL,
  latest_date date NOT NULL,
  -- ISO weekdays the patient can attend; empty means any day.
  preferred_weekdays smallint[] NOT NULL DEFAULT '{}' CHECK (preferred_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  preferred_start_minute smallint CHECK (preferred_start_minute IS NULL OR preferred_start_minute BETWEEN 0 AND 1439),
  preferred_end_minute smallint CHECK (preferred_end_minute IS NULL OR preferred_end_minute BETWEEN 1 AND 1440),
  -- Administrative priority (0 normal, 1 raised by staff). Never clinical triage.
  priority smallint NOT NULL DEFAULT 0 CHECK (priority IN (0, 1)),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','OFFERED','BOOKED','CANCELLED','EXPIRED')),
  referral_id uuid,
  source_channel text NOT NULL CHECK (source_channel IN ('PHONE','WALK_IN','WHATSAPP','WEB','INTERNAL','REFERRAL','OTHER')),
  booked_appointment_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, appointment_type_id) REFERENCES scheduling.appointment_types(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, practitioner_id) REFERENCES scheduling.practitioners(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, location_id) REFERENCES directory.practice_locations(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, referral_id) REFERENCES scheduling.patient_referrals(tenant_id, practice_id, id),
  CONSTRAINT waitlist_window CHECK (latest_date >= earliest_date AND latest_date - earliest_date <= 366),
  CONSTRAINT waitlist_time_window CHECK (preferred_start_minute IS NULL OR preferred_end_minute IS NULL
                                         OR preferred_end_minute > preferred_start_minute),
  CONSTRAINT waitlist_closed CHECK ((status IN ('ACTIVE','OFFERED')) = (closed_at IS NULL)),
  CONSTRAINT waitlist_booked CHECK ((status = 'BOOKED') = (booked_appointment_id IS NOT NULL))
);
-- Deterministic order: priority, then first come first served.
CREATE INDEX waitlist_entries_queue ON scheduling.waitlist_entries(tenant_id, practice_id, appointment_type_id, priority DESC, created_at, id)
  WHERE status = 'ACTIVE';
CREATE INDEX waitlist_entries_patient ON scheduling.waitlist_entries(tenant_id, practice_id, patient_id);
CREATE UNIQUE INDEX waitlist_entries_one_open_per_type ON scheduling.waitlist_entries(tenant_id, practice_id, patient_id, appointment_type_id)
  WHERE status IN ('ACTIVE','OFFERED');
CREATE TRIGGER waitlist_entries_version BEFORE UPDATE ON scheduling.waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER waitlist_entries_no_delete BEFORE DELETE ON scheduling.waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();
CREATE OR REPLACE FUNCTION scheduling.waitlist_entry_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.practice_id <> OLD.practice_id OR NEW.id <> OLD.id
     OR NEW.patient_id <> OLD.patient_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'waitlist entry identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'ACTIVE' AND NEW.status IN ('OFFERED','BOOKED','CANCELLED','EXPIRED'))
    OR (OLD.status = 'OFFERED' AND NEW.status IN ('ACTIVE','BOOKED','CANCELLED','EXPIRED'))) THEN
    RAISE EXCEPTION 'invalid waitlist transition % -> %', OLD.status, NEW.status USING ERRCODE = 'SCH02';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waitlist_entries_guard BEFORE UPDATE ON scheduling.waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION scheduling.waitlist_entry_guard();

-- ---------------------------------------------------------------------------
-- 5. Appointments.
-- ---------------------------------------------------------------------------

CREATE TABLE scheduling.appointments(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  patient_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid NOT NULL,
  appointment_type_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('HELD','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED','CANCELLED',
                                         'NO_SHOW','RESCHEDULED','EXPIRED')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- The location's time zone at booking, for display and messages.
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  -- Snapshots of the appointment type at booking time.
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  buffer_before_minutes integer NOT NULL CHECK (buffer_before_minutes BETWEEN 0 AND 240),
  buffer_after_minutes integer NOT NULL CHECK (buffer_after_minutes BETWEEN 0 AND 240),
  -- [starts_at - buffer_before, ends_at + buffer_after): the practitioner's
  -- exclusive time. Derived by trigger on insert, immutable afterwards.
  occupied tstzrange NOT NULL,
  source_channel text NOT NULL CHECK (source_channel IN ('PHONE','WALK_IN','WHATSAPP','WEB','INTERNAL','REFERRAL','OTHER')),
  booked_by_actor_type text NOT NULL CHECK (booked_by_actor_type IN ('STAFF','PATIENT','SYSTEM')),
  booked_by_actor_id text NOT NULL CHECK (length(booked_by_actor_id) BETWEEN 1 AND 200),
  booked_by_role text,
  referral_id uuid,
  waitlist_entry_id uuid,
  hold_expires_at timestamptz,
  -- Booked outside published availability by an authorised staff override
  -- (still subject to the overlap constraint).
  override_availability boolean NOT NULL DEFAULT false,
  -- Administrative note only; no clinical information.
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  rescheduled_from_id uuid,
  rescheduled_to_id uuid,
  confirmed_at timestamptz,
  checked_in_at timestamptz,
  checked_in_by text,
  started_at timestamptz,
  started_by text,
  completed_at timestamptz,
  completed_by text,
  no_show_at timestamptz,
  no_show_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  cancellation_reason_code text CHECK (cancellation_reason_code IS NULL OR cancellation_reason_code IN
    ('PATIENT_REQUEST','PRACTICE_REQUEST','PRACTITIONER_UNAVAILABLE','DUPLICATE_BOOKING','HOLD_RELEASED',
     'WAITLIST_OFFER_DECLINED','OTHER')),
  cancellation_note text CHECK (cancellation_note IS NULL OR length(cancellation_note) <= 500),
  rescheduled_at timestamptz,
  rescheduled_by text,
  expired_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, practitioner_id) REFERENCES scheduling.practitioners(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, location_id) REFERENCES directory.practice_locations(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, appointment_type_id) REFERENCES scheduling.appointment_types(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, referral_id) REFERENCES scheduling.patient_referrals(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, waitlist_entry_id) REFERENCES scheduling.waitlist_entries(tenant_id, practice_id, id),
  -- Reschedule links: the original points at its replacement and back. Both
  -- rows are written in one transaction, so the checks run at commit.
  FOREIGN KEY (tenant_id, practice_id, rescheduled_from_id) REFERENCES scheduling.appointments(tenant_id, practice_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, practice_id, rescheduled_to_id) REFERENCES scheduling.appointments(tenant_id, practice_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT appointment_times CHECK (ends_at > starts_at AND ends_at - starts_at = make_interval(mins => duration_minutes)),
  CONSTRAINT appointment_not_self_linked CHECK (rescheduled_from_id IS DISTINCT FROM id AND rescheduled_to_id IS DISTINCT FROM id),
  CONSTRAINT appointment_held_expiry CHECK (status <> 'HELD' OR hold_expires_at IS NOT NULL),
  CONSTRAINT appointment_confirmed_time CHECK (
    status NOT IN ('CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED','NO_SHOW','RESCHEDULED') OR confirmed_at IS NOT NULL),
  CONSTRAINT appointment_checked_in_complete CHECK (
    status NOT IN ('CHECKED_IN','IN_PROGRESS','COMPLETED') OR (checked_in_at IS NOT NULL AND checked_in_by IS NOT NULL)),
  CONSTRAINT appointment_started_complete CHECK (status <> 'IN_PROGRESS' OR (started_at IS NOT NULL AND started_by IS NOT NULL)),
  CONSTRAINT appointment_completed_complete CHECK (status <> 'COMPLETED' OR (completed_at IS NOT NULL AND completed_by IS NOT NULL)),
  CONSTRAINT appointment_no_show_complete CHECK (status <> 'NO_SHOW' OR (no_show_at IS NOT NULL AND no_show_by IS NOT NULL)),
  CONSTRAINT appointment_cancelled_complete CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancellation_reason_code IS NOT NULL)),
  CONSTRAINT appointment_rescheduled_complete CHECK (
    (status = 'RESCHEDULED') = (rescheduled_to_id IS NOT NULL AND rescheduled_at IS NOT NULL AND rescheduled_by IS NOT NULL)),
  CONSTRAINT appointment_expired_complete CHECK ((status = 'EXPIRED') = (expired_at IS NOT NULL)),
  -- THE invariant: a practitioner's exclusive time is never double booked.
  CONSTRAINT appointments_no_practitioner_overlap EXCLUDE USING gist (
    tenant_id WITH =, practitioner_id WITH =, occupied WITH &&
  ) WHERE (status IN ('HELD','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED'))
);
CREATE INDEX appointments_practice_start ON scheduling.appointments(tenant_id, practice_id, starts_at);
CREATE INDEX appointments_practitioner_start ON scheduling.appointments(tenant_id, practice_id, practitioner_id, starts_at);
CREATE INDEX appointments_location_start ON scheduling.appointments(tenant_id, practice_id, location_id, starts_at);
CREATE INDEX appointments_patient_start ON scheduling.appointments(tenant_id, practice_id, patient_id, starts_at DESC);
CREATE INDEX appointments_held_expiry ON scheduling.appointments(tenant_id, practice_id, hold_expires_at) WHERE status = 'HELD';
CREATE INDEX appointments_referral ON scheduling.appointments(tenant_id, practice_id, referral_id) WHERE referral_id IS NOT NULL;
-- An appointment has at most one live replacement.
CREATE UNIQUE INDEX appointments_one_live_replacement ON scheduling.appointments(tenant_id, practice_id, rescheduled_from_id)
  WHERE rescheduled_from_id IS NOT NULL AND status NOT IN ('EXPIRED','CANCELLED');

-- Explicit, deterministic state machine (mirrors packages/scheduling
-- APPOINTMENT_TRANSITIONS). NO_SHOW -> CHECKED_IN records a late arrival; it
-- re-occupies the slot and therefore fails if the time was re-booked.
CREATE OR REPLACE FUNCTION scheduling.appointment_transition_allowed(from_status text, to_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (from_status, to_status) IN (
    ('HELD','CONFIRMED'), ('HELD','EXPIRED'), ('HELD','CANCELLED'),
    ('CONFIRMED','CHECKED_IN'), ('CONFIRMED','CANCELLED'), ('CONFIRMED','NO_SHOW'), ('CONFIRMED','RESCHEDULED'),
    ('CHECKED_IN','IN_PROGRESS'), ('CHECKED_IN','COMPLETED'), ('CHECKED_IN','CANCELLED'),
    ('IN_PROGRESS','COMPLETED'),
    ('NO_SHOW','CHECKED_IN'))
$$;

CREATE OR REPLACE FUNCTION scheduling.appointment_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('HELD','CONFIRMED') THEN
    RAISE EXCEPTION 'an appointment is created HELD or CONFIRMED, not %', NEW.status USING ERRCODE = 'SCH02';
  END IF;
  IF NEW.status = 'CONFIRMED' AND NEW.confirmed_at IS NULL THEN
    NEW.confirmed_at := now();
  END IF;
  NEW.occupied := tstzrange(NEW.starts_at - make_interval(mins => NEW.buffer_before_minutes),
                            NEW.ends_at + make_interval(mins => NEW.buffer_after_minutes), '[)');
  NEW.version := 0;
  NEW.created_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_before_insert BEFORE INSERT ON scheduling.appointments
  FOR EACH ROW EXECUTE FUNCTION scheduling.appointment_before_insert();

CREATE OR REPLACE FUNCTION scheduling.appointment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'appointments are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ROW(NEW.tenant_id, NEW.practice_id, NEW.id, NEW.patient_id, NEW.practitioner_id, NEW.location_id,
         NEW.appointment_type_id, NEW.starts_at, NEW.ends_at, NEW.timezone, NEW.duration_minutes,
         NEW.buffer_before_minutes, NEW.buffer_after_minutes, NEW.occupied, NEW.source_channel,
         NEW.booked_by_actor_type, NEW.booked_by_actor_id, NEW.booked_by_role, NEW.referral_id,
         NEW.waitlist_entry_id, NEW.hold_expires_at, NEW.override_availability, NEW.rescheduled_from_id,
         NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.practice_id, OLD.id, OLD.patient_id, OLD.practitioner_id, OLD.location_id,
         OLD.appointment_type_id, OLD.starts_at, OLD.ends_at, OLD.timezone, OLD.duration_minutes,
         OLD.buffer_before_minutes, OLD.buffer_after_minutes, OLD.occupied, OLD.source_channel,
         OLD.booked_by_actor_type, OLD.booked_by_actor_id, OLD.booked_by_role, OLD.referral_id,
         OLD.waitlist_entry_id, OLD.hold_expires_at, OLD.override_availability, OLD.rescheduled_from_id,
         OLD.created_at) THEN
    RAISE EXCEPTION 'appointment identity and time are immutable; rescheduling creates a new appointment'
      USING ERRCODE = 'SCH03';
  END IF;
  IF OLD.rescheduled_to_id IS NOT NULL AND NEW.rescheduled_to_id IS DISTINCT FROM OLD.rescheduled_to_id THEN
    RAISE EXCEPTION 'a reschedule link is final' USING ERRCODE = 'SCH03';
  END IF;
  IF NEW.status <> OLD.status AND NOT scheduling.appointment_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'invalid appointment transition % -> %', OLD.status, NEW.status USING ERRCODE = 'SCH02';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'appointment update must increment version exactly once' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_guard BEFORE UPDATE OR DELETE ON scheduling.appointments
  FOR EACH ROW EXECUTE FUNCTION scheduling.appointment_guard();

-- ---------------------------------------------------------------------------
-- 6. Slot holds: the temporary reservation behind a HELD appointment.
-- ---------------------------------------------------------------------------

CREATE TABLE scheduling.slot_holds(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid NOT NULL,
  appointment_type_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','RELEASED','EXPIRED')),
  purpose text NOT NULL CHECK (purpose IN ('BOOKING','RESCHEDULE','WAITLIST_OFFER')),
  reschedule_of_id uuid,
  owner_channel text NOT NULL CHECK (owner_channel IN ('PHONE','WALK_IN','WHATSAPP','WEB','INTERNAL','REFERRAL','OTHER')),
  owner_actor_type text NOT NULL CHECK (owner_actor_type IN ('STAFF','PATIENT','SYSTEM')),
  owner_actor_id text NOT NULL CHECK (length(owner_actor_id) BETWEEN 1 AND 200),
  -- Conversation id, console session, or waitlist offer that owns the hold.
  owner_session_ref text CHECK (owner_session_ref IS NULL OR length(owner_session_ref) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  close_reason text CHECK (close_reason IS NULL OR close_reason IN
    ('CONSUMED','RELEASED_BY_OWNER','RELEASED_BY_STAFF','EXPIRED','OFFER_DECLINED')),
  PRIMARY KEY (tenant_id, practice_id, id),
  UNIQUE (tenant_id, practice_id, appointment_id),
  FOREIGN KEY (tenant_id, practice_id, appointment_id) REFERENCES scheduling.appointments(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, practitioner_id) REFERENCES scheduling.practitioners(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, location_id) REFERENCES directory.practice_locations(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, appointment_type_id) REFERENCES scheduling.appointment_types(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, reschedule_of_id) REFERENCES scheduling.appointments(tenant_id, practice_id, id),
  CONSTRAINT hold_times CHECK (ends_at > starts_at AND expires_at > created_at),
  CONSTRAINT hold_closed CHECK ((status = 'ACTIVE') = (closed_at IS NULL AND close_reason IS NULL)),
  CONSTRAINT hold_reschedule_target CHECK ((purpose = 'RESCHEDULE') = (reschedule_of_id IS NOT NULL))
);
CREATE INDEX slot_holds_active_expiry ON scheduling.slot_holds(tenant_id, practice_id, expires_at) WHERE status = 'ACTIVE';
CREATE INDEX slot_holds_active_owner ON scheduling.slot_holds(tenant_id, practice_id, owner_session_ref) WHERE status = 'ACTIVE';

CREATE OR REPLACE FUNCTION scheduling.slot_hold_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a hold is created ACTIVE' USING ERRCODE = 'SCH02';
  END IF;
  NEW.created_at := now();
  IF NOT EXISTS (
    SELECT 1 FROM scheduling.appointments a
     WHERE a.tenant_id = NEW.tenant_id AND a.practice_id = NEW.practice_id AND a.id = NEW.appointment_id
       AND a.status = 'HELD' AND a.patient_id = NEW.patient_id AND a.practitioner_id = NEW.practitioner_id
       AND a.location_id = NEW.location_id AND a.appointment_type_id = NEW.appointment_type_id
       AND a.starts_at = NEW.starts_at AND a.ends_at = NEW.ends_at AND a.hold_expires_at = NEW.expires_at
       AND a.rescheduled_from_id IS NOT DISTINCT FROM NEW.reschedule_of_id) THEN
    RAISE EXCEPTION 'a hold must reserve a HELD appointment for the same slot' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER slot_holds_before_insert BEFORE INSERT ON scheduling.slot_holds
  FOR EACH ROW EXECUTE FUNCTION scheduling.slot_hold_before_insert();

-- ACTIVE -> CONSUMED | RELEASED | EXPIRED, once. An expired hold can never be
-- consumed, even if the expiry sweep has not run yet.
CREATE OR REPLACE FUNCTION scheduling.slot_hold_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'holds are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ROW(NEW.tenant_id, NEW.practice_id, NEW.id, NEW.appointment_id, NEW.patient_id, NEW.practitioner_id,
         NEW.location_id, NEW.appointment_type_id, NEW.starts_at, NEW.ends_at, NEW.expires_at, NEW.purpose,
         NEW.reschedule_of_id, NEW.owner_channel, NEW.owner_actor_type, NEW.owner_actor_id,
         NEW.owner_session_ref, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.practice_id, OLD.id, OLD.appointment_id, OLD.patient_id, OLD.practitioner_id,
         OLD.location_id, OLD.appointment_type_id, OLD.starts_at, OLD.ends_at, OLD.expires_at, OLD.purpose,
         OLD.reschedule_of_id, OLD.owner_channel, OLD.owner_actor_type, OLD.owner_actor_id,
         OLD.owner_session_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'hold identity is immutable' USING ERRCODE = 'SCH03';
  END IF;
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a % hold is final', OLD.status USING ERRCODE = 'SCH02';
  END IF;
  IF NEW.status = 'CONSUMED' AND OLD.expires_at <= now() THEN
    RAISE EXCEPTION 'an expired hold cannot be consumed' USING ERRCODE = 'SCH01';
  END IF;
  IF NEW.status = 'EXPIRED' AND OLD.expires_at > now() THEN
    RAISE EXCEPTION 'a hold cannot expire before its expiry time' USING ERRCODE = 'SCH02';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER slot_holds_guard BEFORE UPDATE OR DELETE ON scheduling.slot_holds
  FOR EACH ROW EXECUTE FUNCTION scheduling.slot_hold_guard();

-- A HELD appointment and its hold move together; checked at commit so both
-- rows can be written in either order within the transaction.
CREATE OR REPLACE FUNCTION scheduling.hold_pair_consistent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  appointment_status text;
  hold_status text;
BEGIN
  IF TG_TABLE_NAME = 'appointments' THEN
    SELECT h.status INTO hold_status FROM scheduling.slot_holds h
     WHERE h.tenant_id = NEW.tenant_id AND h.practice_id = NEW.practice_id AND h.appointment_id = NEW.id;
    appointment_status := (SELECT a.status FROM scheduling.appointments a
                            WHERE a.tenant_id = NEW.tenant_id AND a.practice_id = NEW.practice_id AND a.id = NEW.id);
  ELSE
    hold_status := (SELECT h.status FROM scheduling.slot_holds h
                     WHERE h.tenant_id = NEW.tenant_id AND h.practice_id = NEW.practice_id AND h.id = NEW.id);
    SELECT a.status INTO appointment_status FROM scheduling.appointments a
     WHERE a.tenant_id = NEW.tenant_id AND a.practice_id = NEW.practice_id AND a.id = NEW.appointment_id;
  END IF;
  -- Appointments booked directly (no hold) are never HELD.
  IF hold_status IS NULL THEN
    IF appointment_status = 'HELD' THEN
      RAISE EXCEPTION 'a HELD appointment requires its slot hold' USING ERRCODE = 'SCH03';
    END IF;
    RETURN NULL;
  END IF;
  IF (hold_status = 'ACTIVE') <> (appointment_status = 'HELD')
     OR (hold_status = 'RELEASED' AND appointment_status <> 'CANCELLED')
     OR (hold_status = 'EXPIRED' AND appointment_status <> 'EXPIRED') THEN
    RAISE EXCEPTION 'hold % and appointment % are inconsistent', hold_status, appointment_status USING ERRCODE = 'SCH03';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER appointments_hold_pair AFTER INSERT OR UPDATE OF status ON scheduling.appointments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scheduling.hold_pair_consistent();
CREATE CONSTRAINT TRIGGER slot_holds_hold_pair AFTER INSERT OR UPDATE OF status ON scheduling.slot_holds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scheduling.hold_pair_consistent();

-- ---------------------------------------------------------------------------
-- 7. Participants and the appointment's own history.
-- ---------------------------------------------------------------------------

CREATE TABLE scheduling.appointment_participants(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  participant_type text NOT NULL CHECK (participant_type IN ('PATIENT','PRACTITIONER','GUARDIAN','INTERPRETER','OTHER')),
  patient_id uuid,
  practitioner_id uuid,
  display_name text CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, appointment_id) REFERENCES scheduling.appointments(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, practitioner_id) REFERENCES scheduling.practitioners(tenant_id, practice_id, id),
  CONSTRAINT participant_patient CHECK ((participant_type = 'PATIENT') = (patient_id IS NOT NULL)),
  CONSTRAINT participant_practitioner CHECK ((participant_type = 'PRACTITIONER') = (practitioner_id IS NOT NULL)),
  CONSTRAINT participant_named CHECK (participant_type IN ('PATIENT','PRACTITIONER') OR display_name IS NOT NULL)
);
CREATE UNIQUE INDEX appointment_participants_one_patient ON scheduling.appointment_participants(tenant_id, practice_id, appointment_id)
  WHERE participant_type = 'PATIENT';
CREATE INDEX appointment_participants_appointment ON scheduling.appointment_participants(tenant_id, practice_id, appointment_id);
CREATE TRIGGER appointment_participants_append_only BEFORE UPDATE OR DELETE ON scheduling.appointment_participants
  FOR EACH ROW EXECUTE FUNCTION public.access_forbid_mutation();

CREATE TABLE scheduling.appointment_events(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  appointment_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('HELD','CONFIRMED','CHECKED_IN','STARTED','COMPLETED','CANCELLED',
    'NO_SHOW','RESCHEDULED','RESCHEDULED_FROM','EXPIRED','HOLD_RELEASED','LATE_ARRIVAL','NOTE_UPDATED')),
  from_status text,
  to_status text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('STAFF','PATIENT','SYSTEM','INTEGRATION')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  actor_role text,
  channel text CHECK (channel IS NULL OR channel IN ('PHONE','WALK_IN','WHATSAPP','WEB','INTERNAL','REFERRAL','OTHER','SYSTEM')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{2,64}$'),
  -- Identifiers and instants only (e.g. the related appointment id).
  details jsonb NOT NULL DEFAULT '{}',
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, appointment_id) REFERENCES scheduling.appointments(tenant_id, practice_id, id)
);
CREATE INDEX appointment_events_appointment ON scheduling.appointment_events(tenant_id, practice_id, appointment_id, id);
CREATE TRIGGER appointment_events_append_only BEFORE UPDATE OR DELETE ON scheduling.appointment_events
  FOR EACH ROW EXECUTE FUNCTION public.access_forbid_mutation();

-- ---------------------------------------------------------------------------
-- 8. Waitlist offers: a freed slot reserved (as a hold) for one waitlisted
--    patient for a limited time. Accepting confirms the hold; nothing is
--    booked without the patient's explicit acceptance.
-- ---------------------------------------------------------------------------

CREATE TABLE scheduling.waitlist_offers(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  waitlist_entry_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  location_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','DECLINED','EXPIRED','WITHDRAWN')),
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  response_channel text CHECK (response_channel IS NULL OR response_channel IN
    ('PHONE','WALK_IN','WHATSAPP','WEB','INTERNAL','REFERRAL','OTHER','SYSTEM')),
  -- The outbox event (freed slot) that produced the offer.
  source_event_id bigint,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, waitlist_entry_id) REFERENCES scheduling.waitlist_entries(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, appointment_id) REFERENCES scheduling.appointments(tenant_id, practice_id, id),
  UNIQUE (tenant_id, practice_id, appointment_id),
  CONSTRAINT waitlist_offer_times CHECK (ends_at > starts_at AND expires_at > offered_at),
  CONSTRAINT waitlist_offer_response CHECK ((status IN ('PENDING','EXPIRED','WITHDRAWN')) OR responded_at IS NOT NULL)
);
CREATE UNIQUE INDEX waitlist_offers_one_pending ON scheduling.waitlist_offers(tenant_id, practice_id, waitlist_entry_id)
  WHERE status = 'PENDING';
CREATE INDEX waitlist_offers_pending_expiry ON scheduling.waitlist_offers(tenant_id, practice_id, expires_at)
  WHERE status = 'PENDING';
CREATE TRIGGER waitlist_offers_version BEFORE UPDATE ON scheduling.waitlist_offers
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER waitlist_offers_no_delete BEFORE DELETE ON scheduling.waitlist_offers
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();
CREATE OR REPLACE FUNCTION scheduling.waitlist_offer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.practice_id, NEW.id, NEW.waitlist_entry_id, NEW.appointment_id, NEW.starts_at,
         NEW.ends_at, NEW.offered_at, NEW.expires_at, NEW.source_event_id)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.practice_id, OLD.id, OLD.waitlist_entry_id, OLD.appointment_id, OLD.starts_at,
         OLD.ends_at, OLD.offered_at, OLD.expires_at, OLD.source_event_id) THEN
    RAISE EXCEPTION 'waitlist offer identity is immutable' USING ERRCODE = 'SCH03';
  END IF;
  IF OLD.status <> 'PENDING' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a % offer is final', OLD.status USING ERRCODE = 'SCH02';
  END IF;
  IF NEW.status = 'ACCEPTED' AND OLD.status = 'PENDING' AND OLD.expires_at <= now() THEN
    RAISE EXCEPTION 'an expired offer cannot be accepted' USING ERRCODE = 'SCH01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waitlist_offers_guard BEFORE UPDATE ON scheduling.waitlist_offers
  FOR EACH ROW EXECUTE FUNCTION scheduling.waitlist_offer_guard();

-- ---------------------------------------------------------------------------
-- 9. Schedule change signals for view synchronisation (Supabase Realtime).
--    One row per practitioner, bumped by trigger whenever that practitioner's
--    schedule changes. No patient data. Correctness never depends on it:
--    consoles also poll, and every write is validated by the Scheduling Core.
-- ---------------------------------------------------------------------------

CREATE TABLE scheduling.schedule_signals(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  seq bigint NOT NULL DEFAULT 1,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, practice_id, practitioner_id)
);
-- Written only by the trigger below (owner privileges); readable by signed-in
-- members of the practice through Supabase Realtime (policy created when the
-- Supabase `authenticated` role exists, at the end of 0010).
ALTER TABLE scheduling.schedule_signals ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION scheduling.touch_schedule_signal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO scheduling.schedule_signals AS s (tenant_id, practice_id, practitioner_id, seq, changed_at)
  VALUES (NEW.tenant_id, NEW.practice_id, NEW.practitioner_id, 1, now())
  ON CONFLICT (tenant_id, practice_id, practitioner_id)
  DO UPDATE SET seq = s.seq + 1, changed_at = now();
  RETURN NULL;
END $$;
CREATE TRIGGER appointments_signal AFTER INSERT OR UPDATE OF status ON scheduling.appointments
  FOR EACH ROW EXECUTE FUNCTION scheduling.touch_schedule_signal();
CREATE TRIGGER schedule_blocks_signal AFTER INSERT OR UPDATE ON scheduling.schedule_blocks
  FOR EACH ROW EXECUTE FUNCTION scheduling.touch_schedule_signal();
CREATE TRIGGER availability_exceptions_signal AFTER INSERT OR UPDATE ON scheduling.availability_exceptions
  FOR EACH ROW EXECUTE FUNCTION scheduling.touch_schedule_signal();
CREATE TRIGGER availability_rules_signal AFTER INSERT OR UPDATE ON scheduling.availability_rules
  FOR EACH ROW EXECUTE FUNCTION scheduling.touch_schedule_signal();

-- TRUNCATE bypasses row triggers; forbid it on the history tables.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['appointments','slot_holds','appointment_events','appointment_participants',
                           'waitlist_entries','waitlist_offers','patient_referrals','referral_documents',
                           'availability_rules','availability_exceptions','schedule_blocks'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON scheduling.%I FOR EACH STATEMENT EXECUTE FUNCTION public.access_forbid_mutation()',
                   t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 10. Row-level security and least privilege.
-- ---------------------------------------------------------------------------

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['practitioners','practitioner_locations','appointment_types','appointment_type_practitioners',
                           'appointment_type_locations','availability_rules','availability_exceptions','schedule_blocks',
                           'patient_referrals','referral_documents','waitlist_entries','appointments','slot_holds',
                           'appointment_participants','appointment_events','waitlist_offers'] LOOP
    EXECUTE format('ALTER TABLE scheduling.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE scheduling.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON scheduling.%I USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant())', t);
    EXECUTE format('CREATE POLICY practice_scope ON scheduling.%I AS RESTRICTIVE TO access_request USING (practice_id = platform.current_practice()) WITH CHECK (practice_id = platform.current_practice())', t);
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA scheduling FROM PUBLIC;
-- API: configuration, bookings and staff decisions.
GRANT SELECT, INSERT, UPDATE ON scheduling.practitioners, scheduling.practitioner_locations, scheduling.appointment_types,
  scheduling.appointment_type_practitioners, scheduling.appointment_type_locations, scheduling.availability_rules,
  scheduling.availability_exceptions, scheduling.schedule_blocks, scheduling.patient_referrals,
  scheduling.referral_documents, scheduling.waitlist_entries, scheduling.appointments, scheduling.slot_holds,
  scheduling.waitlist_offers TO access_request;
GRANT SELECT, INSERT ON scheduling.appointment_participants, scheduling.appointment_events TO access_request;
-- Worker: hold/offer expiry, waitlist offers (holds through the Scheduling
-- Core), and reads for notifications and integrations.
GRANT SELECT ON scheduling.practitioners, scheduling.practitioner_locations, scheduling.appointment_types,
  scheduling.appointment_type_practitioners, scheduling.appointment_type_locations, scheduling.availability_rules,
  scheduling.availability_exceptions, scheduling.schedule_blocks, scheduling.patient_referrals TO access_worker;
GRANT SELECT, INSERT, UPDATE ON scheduling.appointments, scheduling.slot_holds, scheduling.waitlist_offers TO access_worker;
GRANT SELECT, UPDATE ON scheduling.waitlist_entries TO access_worker;
GRANT SELECT, INSERT ON scheduling.appointment_participants, scheduling.appointment_events TO access_worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA scheduling TO access_request, access_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA scheduling FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scheduling.appointment_transition_allowed(text, text) TO access_request, access_worker;
