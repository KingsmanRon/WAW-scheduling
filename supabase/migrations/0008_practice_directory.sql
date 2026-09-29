-- 0008: practice directory and patient registry.
--
-- Practices belong to an organisation (tenant); every practice-scoped row
-- carries (tenant_id, practice_id) and references its parents through
-- composite keys, so cross-practice references are impossible by
-- construction. Additive only.

-- ---------------------------------------------------------------------------
-- Practices and locations. Both carry an explicit IANA time zone; nothing
-- depends on the server's local time zone.
-- ---------------------------------------------------------------------------

CREATE TABLE directory.practices(
  tenant_id uuid NOT NULL REFERENCES public.organisations(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  contact_phone text CHECK (contact_phone IS NULL OR contact_phone ~ '^\+[1-9][0-9]{6,14}$'),
  contact_email text CHECK (contact_email IS NULL OR contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Scheduling policy (deterministic, administrative).
  hold_ttl_seconds integer NOT NULL DEFAULT 300 CHECK (hold_ttl_seconds BETWEEN 60 AND 1800),
  default_slot_interval_minutes integer NOT NULL DEFAULT 15 CHECK (default_slot_interval_minutes BETWEEN 5 AND 120),
  reminder_24h_enabled boolean NOT NULL DEFAULT true,
  near_term_reminder_minutes integer CHECK (near_term_reminder_minutes IS NULL OR near_term_reminder_minutes BETWEEN 15 AND 720),
  waitlist_offer_ttl_minutes integer NOT NULL DEFAULT 30 CHECK (waitlist_offer_ttl_minutes BETWEEN 5 AND 1440),
  referral_verification_required boolean NOT NULL DEFAULT true,
  -- Minimum notice for patient-initiated (channel) cancellation/reschedule.
  patient_change_cutoff_minutes integer NOT NULL DEFAULT 120 CHECK (patient_change_cutoff_minutes BETWEEN 0 AND 10080),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (id)
);
CREATE TRIGGER practices_timezone BEFORE INSERT OR UPDATE OF timezone ON directory.practices
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_timezone();
CREATE TRIGGER practices_version BEFORE UPDATE ON directory.practices
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER practices_no_delete BEFORE DELETE ON directory.practices
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();

CREATE TABLE directory.practice_locations(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  address_line1 text CHECK (address_line1 IS NULL OR length(address_line1) <= 200),
  address_line2 text CHECK (address_line2 IS NULL OR length(address_line2) <= 200),
  city text CHECK (city IS NULL OR length(city) <= 100),
  postal_code text CHECK (postal_code IS NULL OR length(postal_code) <= 20),
  phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id) REFERENCES directory.practices(tenant_id, id),
  UNIQUE (tenant_id, practice_id, name)
);
CREATE TRIGGER practice_locations_timezone BEFORE INSERT OR UPDATE OF timezone ON directory.practice_locations
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_timezone();
CREATE TRIGGER practice_locations_version BEFORE UPDATE ON directory.practice_locations
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER practice_locations_no_delete BEFORE DELETE ON directory.practice_locations
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();

-- ---------------------------------------------------------------------------
-- Practice memberships: Supabase Auth user -> practice + application role.
-- Authentication (a valid JWT) never implies authorisation; the role comes
-- from this table, server-side, on every request.
-- ---------------------------------------------------------------------------

CREATE TABLE directory.practice_memberships(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  -- auth.users.id of the verified workforce JWT subject.
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('PRACTICE_ADMIN','DOCTOR','RECEPTIONIST','CLINICAL_STAFF','READ_ONLY')),
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED')),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  email text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Links a DOCTOR/CLINICAL_STAFF login to the practitioner they are (0009).
  practitioner_id uuid,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, practice_id, user_id),
  FOREIGN KEY (tenant_id, practice_id) REFERENCES directory.practices(tenant_id, id)
);
CREATE INDEX practice_memberships_user ON directory.practice_memberships(user_id) WHERE status = 'ACTIVE';
CREATE TRIGGER practice_memberships_version BEFORE UPDATE ON directory.practice_memberships
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER practice_memberships_no_delete BEFORE DELETE ON directory.practice_memberships
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();

