-- 0010: notifications, channel conversations and the integration boundary.
--
-- Channels (WhatsApp today, web later) never book anything themselves: their
-- messages are stored here and interpreted by the access layer, which asks
-- the Scheduling Core. Notification and integration work is durable queue
-- state written by the worker from outbox events. Additive only.

-- ---------------------------------------------------------------------------
-- 1. Notification preferences (consent) and deliveries.
-- ---------------------------------------------------------------------------

CREATE TABLE messaging.notification_preferences(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  -- Consent to business-initiated WhatsApp messages (confirmations,
  -- reminders, offers). Replies inside a patient-started conversation do not
  -- need it.
  whatsapp_opt_in boolean NOT NULL DEFAULT false,
  whatsapp_consent_source text CHECK (whatsapp_consent_source IS NULL OR whatsapp_consent_source IN
    ('STAFF_RECORDED','PATIENT_WHATSAPP','PATIENT_WEB')),
  whatsapp_consent_at timestamptz,
  email_opt_in boolean NOT NULL DEFAULT false,
  email_consent_source text CHECK (email_consent_source IS NULL OR email_consent_source IN ('STAFF_RECORDED','PATIENT_WEB')),
  email_consent_at timestamptz,
  reminders_enabled boolean NOT NULL DEFAULT true,
  preferred_channel text CHECK (preferred_channel IS NULL OR preferred_channel IN ('WHATSAPP','EMAIL')),
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, practice_id, patient_id),
  FOREIGN KEY (tenant_id, practice_id, patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  CONSTRAINT whatsapp_consent_recorded CHECK ((whatsapp_consent_source IS NULL) = (whatsapp_consent_at IS NULL)),
  CONSTRAINT whatsapp_opt_in_sourced CHECK (NOT whatsapp_opt_in OR whatsapp_consent_source IS NOT NULL),
  CONSTRAINT email_consent_recorded CHECK ((email_consent_source IS NULL) = (email_consent_at IS NULL)),
  CONSTRAINT email_opt_in_sourced CHECK (NOT email_opt_in OR email_consent_source IS NOT NULL)
);
CREATE TRIGGER notification_preferences_version BEFORE UPDATE ON messaging.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER notification_preferences_no_delete BEFORE DELETE ON messaging.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();

