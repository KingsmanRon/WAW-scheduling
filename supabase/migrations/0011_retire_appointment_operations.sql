-- 0011: retire appointment operations v1 (connector-based destination booking).
--
-- Appointments are booked, moved and cancelled only by the Scheduling Core
-- (schema scheduling). The v1 destination-booking tables from 0006 stay so
-- their history remains inspectable, but no runtime login can write them and
-- no new appointment-operations case can be opened. A later contract
-- migration drops them once every environment has applied this one and the
-- rows have been exported or judged disposable. Nothing here rewrites or
-- removes an existing row.

-- Read-only history for the runtime logins. Revoking a table privilege also
-- revokes the column-level UPDATE grants 0006 made on these tables.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON appointment_requests, appointments, appointment_slot_holds
  FROM access_request, access_worker;

-- Existing cases of the retired types stay as history (NOT VALID skips them),
-- and are frozen: any update of such a row is checked, and refused, too.
ALTER TABLE access_cases ADD CONSTRAINT access_cases_appointment_operations_retired
  CHECK (case_type NOT IN ('APPOINTMENT_REQUEST','RESCHEDULING_REQUEST','CANCELLATION_REQUEST')) NOT VALID;