-- ---------------------------------------------------------------------------
-- Patient registry. Patients are practice-scoped. Identity is established by
-- normalised contact points and identifiers, never by merging similar names;
-- potential duplicates are recorded for human review.
-- ---------------------------------------------------------------------------

-- Per-practice sequences (patient numbers).
CREATE TABLE directory.practice_counters(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  counter text NOT NULL CHECK (counter IN ('patient_number')),
  value bigint NOT NULL CHECK (value >= 0),
  PRIMARY KEY (tenant_id, practice_id, counter),
  FOREIGN KEY (tenant_id, practice_id) REFERENCES directory.practices(tenant_id, id)
);

CREATE TABLE directory.patients(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  patient_number text NOT NULL CHECK (patient_number ~ '^[A-Z0-9-]{3,32}$'),
  given_name text NOT NULL CHECK (length(btrim(given_name)) BETWEEN 1 AND 100),
  family_name text NOT NULL CHECK (length(btrim(family_name)) BETWEEN 1 AND 100),
  preferred_name text CHECK (preferred_name IS NULL OR length(btrim(preferred_name)) BETWEEN 1 AND 100),
  date_of_birth date CHECK (date_of_birth IS NULL OR date_of_birth BETWEEN DATE '1900-01-01' AND DATE '2200-01-01'),
  administrative_sex text CHECK (administrative_sex IS NULL OR administrative_sex IN ('FEMALE','MALE','OTHER','UNKNOWN')),
  preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  -- UNVERIFIED: self-registered through a channel (e.g. WhatsApp) or not yet
  -- checked; STAFF_VERIFIED: identity confirmed by staff.
  identity_verification text NOT NULL DEFAULT 'UNVERIFIED' CHECK (identity_verification IN ('UNVERIFIED','STAFF_VERIFIED')),
  source_channel text NOT NULL CHECK (source_channel IN ('PHONE','WALK_IN','WHATSAPP','WEB','INTERNAL','REFERRAL','OTHER','IMPORT')),
  family_name_key text GENERATED ALWAYS AS (lower(btrim(family_name))) STORED,
  given_name_key text GENERATED ALWAYS AS (lower(btrim(given_name))) STORED,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id) REFERENCES directory.practices(tenant_id, id),
  UNIQUE (tenant_id, practice_id, patient_number)
);
-- Prefix search by name (paginated), and exact date of birth.
CREATE INDEX patients_family_name ON directory.patients(tenant_id, practice_id, family_name_key text_pattern_ops, given_name_key, id);
CREATE INDEX patients_given_name ON directory.patients(tenant_id, practice_id, given_name_key text_pattern_ops, id);
CREATE INDEX patients_birth_date ON directory.patients(tenant_id, practice_id, date_of_birth) WHERE date_of_birth IS NOT NULL;
CREATE TRIGGER patients_version BEFORE UPDATE ON directory.patients
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER patients_no_delete BEFORE DELETE ON directory.patients
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();
CREATE OR REPLACE FUNCTION directory.patient_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.practice_id <> OLD.practice_id OR NEW.id <> OLD.id
     OR NEW.patient_number <> OLD.patient_number OR NEW.created_at <> OLD.created_at
     OR NEW.created_by <> OLD.created_by OR NEW.source_channel <> OLD.source_channel THEN
    RAISE EXCEPTION 'patient identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patients_identity BEFORE UPDATE ON directory.patients
  FOR EACH ROW EXECUTE FUNCTION directory.patient_identity_guard();