CREATE TABLE messaging.notification_deliveries(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  notification_type text NOT NULL CHECK (notification_type IN ('APPOINTMENT_CONFIRMATION','APPOINTMENT_RESCHEDULED',
    'APPOINTMENT_CANCELLED','APPOINTMENT_REMINDER_24H','APPOINTMENT_REMINDER_NEAR_TERM','WAITLIST_OFFER')),
  channel text NOT NULL CHECK (channel IN ('WHATSAPP','EMAIL')),
  provider text NOT NULL CHECK (provider IN ('WHATSAPP_CLOUD','SMTP')),
  patient_id uuid NOT NULL,
  appointment_id uuid,
  waitlist_offer_id uuid,
  recipient_contact_id uuid,
  -- Snapshot of the address the message was (or would be) sent to.
  recipient_address text,
  connection_id uuid,
  template_name text NOT NULL CHECK (template_name ~ '^[a-z0-9_]{1,120}$'),
  template_language text NOT NULL CHECK (template_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  -- Positional template parameters (display strings). Redacted after the
  -- retention period.
  template_params jsonb,
  status text NOT NULL CHECK (status IN ('PENDING','PROCESSING','SENT','DELIVERED','READ','FAILED','CANCELLED','SKIPPED')),
  scheduled_for timestamptz NOT NULL,
  -- The appointment start the message refers to; the sender re-checks it so a
  -- reminder for a moved or cancelled appointment is never sent.
  appointment_starts_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at timestamptz NOT NULL,
  lease_until timestamptz,
  provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 200),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{2,64}$'),
  last_error_detail text CHECK (last_error_detail IS NULL OR length(last_error_detail) <= 300),
  skip_reason text CHECK (skip_reason IS NULL OR skip_reason IN ('NO_CONSENT','NO_CONTACT','CHANNEL_NOT_CONFIGURED',
    'REMINDERS_DISABLED','APPOINTMENT_CHANGED','TOO_LATE','PATIENT_ARCHIVED')),
  dedup_key text NOT NULL CHECK (length(dedup_key) BETWEEN 8 AND 300),
  source_event_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  redacted_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, appointment_id) REFERENCES scheduling.appointments(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, waitlist_offer_id) REFERENCES scheduling.waitlist_offers(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, recipient_contact_id) REFERENCES directory.patient_contacts(tenant_id, practice_id, id),
  UNIQUE (tenant_id, practice_id, dedup_key),
  CONSTRAINT delivery_skipped_reason CHECK ((status = 'SKIPPED') = (skip_reason IS NOT NULL)),
  CONSTRAINT delivery_sent_reference CHECK (status NOT IN ('SENT','DELIVERED','READ') OR (provider_message_id IS NOT NULL AND sent_at IS NOT NULL)),
  CONSTRAINT delivery_failed_time CHECK ((status = 'FAILED') = (failed_at IS NOT NULL)),
  CONSTRAINT delivery_cancelled_time CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  CONSTRAINT delivery_lease CHECK (status <> 'PROCESSING' OR lease_until IS NOT NULL),
  CONSTRAINT delivery_addressed CHECK (status IN ('SKIPPED','CANCELLED') OR recipient_address IS NOT NULL OR redacted_at IS NOT NULL)
);
CREATE UNIQUE INDEX notification_deliveries_provider_message ON messaging.notification_deliveries(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX notification_deliveries_due ON messaging.notification_deliveries(tenant_id, next_attempt_at)
  WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX notification_deliveries_appointment ON messaging.notification_deliveries(tenant_id, practice_id, appointment_id)
  WHERE appointment_id IS NOT NULL;
CREATE INDEX notification_deliveries_failed ON messaging.notification_deliveries(tenant_id, failed_at) WHERE status = 'FAILED';
CREATE TRIGGER notification_deliveries_version BEFORE UPDATE ON messaging.notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER notification_deliveries_no_delete BEFORE DELETE ON messaging.notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();
CREATE OR REPLACE FUNCTION messaging.delivery_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.practice_id, NEW.id, NEW.notification_type, NEW.channel, NEW.provider, NEW.patient_id,
         NEW.appointment_id, NEW.waitlist_offer_id, NEW.dedup_key, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.practice_id, OLD.id, OLD.notification_type, OLD.channel, OLD.provider, OLD.patient_id,
         OLD.appointment_id, OLD.waitlist_offer_id, OLD.dedup_key, OLD.created_at) THEN
    RAISE EXCEPTION 'delivery identity is immutable' USING ERRCODE = 'SCH03';
  END IF;
  IF OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN
    RAISE EXCEPTION 'a provider message reference is final' USING ERRCODE = 'SCH03';
  END IF;
  -- Terminal states are final; provider status only moves forward.
  IF OLD.status IN ('FAILED','CANCELLED','SKIPPED','READ') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a % delivery is final', OLD.status USING ERRCODE = 'SCH02';
  END IF;
  IF (OLD.status = 'DELIVERED' AND NEW.status NOT IN ('DELIVERED','READ'))
     OR (OLD.status = 'SENT' AND NEW.status NOT IN ('SENT','DELIVERED','READ','FAILED')) THEN
    RAISE EXCEPTION 'delivery status cannot move back from % to %', OLD.status, NEW.status USING ERRCODE = 'SCH02';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_deliveries_guard BEFORE UPDATE ON messaging.notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION messaging.delivery_guard();

-- ---------------------------------------------------------------------------
-- 2. Integration connections and routing.
-- ---------------------------------------------------------------------------

