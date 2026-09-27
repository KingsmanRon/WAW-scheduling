# Connector qualification guide

No real destination (PMS) connector is qualified, for referrals or for
appointments. The client pilot uses `CONNECTOR_KIND=none`, the manual
destination workflow and manual booking. A connector may be
enabled for real data only after every item below passes against the client's
test system, with evidence.

## Port

Implement `Connector` (`apps/worker/src/connector.ts`):
`capabilities()`, `execute(request)`, `reconcile(request)`,
`getReferralStatus`, `getAppointmentOutcome`. Add the implementation to
`CONNECTOR_IMPLEMENTED` in `packages/config` with exactly the capabilities it
supports.

## Required behaviour

1. **Capabilities are honest.** Declare only qualified capabilities; declare
   `idempotentByExecutionId: true` only if the destination de-duplicates on a
   key you send (e.g. the ACCESS `execution_id` as an external reference).
2. **Error classification.** Throw `SafeRetryableConnectorError` only when the
   request provably did not reach the destination (connection refused before
   send, explicit 429/503 before processing). Return/throw permanent for
   definitive rejections. Everything else after transmission — timeouts,
   resets, 5xx/504 of unknown effect, malformed bodies — must surface as
   ambiguous (throw `AmbiguousConnectorError` or return `AMBIGUOUS`).
3. **Result binding.** Echo the request `execution_id` in every result.
4. **Read-back.** `reconcile` must find the effect of a given `execution_id`
   uniquely (return `SUCCEEDED` with the destination reference), report
   `AMBIGUOUS` when it cannot, and never create anything.
5. **Outcome readback.** `getAppointmentOutcome` returns a stable
   `source_reference` per fact, the event time if the destination knows it
   (otherwise `occurred_at: null`), and never invents outcomes.
6. **No PHI in logs or errors**; error `code`s only.
7. **Unsupported operations** return `UNSUPPORTED_OPERATION`, never emulate.

## Qualification tests (run against the destination test system)

- happy path create → reference visible in the destination;
- duplicate delivery of the same `execution_id` → one record (if idempotent);
- forced timeout after send → reconciliation finds the single record;
- forced rejection → `PERMANENT`, no record;
- read-back of an unknown `execution_id` → ambiguous, no record created;
- outcome readback for booked, cancelled, declined and "no outcome yet";
- throughput and latency at pilot volume; credentials least privilege;
  egress restricted to the destination endpoint.

Mirror `tests/integration/dispatcher.test.ts` with the real adapter behind a
test double of the destination where the destination cannot be forced into
failure modes.

## Appointment operations

The only appointment connector is the synthetic transaction simulator
(`apps/worker/src/mock-destination.ts`): deterministic slots, holds with
expiry, taken and stale slots, exactly-once commits keyed by `execution_id`,
authoritative read-back and scripted faults. It is not a PMS integration and
refuses REAL data. A real appointment connector must additionally:

1. **Declare holds honestly.** Declare `appointment.hold` only if the
   destination really reserves a slot with an expiry it enforces; report the
   destination's expiry (`hold_expires_at`), never ACCESS's request. A
   destination without holds does not declare the capability at all; ACCESS
   then books unheld and relies on the destination's atomic commit.
2. **Treat availability as a read.** `appointment.availability.read` never
   mutates the destination and returns instants with the slot's IANA time
   zone.
3. **Commit exactly what was chosen, once.** `appointment.create` and
   `appointment.reschedule` book the exact `slot` (and `hold_reference`) sent,
   de-duplicate on `execution_id`, refuse a taken slot as
   `PERMANENT SLOT_UNAVAILABLE`, an expired hold as `HOLD_EXPIRED`, and never
   cancel anything: a reschedule's original is cancelled only by the separate
   `appointment.reschedule.cancel_original` step, released by ACCESS after
   the replacement was read back.
4. **Answer read-back authoritatively.** `reconcile` returns the committed
   result (`SUCCEEDED` with `appointment-commit.v1`/`appointment-hold.v1`/
   `appointment-cancellation.v1`) when the effect of that `execution_id`
   exists, `NOT_COMMITTED` only when the destination can prove it does not,
   and `AMBIGUOUS` otherwise. `NOT_COMMITTED` is the one answer that lets a
   step be tried again, so a destination that cannot prove absence must never
   return it.
5. **Verify truthfully.** `appointment.verify` (capability
   `appointment.status.read`, required for automated booking) reports the
   destination's current status of the named appointment.
6. **Cancel idempotently.** A repeated cancellation with the same
   `execution_id` returns the same result; cancelling an already cancelled
   appointment is `PERMANENT ALREADY_CANCELLED`.

Qualification against the destination's test system repeats the synthetic
scenarios (`tests/e2e/appointments.test.ts`, A-S) with the real adapter: at
minimum A, C, D, E, F, G, H, I, J, K, L, M, N and O, each with evidence.