-- Contact points, normalised by the application: phones in E.164, e-mail in
-- lower case. Several patients may share a number (families); lookups by
-- number therefore return candidates, never an automatic match.
CREATE TABLE directory.patient_contacts(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  patient_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('MOBILE','EMAIL','LANDLINE')),
  value text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  whatsapp_capable boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  verification_method text CHECK (verification_method IS NULL OR verification_method IN ('WHATSAPP_INBOUND','STAFF')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by text,
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  CONSTRAINT contact_email_shape CHECK (kind <> 'EMAIL' OR (value ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND value = lower(value))),
  CONSTRAINT contact_phone_shape CHECK (kind = 'EMAIL' OR value ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT contact_whatsapp_is_mobile CHECK (kind = 'MOBILE' OR NOT whatsapp_capable),
  CONSTRAINT contact_verification_complete CHECK ((verified_at IS NULL) = (verification_method IS NULL)),
  CONSTRAINT contact_removal_complete CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX patient_contacts_active_unique ON directory.patient_contacts(tenant_id, practice_id, patient_id, kind, value)
  WHERE removed_at IS NULL;
CREATE UNIQUE INDEX patient_contacts_one_primary ON directory.patient_contacts(tenant_id, practice_id, patient_id, kind)
  WHERE is_primary AND removed_at IS NULL;
CREATE INDEX patient_contacts_lookup ON directory.patient_contacts(tenant_id, practice_id, kind, value)
  WHERE removed_at IS NULL;
CREATE OR REPLACE FUNCTION directory.contact_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.practice_id <> OLD.practice_id OR NEW.id <> OLD.id
     OR NEW.patient_id <> OLD.patient_id OR NEW.kind <> OLD.kind OR NEW.value <> OLD.value
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a contact point is immutable; remove it and add a new one' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a removed contact point is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_contacts_guard BEFORE UPDATE ON directory.patient_contacts
  FOR EACH ROW EXECUTE FUNCTION directory.contact_guard();
CREATE TRIGGER patient_contacts_no_delete BEFORE DELETE ON directory.patient_contacts
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();

-- Identifiers. National ID and passport numbers are stored only as keyed
-- HMAC-SHA256 digests (exact-match search without holding the number) plus
-- a short hint; EXTERNAL references (e.g. an EMR file number) are stored in
-- clear because integrations must echo them.
CREATE TABLE directory.patient_identifiers(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  patient_id uuid NOT NULL,
  system text NOT NULL CHECK (system IN ('NATIONAL_ID','PASSPORT','EXTERNAL')),
  -- ISO country for NATIONAL_ID/PASSPORT; the external system's name otherwise.
  issuer text NOT NULL CHECK (issuer ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  value_hash text NOT NULL CHECK (value_hash ~ '^[0-9a-f]{64}$'),
  hash_key_id text NOT NULL CHECK (hash_key_id ~ '^[A-Za-z0-9_.-]{1,40}$'),
  value text CHECK (value IS NULL OR length(value) BETWEEN 1 AND 120),
  value_hint text CHECK (value_hint IS NULL OR length(value_hint) <= 8),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by text,
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  CONSTRAINT identifier_clear_value_external_only CHECK ((system = 'EXTERNAL') = (value IS NOT NULL)),
  CONSTRAINT identifier_removal_complete CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
-- A strong identifier belongs to one patient per practice.
CREATE UNIQUE INDEX patient_identifiers_unique ON directory.patient_identifiers(tenant_id, practice_id, system, issuer, value_hash)
  WHERE removed_at IS NULL;
CREATE INDEX patient_identifiers_patient ON directory.patient_identifiers(tenant_id, practice_id, patient_id);
CREATE OR REPLACE FUNCTION directory.identifier_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.practice_id <> OLD.practice_id OR NEW.id <> OLD.id
     OR NEW.patient_id <> OLD.patient_id OR NEW.system <> OLD.system OR NEW.issuer <> OLD.issuer
     OR NEW.value_hash <> OLD.value_hash OR NEW.value IS DISTINCT FROM OLD.value OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an identifier is immutable; remove it and add a new one' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a removed identifier is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_identifiers_guard BEFORE UPDATE ON directory.patient_identifiers
  FOR EACH ROW EXECUTE FUNCTION directory.identifier_guard();
CREATE TRIGGER patient_identifiers_no_delete BEFORE DELETE ON directory.patient_identifiers
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();

-- Potential duplicates for human review. Nothing is merged automatically.
CREATE TABLE directory.patient_duplicate_candidates(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  patient_id uuid NOT NULL,
  candidate_patient_id uuid NOT NULL,
  reasons text[] NOT NULL CHECK (cardinality(reasons) >= 1
    AND reasons <@ ARRAY['MOBILE','EMAIL','NAME_AND_DATE_OF_BIRTH']::text[]),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DISMISSED','CONFIRMED')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz,
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, candidate_patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  CONSTRAINT duplicate_distinct CHECK (patient_id <> candidate_patient_id),
  CONSTRAINT duplicate_review_complete CHECK ((status = 'OPEN') = (reviewed_at IS NULL AND reviewed_by IS NULL))
);
CREATE UNIQUE INDEX patient_duplicate_pair ON directory.patient_duplicate_candidates(
  tenant_id, practice_id, LEAST(patient_id, candidate_patient_id), GREATEST(patient_id, candidate_patient_id));
CREATE INDEX patient_duplicate_open ON directory.patient_duplicate_candidates(tenant_id, practice_id, detected_at)
  WHERE status = 'OPEN';
CREATE TRIGGER patient_duplicates_no_delete BEFORE DELETE ON directory.patient_duplicate_candidates
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['directory.practices','directory.practice_locations','directory.practice_memberships',
                           'directory.practice_counters','directory.patients','directory.patient_contacts',
                           'directory.patient_identifiers','directory.patient_duplicate_candidates'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  -- Practice-scoped tables: tenant for everyone, plus practice for the API.
  FOREACH t IN ARRAY ARRAY['directory.practice_locations','directory.practice_counters','directory.patients',
                           'directory.patient_contacts','directory.patient_identifiers',
                           'directory.patient_duplicate_candidates'] LOOP
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant())', t);
    EXECUTE format('CREATE POLICY practice_scope ON %s AS RESTRICTIVE TO access_request USING (practice_id = platform.current_practice()) WITH CHECK (practice_id = platform.current_practice())', t);
  END LOOP;
END $$;

-- Practices: readable by tenant context (an organisation's own practice
-- list), or by a signed-in member resolving which practices they belong to
-- (no tenant context yet). Once the API acts for a practice it sees only
-- that practice, and it can change only that practice.
CREATE POLICY tenant_isolation ON directory.practices
  USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant());
CREATE POLICY member_read ON directory.practices FOR SELECT
  USING (EXISTS (SELECT 1 FROM directory.practice_memberships m
                  WHERE m.tenant_id = practices.tenant_id AND m.practice_id = practices.id
                    AND m.user_id = platform.current_user_uuid() AND m.status = 'ACTIVE'));
CREATE POLICY practice_scope ON directory.practices AS RESTRICTIVE TO access_request
  USING (platform.current_practice() IS NULL OR id = platform.current_practice())
  WITH CHECK (id = platform.current_practice());

-- Memberships: a user reads their own rows (login resolution, no tenant
-- context); practice staff lists are read in practice context; writes
-- require the transaction's actor role to be PRACTICE_ADMIN, so no other
-- role can grant or raise privileges even through an application bug.
CREATE POLICY self_read ON directory.practice_memberships FOR SELECT
  USING (user_id = platform.current_user_uuid());
CREATE POLICY tenant_read ON directory.practice_memberships FOR SELECT
  USING (tenant_id = platform.current_tenant());
CREATE POLICY admin_insert ON directory.practice_memberships FOR INSERT
  WITH CHECK (tenant_id = platform.current_tenant() AND platform.current_actor_role() = 'PRACTICE_ADMIN');
CREATE POLICY admin_update ON directory.practice_memberships FOR UPDATE
  USING (tenant_id = platform.current_tenant() AND platform.current_actor_role() = 'PRACTICE_ADMIN')
  WITH CHECK (tenant_id = platform.current_tenant() AND platform.current_actor_role() = 'PRACTICE_ADMIN');
CREATE POLICY practice_scope ON directory.practice_memberships AS RESTRICTIVE TO access_request
  USING (practice_id = platform.current_practice() OR (platform.current_practice() IS NULL AND platform.current_tenant() IS NULL))
  WITH CHECK (practice_id = platform.current_practice());

-- ---------------------------------------------------------------------------
-- Least privilege. Practices are created by the operator bootstrap only.
-- The worker reads what it needs to render notifications and never sees
-- memberships or duplicate reviews.
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA directory FROM PUBLIC;
GRANT SELECT, UPDATE ON directory.practices TO access_request;
GRANT SELECT, INSERT, UPDATE ON directory.practice_locations, directory.practice_memberships, directory.practice_counters,
  directory.patients, directory.patient_contacts, directory.patient_identifiers,
  directory.patient_duplicate_candidates TO access_request;
GRANT SELECT ON directory.practices, directory.practice_locations, directory.patients, directory.patient_contacts,
  directory.patient_identifiers TO access_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA directory FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA directory TO access_request, access_worker;