CREATE TABLE integration.connections(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('WHATSAPP_CLOUD','EMR_WEBHOOK')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  -- Provider configuration validated by packages/integrations. Never secrets.
  config jsonb NOT NULL,
  -- Name of the environment variable (secret manager) holding this
  -- connection's credential, e.g. WHATSAPP_ACCESS_TOKEN. Never the value.
  secret_ref text CHECK (secret_ref IS NULL OR secret_ref ~ '^[A-Z][A-Z0-9_]{2,100}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id) REFERENCES directory.practices(tenant_id, id),
  UNIQUE (id),
  CONSTRAINT connection_config_object CHECK (jsonb_typeof(config) = 'object')
);
CREATE UNIQUE INDEX connections_one_active_whatsapp ON integration.connections(tenant_id, practice_id)
  WHERE provider = 'WHATSAPP_CLOUD' AND status = 'ACTIVE';
CREATE TRIGGER connections_version BEFORE UPDATE ON integration.connections
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER connections_no_delete BEFORE DELETE ON integration.connections
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();
CREATE OR REPLACE FUNCTION integration.connection_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.practice_id <> OLD.practice_id OR NEW.id <> OLD.id
     OR NEW.provider <> OLD.provider OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'connection identity is immutable' USING ERRCODE = 'SCH03';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connections_guard BEFORE UPDATE ON integration.connections
  FOR EACH ROW EXECUTE FUNCTION integration.connection_guard();

-- Inbound routing directory: which organisation/practice/connection a
-- provider address belongs to (a WhatsApp phone_number_id, or an EMR
-- connection id in a callback URL). Needed before any tenant context exists;
-- it holds identifiers only. WhatsApp routes are provisioned by the operator
-- (the business number belongs to the platform's Meta app); the API may
-- register only EMR routes for its own practice.
CREATE TABLE integration.channel_routes(
  provider text NOT NULL CHECK (provider IN ('WHATSAPP_CLOUD','EMR_WEBHOOK')),
  route_key text NOT NULL CHECK (route_key ~ '^[A-Za-z0-9_-]{1,100}$'),
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, route_key),
  FOREIGN KEY (tenant_id, practice_id, connection_id) REFERENCES integration.connections(tenant_id, practice_id, id)
);
ALTER TABLE integration.channel_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY route_lookup ON integration.channel_routes FOR SELECT TO access_request, access_worker USING (true);
CREATE POLICY emr_route_insert ON integration.channel_routes FOR INSERT TO access_request
  WITH CHECK (provider = 'EMR_WEBHOOK' AND route_key = connection_id::text
              AND tenant_id = platform.current_tenant() AND practice_id = platform.current_practice());
CREATE POLICY emr_route_update ON integration.channel_routes FOR UPDATE TO access_request
  USING (provider = 'EMR_WEBHOOK' AND tenant_id = platform.current_tenant() AND practice_id = platform.current_practice())
  WITH CHECK (provider = 'EMR_WEBHOOK' AND route_key = connection_id::text
              AND tenant_id = platform.current_tenant() AND practice_id = platform.current_practice());
CREATE OR REPLACE FUNCTION integration.route_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'routes are deactivated, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.provider <> OLD.provider OR NEW.route_key <> OLD.route_key OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.practice_id <> OLD.practice_id OR NEW.connection_id <> OLD.connection_id THEN
    RAISE EXCEPTION 'a route cannot be re-pointed; deactivate it and create another' USING ERRCODE = 'SCH03';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER channel_routes_guard BEFORE UPDATE OR DELETE ON integration.channel_routes
  FOR EACH ROW EXECUTE FUNCTION integration.route_guard();

-- Integration events: outbound pushes to an external system (e.g. an EMR)
-- and inbound callbacks, with delivery state and bounded retries.
CREATE TABLE integration.events(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  connection_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('OUTBOUND','INBOUND')),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,80}$'),
  source_event_id bigint,
  dedup_key text NOT NULL CHECK (length(dedup_key) BETWEEN 8 AND 300),
  payload jsonb,
  status text NOT NULL CHECK (status IN ('PENDING','PROCESSING','DELIVERED','FAILED','PROCESSED','REJECTED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 30),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{2,64}$'),
  last_error_detail text CHECK (last_error_detail IS NULL OR length(last_error_detail) <= 300),
  response_status integer,
  external_reference text CHECK (external_reference IS NULL OR length(external_reference) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  redacted_at timestamptz,
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, connection_id) REFERENCES integration.connections(tenant_id, practice_id, id),
  UNIQUE (tenant_id, practice_id, connection_id, dedup_key),
  CONSTRAINT integration_event_direction_status CHECK (
    (direction = 'OUTBOUND' AND status IN ('PENDING','PROCESSING','DELIVERED','FAILED'))
    OR (direction = 'INBOUND' AND status IN ('PROCESSED','REJECTED'))),
  CONSTRAINT integration_event_completed CHECK ((status IN ('DELIVERED','FAILED','PROCESSED','REJECTED')) = (completed_at IS NOT NULL)),
  CONSTRAINT integration_event_lease CHECK (status <> 'PROCESSING' OR lease_until IS NOT NULL),
  CONSTRAINT integration_event_schedule CHECK (status NOT IN ('PENDING','PROCESSING') OR next_attempt_at IS NOT NULL)
);
CREATE INDEX integration_events_due ON integration.events(tenant_id, next_attempt_at) WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX integration_events_failed ON integration.events(tenant_id, completed_at) WHERE status = 'FAILED';
CREATE TRIGGER integration_events_no_delete BEFORE DELETE ON integration.events
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();

