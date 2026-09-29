-- 0013: privileges of the channel access layer (WhatsApp conversations),
-- which runs in the worker. Grants only; no schema change.

-- The worker books, holds, moves and cancels for patients through the
-- Scheduling Core, which serialises writers by locking the practitioner row
-- (FOR NO KEY UPDATE) and a booking's referral (FOR UPDATE). PostgreSQL
-- requires UPDATE privilege on at least one column for a row lock. Only
-- updated_at is granted, and the version triggers on both tables refuse any
-- update that does not also increase version: these grants lock, nothing
-- more.
GRANT UPDATE (updated_at) ON scheduling.practitioners TO access_worker;
GRANT UPDATE (updated_at) ON scheduling.patient_referrals TO access_worker;

-- A new patient may register from a WhatsApp conversation: an UNVERIFIED
-- patient with the WhatsApp number as contact. Possible duplicates are
-- recorded for staff review (never merged); staff verify identities.
GRANT SELECT, INSERT, UPDATE ON directory.practice_counters TO access_worker;
GRANT INSERT ON directory.patients, directory.patient_contacts, directory.patient_duplicate_candidates
  TO access_worker;
-- A known patient writing from their number confirms it is on WhatsApp.
GRANT UPDATE (is_primary, whatsapp_capable, verified_at, verification_method)
  ON directory.patient_contacts TO access_worker;

-- Consent the patient gives (or withdraws, e.g. STOP) in the conversation.
GRANT INSERT, UPDATE ON messaging.notification_preferences TO access_worker;
