# Connector qualification guide

No real destination (PMS) connector is qualified. The client pilot uses
`CONNECTOR_KIND=none` and the manual destination workflow. A connector may be
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