-- Provider webhook receipts: a provider event (message status, callback) is
-- processed at most once.
CREATE TABLE integration.webhook_receipts(
  tenant_id uuid NOT NULL REFERENCES public.organisations(id),
  provider text NOT NULL CHECK (provider IN ('WHATSAPP_CLOUD','EMR_WEBHOOK')),
  receipt_key text NOT NULL CHECK (length(receipt_key) BETWEEN 1 AND 300),
  practice_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, receipt_key)
);
CREATE INDEX webhook_receipts_age ON integration.webhook_receipts(tenant_id, received_at);

-- ---------------------------------------------------------------------------
-- 3. Channel conversations and messages. Message bodies are operational
--    data with a retention limit (redacted by the worker), not a clinical
--    record.
-- ---------------------------------------------------------------------------

CREATE TABLE messaging.channel_conversations(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('WHATSAPP')),
  connection_id uuid NOT NULL,
  -- The participant's address on the channel (WhatsApp: E.164 of wa_id).
  participant_address text NOT NULL CHECK (participant_address ~ '^\+[1-9][0-9]{6,14}$'),
  patient_id uuid,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','NEEDS_STAFF','CLOSED')),
  needs_staff_reason text CHECK (needs_staff_reason IS NULL OR needs_staff_reason IN
    ('PATIENT_REQUESTED_STAFF','SAFETY_CONCERN','NOT_UNDERSTOOD','IDENTITY_UNCLEAR','BOOKING_FAILED')),
  -- Access-layer dialogue state (pending options, the hold being confirmed).
  state text NOT NULL DEFAULT 'IDLE' CHECK (state ~ '^[A-Z_]{2,40}$'),
  state_data jsonb NOT NULL DEFAULT '{}',
  state_expires_at timestamptz,
  language text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2,3}$'),
  -- WhatsApp's customer-service window opens with each inbound message.
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, connection_id) REFERENCES integration.connections(tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, patient_id) REFERENCES directory.patients(tenant_id, practice_id, id),
  UNIQUE (tenant_id, practice_id, connection_id, participant_address),
  CONSTRAINT conversation_needs_staff CHECK ((status = 'NEEDS_STAFF') = (needs_staff_reason IS NOT NULL))
);
CREATE INDEX channel_conversations_needs_staff ON messaging.channel_conversations(tenant_id, practice_id, updated_at)
  WHERE status = 'NEEDS_STAFF';
CREATE TRIGGER channel_conversations_version BEFORE UPDATE ON messaging.channel_conversations
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_version_increment();
CREATE TRIGGER channel_conversations_no_delete BEFORE DELETE ON messaging.channel_conversations
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();

