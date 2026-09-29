-- 0012: notification worker refinements. Additive: no rows exist yet that
-- the new constraints could reject (deliveries are written only by the
-- worker introduced with this migration).
--
-- - RECIPIENT_NOT_ALLOWED: synthetic-data environments message only
--   allow-listed test recipients; everyone else is skipped, visibly.
-- - CONFIRMED_IN_CONVERSATION: a change made inside the patient's WhatsApp
--   conversation was already confirmed there; no template repeats it.
-- - cancel_reason: why a planned message was withdrawn before sending.

ALTER TABLE messaging.notification_deliveries DROP CONSTRAINT notification_deliveries_skip_reason_check;
ALTER TABLE messaging.notification_deliveries ADD CONSTRAINT notification_deliveries_skip_reason_check
  CHECK (skip_reason IS NULL OR skip_reason IN ('NO_CONSENT','NO_CONTACT','CHANNEL_NOT_CONFIGURED',
    'REMINDERS_DISABLED','APPOINTMENT_CHANGED','TOO_LATE','PATIENT_ARCHIVED','RECIPIENT_NOT_ALLOWED',
    'CONFIRMED_IN_CONVERSATION'));

ALTER TABLE messaging.notification_deliveries ADD COLUMN cancel_reason text
  CHECK (cancel_reason IS NULL OR cancel_reason IN ('APPOINTMENT_CANCELLED','APPOINTMENT_RESCHEDULED',
    'APPOINTMENT_CLOSED','OFFER_CLOSED'));
ALTER TABLE messaging.notification_deliveries ADD CONSTRAINT delivery_cancel_reason
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL));

-- Visibility for staff follow-up: failed and skipped messages of a practice.
CREATE INDEX notification_deliveries_practice_status ON messaging.notification_deliveries(tenant_id, practice_id, status, created_at DESC);

-- The membership-based read of practices exists for the API's login
-- resolution (a user with no tenant context yet). As a PUBLIC policy its
-- subquery on practice_memberships was permission-checked for every role,
-- so the worker - which must never read memberships - could not read
-- practices at all. Scope it to the API login.
ALTER POLICY member_read ON directory.practices TO access_request;