CREATE TABLE messaging.channel_messages(
  tenant_id uuid NOT NULL,
  practice_id uuid NOT NULL,
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  provider text NOT NULL CHECK (provider IN ('WHATSAPP_CLOUD')),
  provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 200),
  message_type text NOT NULL CHECK (message_type IN ('TEXT','BUTTON_REPLY','LIST_REPLY','INTERACTIVE','UNSUPPORTED')),
  body text CHECK (body IS NULL OR length(body) <= 4096),
  -- Structured content: interactive reply ids, outbound interactive options.
  payload jsonb,
  status text NOT NULL CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','FAILED','PENDING','SENDING','SENT',
                                         'DELIVERED','READ')),
  sent_by text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{2,64}$'),
  provider_timestamp timestamptz,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  redacted_at timestamptz,
  PRIMARY KEY (tenant_id, practice_id, id),
  FOREIGN KEY (tenant_id, practice_id, conversation_id) REFERENCES messaging.channel_conversations(tenant_id, practice_id, id),
  CONSTRAINT message_direction_status CHECK (
    (direction = 'INBOUND' AND status IN ('RECEIVED','PROCESSING','PROCESSED','FAILED'))
    OR (direction = 'OUTBOUND' AND status IN ('PENDING','SENDING','SENT','DELIVERED','READ','FAILED'))),
  CONSTRAINT inbound_has_provider_id CHECK (direction = 'OUTBOUND' OR provider_message_id IS NOT NULL),
  CONSTRAINT outbound_sent_reference CHECK (status NOT IN ('SENT','DELIVERED','READ') OR provider_message_id IS NOT NULL),
  CONSTRAINT message_lease CHECK (status NOT IN ('PROCESSING','SENDING') OR lease_until IS NOT NULL)
);
-- Provider message ids are globally unique: duplicate webhooks are no-ops and
-- status callbacks find their message.
CREATE UNIQUE INDEX channel_messages_provider_id ON messaging.channel_messages(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX channel_messages_conversation ON messaging.channel_messages(tenant_id, practice_id, conversation_id, created_at);
CREATE INDEX channel_messages_inbound_due ON messaging.channel_messages(tenant_id, created_at)
  WHERE direction = 'INBOUND' AND status IN ('RECEIVED','PROCESSING');
CREATE INDEX channel_messages_outbound_due ON messaging.channel_messages(tenant_id, next_attempt_at)
  WHERE direction = 'OUTBOUND' AND status IN ('PENDING','SENDING');
CREATE INDEX channel_messages_retention ON messaging.channel_messages(tenant_id, created_at) WHERE redacted_at IS NULL;
CREATE TRIGGER channel_messages_no_delete BEFORE DELETE ON messaging.channel_messages
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_delete();
CREATE OR REPLACE FUNCTION messaging.message_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.practice_id, NEW.id, NEW.conversation_id, NEW.direction, NEW.provider,
         NEW.message_type, NEW.correlation_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.practice_id, OLD.id, OLD.conversation_id, OLD.direction, OLD.provider,
         OLD.message_type, OLD.correlation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'message identity is immutable' USING ERRCODE = 'SCH03';
  END IF;
  IF OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN
    RAISE EXCEPTION 'a provider message reference is final' USING ERRCODE = 'SCH03';
  END IF;
  -- Content may only be removed (retention), never rewritten.
  IF (NEW.body IS DISTINCT FROM OLD.body AND NEW.body IS NOT NULL)
     OR (NEW.payload IS DISTINCT FROM OLD.payload AND NEW.payload IS NOT NULL) THEN
    RAISE EXCEPTION 'message content is immutable' USING ERRCODE = 'SCH03';
  END IF;
  IF (NEW.body IS DISTINCT FROM OLD.body OR NEW.payload IS DISTINCT FROM OLD.payload) AND NEW.redacted_at IS NULL THEN
    RAISE EXCEPTION 'content removal must be recorded as a redaction' USING ERRCODE = 'SCH03';
  END IF;
  IF (OLD.status = 'READ' AND NEW.status <> 'READ')
     OR (OLD.status = 'DELIVERED' AND NEW.status NOT IN ('DELIVERED','READ'))
     OR (OLD.status IN ('PROCESSED','FAILED') AND NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'message status cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'SCH02';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_messages_guard BEFORE UPDATE ON messaging.channel_messages
  FOR EACH ROW EXECUTE FUNCTION messaging.message_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['notification_deliveries','channel_messages','channel_conversations','notification_preferences'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON messaging.%I FOR EACH STATEMENT EXECUTE FUNCTION public.access_forbid_mutation()',
                   t || '_no_truncate', t);
  END LOOP;
END $$;
CREATE TRIGGER integration_events_no_truncate BEFORE TRUNCATE ON integration.events
  FOR EACH STATEMENT EXECUTE FUNCTION public.access_forbid_mutation();

-- ---------------------------------------------------------------------------
-- 4. Row-level security and least privilege.
-- ---------------------------------------------------------------------------

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['messaging.notification_preferences','messaging.notification_deliveries',
                           'messaging.channel_conversations','messaging.channel_messages',
                           'integration.connections','integration.events','integration.webhook_receipts'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['messaging.notification_preferences','messaging.notification_deliveries',
                           'messaging.channel_conversations','messaging.channel_messages',
                           'integration.connections','integration.events'] LOOP
    EXECUTE format('CREATE POLICY practice_scope ON %s AS RESTRICTIVE TO access_request USING (practice_id = platform.current_practice()) WITH CHECK (practice_id = platform.current_practice())', t);
  END LOOP;
END $$;
CREATE POLICY request_scope ON integration.webhook_receipts AS RESTRICTIVE TO access_request
  USING (practice_id IS NOT DISTINCT FROM platform.current_practice())
  WITH CHECK (practice_id IS NOT DISTINCT FROM platform.current_practice());
CREATE POLICY worker_purge_old ON integration.webhook_receipts AS RESTRICTIVE FOR DELETE TO access_worker
  USING (received_at < now() - interval '30 days');

REVOKE ALL ON ALL TABLES IN SCHEMA messaging FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA integration FROM PUBLIC;
-- API: webhooks record inbound messages and provider statuses; staff manage
-- preferences, reply in conversations and configure integrations.
GRANT SELECT, INSERT, UPDATE ON messaging.notification_preferences, messaging.channel_conversations,
  messaging.channel_messages TO access_request;
GRANT SELECT, UPDATE ON messaging.notification_deliveries TO access_request;
GRANT SELECT, INSERT, UPDATE ON integration.connections TO access_request;
GRANT SELECT, INSERT, UPDATE ON integration.channel_routes TO access_request;
GRANT SELECT, INSERT ON integration.events, integration.webhook_receipts TO access_request;
-- Worker: plans and sends notifications, runs conversations, delivers
-- integration events, applies retention.
GRANT SELECT ON messaging.notification_preferences, integration.connections, integration.channel_routes TO access_worker;
GRANT SELECT, INSERT, UPDATE ON messaging.notification_deliveries, messaging.channel_messages,
  integration.events TO access_worker;
GRANT SELECT, UPDATE ON messaging.channel_conversations TO access_worker;
GRANT SELECT, DELETE ON integration.webhook_receipts TO access_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA messaging FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA integration FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 5. Supabase browser roles. Browsers never read or write scheduling data
--    directly; the only grant is the schedule change signal, streamed by
--    Supabase Realtime to signed-in members of the practice so consoles
--    refresh. Skipped on plain PostgreSQL (no such roles/publication).
-- ---------------------------------------------------------------------------

DO $$
DECLARE r text; s text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH s IN ARRAY ARRAY['platform','directory','scheduling','messaging','integration'] LOOP
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s, r);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', s, r);
        EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', s, r);
        EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', s, r);
      END LOOP;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT USAGE ON SCHEMA platform, directory, scheduling TO authenticated;
    -- Policies on the membership table reference the request-context
    -- helpers; they only read the caller's own (unset) session settings.
    GRANT EXECUTE ON FUNCTION platform.jwt_sub(), platform.uuid_or_null(text), platform.current_tenant(),
      platform.current_practice(), platform.current_user_uuid(), platform.current_actor_role() TO authenticated;
    GRANT SELECT ON directory.practice_memberships TO authenticated;
    GRANT SELECT ON scheduling.schedule_signals TO authenticated;
    CREATE POLICY jwt_self_read ON directory.practice_memberships FOR SELECT TO authenticated
      USING (user_id = platform.jwt_sub() AND status = 'ACTIVE');
    CREATE POLICY member_signal_read ON scheduling.schedule_signals FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM directory.practice_memberships m
                      WHERE m.tenant_id = schedule_signals.tenant_id AND m.practice_id = schedule_signals.practice_id
                        AND m.user_id = platform.jwt_sub() AND m.status = 'ACTIVE'));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE scheduling.schedule_signals;
  END IF;
END $$;
