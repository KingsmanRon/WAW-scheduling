import type { MeasureProvenance, VerificationLevel } from "@access/contracts";
import { notFound, type DbClient } from "./runtime.js";

/**
 * Business measurement, reproducible from source records (cases,
 * observations, interactions, effort events, state history). Nothing is
 * stored as an opaque counter and nothing missing is filled in: an absent
 * input yields value null with provenance UNKNOWN.
 */
export interface Measure<T = number> {
  value: T | null;
  provenance: MeasureProvenance;
  basis: string;
  inputs?: Record<string, unknown>;
}
const unknown = <T>(
  basis: string,
  inputs?: Record<string, unknown>,
): Measure<T> => ({
  value: null,
  provenance: "UNKNOWN",
  basis,
  ...(inputs ? { inputs } : {}),
});

function seconds(from: Date | null, to: Date | null): number | null {
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / 1000);
}
function duration(
  basis: string,
  from: { at: Date | null; levels: VerificationLevel[] },
  to: { at: Date | null; levels: VerificationLevel[] },
): Measure {
  const value = seconds(from.at, to.at);
  if (value === null)
    return unknown(basis, {
      start_known: Boolean(from.at),
      end_known: Boolean(to.at),
    });
  // An end recorded before its start is inconsistent data, not a duration:
  // it is reported as unknown rather than clamped or averaged.
  if (value < 0)
    return unknown(`${basis} (end recorded before start)`, {
      recorded_difference_seconds: value,
    });
  return {
    value,
    provenance: "DERIVED",
    basis,
    inputs: { start_verification: from.levels, end_verification: to.levels },
  };
}

export interface CaseMetrics {
  case_id: string;
  received_to_verified_seconds: Measure;
  verified_to_destination_seconds: Measure;
  received_to_ready_for_booking_seconds: Measure;
  received_to_booked_seconds: Measure;
  staff_seconds: Measure;
  human_touch_count: Measure;
  status_enquiry_count: Measure;
  follow_up_count: Measure;
  correction_count: Measure;
  exception_count: Measure;
  booking_conversion: Measure<boolean>;
  closure_reason: Measure<string>;
}

export async function caseMetrics(
  c: DbClient,
  tenantId: string,
  caseId: string,
): Promise<CaseMetrics> {
  const caseRow = await c.query<{
    opened_at: Date;
    current_state: string;
    resolution_code: string | null;
    outcome_at: Date | null;
    resolution_source: string | null;
  }>(
    "SELECT opened_at,current_state,resolution_code,outcome_at,resolution_source FROM access_cases WHERE tenant_id=$1 AND id=$2",
    [tenantId, caseId],
  );
  const kase = caseRow.rows[0];
  if (!kase) throw notFound();
  const milestones = await c.query<{
    observation_type: string;
    at: Date;
    levels: VerificationLevel[];
  }>(
    `SELECT observation_type, min(occurred_at) AS at, array_agg(DISTINCT verification_level ORDER BY verification_level) AS levels
       FROM access_case_observations
      WHERE tenant_id=$1 AND case_id=$2 AND disposition IN ('APPLIED','RECORDED')
      GROUP BY observation_type`,
    [tenantId, caseId],
  );
  const m = new Map(milestones.rows.map((r) => [r.observation_type, r]));
  const point = (type: string) => ({
    at: m.get(type)?.at ? new Date(m.get(type)!.at) : null,
    levels: m.get(type)?.levels ?? [],
  });
  const received = {
    at: new Date(kase.opened_at),
    levels: ["OBSERVED"] as VerificationLevel[],
  };
  const booked =
    kase.current_state === "BOOKED"
      ? {
          at: kase.outcome_at ? new Date(kase.outcome_at) : null,
          levels: point("APPOINTMENT_BOOKED").levels,
        }
      : { at: null, levels: [] };
  const effort = await c.query<{
    type: string;
    source: string;
    seconds: number | null;
  }>(
    "SELECT type,source,seconds FROM case_effort_events WHERE tenant_id=$1 AND case_id=$2",
    [tenantId, caseId],
  );
  const staffEvents = effort.rows.filter((e) => e.source === "STAFF");
  const counts = await c.query<{
    status_enquiries: number;
    exceptions: number;
  }>(
    `SELECT (SELECT count(*)::int FROM access_interactions WHERE tenant_id=$1 AND case_id=$2 AND intent='STATUS_ENQUIRY') AS status_enquiries,
            (SELECT count(*)::int FROM access_case_transitions WHERE tenant_id=$1 AND case_id=$2 AND to_state='EXCEPTION') AS exceptions`,
    [tenantId, caseId],
  );
  const observed = (value: number, basis: string): Measure => ({
    value,
    provenance: "OBSERVED",
    basis,
  });
  const reported = staffEvents.filter((e) => e.seconds !== null);
  const staffSeconds: Measure =
    staffEvents.length === 0
      ? unknown("no staff effort recorded")
      : reported.length < staffEvents.length
        ? unknown("some staff touches have no reported duration", {
            reported_touches: reported.length,
            total_touches: staffEvents.length,
            reported_seconds_lower_bound: reported.reduce(
              (s, e) => s + (e.seconds ?? 0),
              0,
            ),
          })
        : {
            value: reported.reduce((s, e) => s + (e.seconds ?? 0), 0),
            provenance: "ESTIMATED",
            basis: "sum of staff self-reported handling time",
          };
  const terminal = ["BOOKED", "CLOSED", "REJECTED"].includes(
    kase.current_state,
  );
  const conversion: Measure<boolean> =
    kase.current_state === "BOOKED"
      ? { value: true, provenance: "DERIVED", basis: "case booked" }
      : !terminal
        ? unknown("case still open")
        : kase.resolution_code === "UNKNOWN"
          ? unknown("closed with unknown outcome")
          : {
              value: false,
              provenance: "DERIVED",
              basis: `closed: ${kase.resolution_code}`,
            };
  return {
    case_id: caseId,
    received_to_verified_seconds: duration(
      "case opened -> REFERRAL_VERIFIED",
      received,
      point("REFERRAL_VERIFIED"),
    ),
    verified_to_destination_seconds: duration(
      "REFERRAL_VERIFIED -> DESTINATION_COMMITTED",
      point("REFERRAL_VERIFIED"),
      point("DESTINATION_COMMITTED"),
    ),
    received_to_ready_for_booking_seconds: duration(
      "case opened -> DESTINATION_COMMITTED",
      received,
      point("DESTINATION_COMMITTED"),
    ),
    received_to_booked_seconds: duration(
      "case opened -> booked outcome time",
      received,
      booked,
    ),
    staff_seconds: staffSeconds,
    human_touch_count: observed(staffEvents.length, "staff effort events"),
    status_enquiry_count: observed(
      counts.rows[0]!.status_enquiries,
      "STATUS_ENQUIRY interactions",
    ),
    follow_up_count: observed(
      effort.rows.filter((e) => e.type === "FOLLOW_UP").length,
      "FOLLOW_UP effort events",
    ),
    correction_count: observed(
      effort.rows.filter((e) => e.type === "MANUAL_CORRECTION").length,
      "MANUAL_CORRECTION effort events",
    ),
    exception_count: observed(
      counts.rows[0]!.exceptions,
      "transitions into EXCEPTION",
    ),
    booking_conversion: conversion,
    closure_reason: terminal
      ? {
          value: kase.resolution_code,
          provenance:
            kase.resolution_code === "UNKNOWN" ? "UNKNOWN" : "OBSERVED",
          basis: `resolution recorded by ${kase.resolution_source}`,
        }
      : unknown("case still open"),
  };
}

export interface CohortMetrics {
  period: { from: string; to: string };
  referrals_received: Measure;
  verified: Measure;
  ready_for_booking: Measure;
  booked: Measure;
  closed_without_booking: Measure;
  closed_unknown_outcome: Measure;
  still_open: Measure;
  booking_conversion_rate: Measure;
  cohort_booking_rate: Measure;
  median_received_to_verified_seconds: Measure;
  median_received_to_ready_seconds: Measure;
  p95_received_to_ready_seconds: Measure;
  median_received_to_booked_seconds: Measure;
  exception_rate: Measure;
  human_touch_rate: Measure;
  human_touches_per_referral: Measure;
  status_contacts_per_referral: Measure;
  staff_seconds_per_referral: Measure;
  outcomes_awaiting_review: Measure;
  top_closure_reasons: { code: string; count: number }[];
  top_exception_reasons: { kind: string; count: number }[];
  open_by_state: { state: string; count: number }[];
  median_seconds_in_state: {
    state: string;
    median_seconds: number;
    samples: number;
  }[];
  booking: BookingMetrics;
}

/**
 * The Booking stage for the same referral cohort: what happened between
 * ready for booking and a booked appointment, including ACCESS's own
 * appointment operations. Counts of recorded events are OBSERVED; rates and
 * medians are DERIVED with their inputs; no denominator means UNKNOWN.
 */
export interface BookingMetrics {
  ready_to_booked_conversion: Measure;
  median_ready_to_booked_seconds: Measure;
  p95_ready_to_booked_seconds: Measure;
  booking_requests: Measure;
  booked_by_access: Measure;
  booking_attempts_per_booked: Measure;
  availability_searches_per_booked: Measure;
  selection_to_booking_success: Measure;
  abandoned_booking_requests: Measure;
  reschedules_completed: Measure;
  cancellations_completed: Measure;
  ambiguous_appointment_writes: Measure;
  interventions_per_booking_request: Measure;
}

export async function cohortMetrics(
  c: DbClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<CohortMetrics> {
  const params = [tenantId, from, to];
  const cohort = `SELECT id,opened_at,current_state,resolution_code,outcome_at FROM access_cases
                   WHERE tenant_id=$1 AND case_type='REFERRAL' AND opened_at >= $2 AND opened_at < $3`;
  const summary = await c.query<{
    received: number;
    verified: number;
    ready_for_booking: number;
    booked: number;
    closed_without_booking: number;
    closed_unknown: number;
    still_open: number;
    with_exception: number;
    with_human_touch: number;
    human_touches: number;
    status_contacts: number;
    staff_touches: number;
    staff_touches_timed: number;
    staff_seconds: number;
    review_open: number;
    med_verified: number | null;
    n_verified: number;
    med_ready: number | null;
    p95_ready: number | null;
    n_ready: number;
    med_booked: number | null;
    n_booked: number;
  }>(
    `WITH cohort AS (${cohort}),
     ms AS (
       SELECT o.case_id,
              min(o.occurred_at) FILTER (WHERE o.observation_type='REFERRAL_VERIFIED') AS verified_at,
              min(o.occurred_at) FILTER (WHERE o.observation_type='DESTINATION_COMMITTED') AS destination_at
         FROM access_case_observations o JOIN cohort k ON k.id=o.case_id
        WHERE o.tenant_id=$1 AND o.disposition IN ('APPLIED','RECORDED')
        GROUP BY o.case_id),
     eff AS (
       SELECT e.case_id, count(*)::int AS touches, count(e.seconds)::int AS timed, coalesce(sum(e.seconds),0)::int AS secs
         FROM case_effort_events e JOIN cohort k ON k.id=e.case_id
        WHERE e.tenant_id=$1 AND e.source='STAFF' GROUP BY e.case_id),
     d AS (
       SELECT k.*, ms.verified_at, ms.destination_at,
              CASE WHEN ms.verified_at >= k.opened_at THEN extract(epoch FROM ms.verified_at - k.opened_at) END AS s_verified,
              CASE WHEN ms.destination_at >= k.opened_at THEN extract(epoch FROM ms.destination_at - k.opened_at) END AS s_ready,
              CASE WHEN k.current_state='BOOKED' AND k.outcome_at >= k.opened_at THEN extract(epoch FROM k.outcome_at - k.opened_at) END AS s_booked
         FROM cohort k LEFT JOIN ms ON ms.case_id=k.id)
     SELECT count(*)::int AS received,
            count(verified_at)::int AS verified,
            count(destination_at)::int AS ready_for_booking,
            count(*) FILTER (WHERE current_state='BOOKED')::int AS booked,
            count(*) FILTER (WHERE current_state IN ('CLOSED','REJECTED') AND resolution_code <> 'UNKNOWN')::int AS closed_without_booking,
            count(*) FILTER (WHERE current_state IN ('CLOSED','REJECTED') AND resolution_code = 'UNKNOWN')::int AS closed_unknown,
            count(*) FILTER (WHERE current_state NOT IN ('BOOKED','CLOSED','REJECTED'))::int AS still_open,
            (SELECT count(DISTINCT t.case_id)::int FROM access_case_transitions t JOIN cohort k ON k.id=t.case_id WHERE t.tenant_id=$1 AND t.to_state='EXCEPTION') AS with_exception,
            (SELECT count(*)::int FROM eff) AS with_human_touch,
            (SELECT coalesce(sum(touches),0)::int FROM eff) AS human_touches,
            (SELECT count(*)::int FROM access_interactions i JOIN cohort k ON k.id=i.case_id WHERE i.tenant_id=$1 AND i.intent='STATUS_ENQUIRY') AS status_contacts,
            (SELECT coalesce(sum(touches),0)::int FROM eff) AS staff_touches,
            (SELECT coalesce(sum(timed),0)::int FROM eff) AS staff_touches_timed,
            (SELECT coalesce(sum(secs),0)::int FROM eff) AS staff_seconds,
            (SELECT count(*)::int FROM work_items w JOIN cohort k ON k.id=w.case_id WHERE w.tenant_id=$1 AND w.kind='OUTCOME_REVIEW' AND w.status='OPEN') AS review_open,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY s_verified) AS med_verified,
            count(s_verified)::int AS n_verified,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY s_ready) AS med_ready,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY s_ready) AS p95_ready,
            count(s_ready)::int AS n_ready,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY s_booked) AS med_booked,
            count(s_booked)::int AS n_booked
       FROM d`,
    params,
  );
  const s = summary.rows[0]!;
  const count = (value: number, basis: string): Measure => ({
    value,
    provenance: "OBSERVED",
    basis,
  });
  const ratio = (num: number, den: number, basis: string): Measure =>
    den === 0
      ? unknown(`${basis} (no denominator)`)
      : {
          value: Math.round((num / den) * 10_000) / 10_000,
          provenance: "DERIVED",
          basis,
          inputs: { numerator: num, denominator: den },
        };
  const percentile = (
    value: number | null,
    n: number,
    basis: string,
  ): Measure =>
    value === null || n === 0
      ? unknown(`${basis} (no samples)`)
      : {
          value: Math.round(Number(value)),
          provenance: "DERIVED",
          basis,
          inputs: { samples: n },
        };
  const known = s.booked + s.closed_without_booking;
  const closures = await c.query<{ code: string; count: number }>(
    `WITH cohort AS (${cohort}) SELECT resolution_code AS code, count(*)::int AS count FROM cohort
      WHERE current_state IN ('CLOSED','REJECTED') GROUP BY resolution_code ORDER BY count DESC, code LIMIT 10`,
    params,
  );
  const exceptions = await c.query<{ kind: string; count: number }>(
    `WITH cohort AS (${cohort}) SELECT w.kind, count(*)::int AS count FROM work_items w JOIN cohort k ON k.id=w.case_id
      WHERE w.tenant_id=$1 AND w.kind IN ('IDENTITY','COMPLETENESS','SAFETY','FILE_SAFETY','CONNECTOR','MANUAL_DESTINATION','OUTCOME_REVIEW','ESCALATION')
      GROUP BY w.kind ORDER BY count DESC, w.kind LIMIT 10`,
    params,
  );
  const openByState = await c.query<{ state: string; count: number }>(
    `WITH cohort AS (${cohort}) SELECT current_state AS state, count(*)::int AS count FROM cohort
      WHERE current_state NOT IN ('BOOKED','CLOSED','REJECTED') GROUP BY current_state ORDER BY count DESC, state`,
    params,
  );
  // Time spent in each state, from the immutable transition history. The
  // current state of an open case is measured up to now.
  const inState = await c.query<{
    state: string;
    median_seconds: number;
    samples: number;
  }>(
    `WITH cohort AS (${cohort}),
     t AS (SELECT t.case_id, t.to_state, t.occurred_at,
                  lead(t.occurred_at) OVER (PARTITION BY t.case_id ORDER BY t.id) AS left_at
             FROM access_case_transitions t JOIN cohort k ON k.id=t.case_id WHERE t.tenant_id=$1)
     SELECT to_state AS state,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM coalesce(left_at, now()) - occurred_at)))::int AS median_seconds,
            count(*)::int AS samples
       FROM t WHERE to_state NOT IN ('BOOKED','CLOSED','REJECTED') GROUP BY to_state ORDER BY median_seconds DESC`,
    params,
  );
  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    referrals_received: count(s.received, "REFERRAL cases opened in period"),
    verified: count(s.verified, "cases with REFERRAL_VERIFIED"),
    ready_for_booking: count(
      s.ready_for_booking,
      "cases with DESTINATION_COMMITTED",
    ),
    booked: count(s.booked, "cases in BOOKED"),
    closed_without_booking: count(
      s.closed_without_booking,
      "CLOSED/REJECTED with a known non-booking reason",
    ),
    closed_unknown_outcome: count(
      s.closed_unknown,
      "closed with UNKNOWN outcome",
    ),
    still_open: count(s.still_open, "cases not yet booked or closed"),
    booking_conversion_rate: ratio(
      s.booked,
      known,
      "booked / (booked + closed with known reason); open and UNKNOWN excluded",
    ),
    cohort_booking_rate: ratio(
      s.booked,
      s.received,
      "booked / received to date",
    ),
    median_received_to_verified_seconds: percentile(
      s.med_verified,
      s.n_verified,
      "median case opened -> REFERRAL_VERIFIED",
    ),
    median_received_to_ready_seconds: percentile(
      s.med_ready,
      s.n_ready,
      "median case opened -> ready for booking (DESTINATION_COMMITTED)",
    ),
    p95_received_to_ready_seconds: percentile(
      s.p95_ready,
      s.n_ready,
      "p95 case opened -> ready for booking",
    ),
    median_received_to_booked_seconds: percentile(
      s.med_booked,
      s.n_booked,
      "median case opened -> booked outcome time",
    ),
    exception_rate: ratio(
      s.with_exception,
      s.received,
      "cases that entered EXCEPTION / received",
    ),
    human_touch_rate: ratio(
      s.with_human_touch,
      s.received,
      "cases with any staff effort / received",
    ),
    human_touches_per_referral: ratio(
      s.human_touches,
      s.received,
      "staff effort events / received",
    ),
    status_contacts_per_referral: ratio(
      s.status_contacts,
      s.received,
      "STATUS_ENQUIRY interactions / received",
    ),
    staff_seconds_per_referral:
      s.staff_touches === 0 || s.staff_touches_timed < s.staff_touches
        ? unknown("staff handling time not reported for every touch", {
            reported_touches: s.staff_touches_timed,
            total_touches: s.staff_touches,
          })
        : {
            value: Math.round(s.staff_seconds / Math.max(1, s.received)),
            provenance: "ESTIMATED",
            basis: "self-reported staff seconds / received",
          },
    outcomes_awaiting_review: count(
      s.review_open,
      "open OUTCOME_REVIEW work items",
    ),
    top_closure_reasons: closures.rows,
    top_exception_reasons: exceptions.rows,
    open_by_state: openByState.rows,
    median_seconds_in_state: inState.rows,
    booking: await bookingMetrics(c, cohort, params, {
      count,
      ratio,
      percentile,
    }),
  };
}

async function bookingMetrics(
  c: DbClient,
  cohort: string,
  params: unknown[],
  m: {
    count: (value: number, basis: string) => Measure;
    ratio: (num: number, den: number, basis: string) => Measure;
    percentile: (value: number | null, n: number, basis: string) => Measure;
  },
): Promise<BookingMetrics> {
  // Ready for booking (DESTINATION_COMMITTED) -> booked, for the referrals
  // that got there. Open ones are neither successes nor failures.
  const ready = await c.query<{
    reached: number;
    booked: number;
    closed_known: number;
    med: number | null;
    p95: number | null;
    n: number;
  }>(
    `WITH cohort AS (${cohort}),
     r AS (
       SELECT k.id, k.current_state, k.resolution_code, k.outcome_at, min(o.occurred_at) AS ready_at
         FROM cohort k JOIN access_case_observations o
           ON o.tenant_id=$1 AND o.case_id=k.id AND o.observation_type='DESTINATION_COMMITTED' AND o.disposition IN ('APPLIED','RECORDED')
        GROUP BY k.id, k.current_state, k.resolution_code, k.outcome_at),
     d AS (
       SELECT r.*, CASE WHEN r.current_state='BOOKED' AND r.outcome_at >= r.ready_at
                        THEN extract(epoch FROM r.outcome_at - r.ready_at) END AS s_booked
         FROM r)
     SELECT count(*)::int AS reached,
            count(*) FILTER (WHERE current_state='BOOKED')::int AS booked,
            count(*) FILTER (WHERE current_state IN ('CLOSED','REJECTED') AND resolution_code <> 'UNKNOWN')::int AS closed_known,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY s_booked) AS med,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY s_booked) AS p95,
            count(s_booked)::int AS n
       FROM d`,
    params,
  );
  // ACCESS's appointment operations for the cohort's referrals.
  const ops = await c.query<{
    booking_requests: number;
    booked_requests: number;
    withdrawn: number;
    reschedules: number;
    cancellations: number;
    attempts: number;
    searches: number;
    selected_finished: number;
    selected_booked: number;
    ambiguous: number;
    ambiguous_escalated: number;
    interventions: number;
  }>(
    `WITH cohort AS (${cohort}),
     req AS (
       SELECT r.case_id, r.case_type, r.workflow_status FROM appointment_requests r
         JOIN cohort k ON k.id=r.origin_referral_case_id WHERE r.tenant_id=$1),
     ex AS (
       SELECT e.operation, e.first_ambiguous_at, e.escalated_at, req.case_type FROM executions e
         JOIN req ON req.case_id=e.case_id WHERE e.tenant_id=$1),
     sel AS (
       SELECT DISTINCT req.case_id, req.workflow_status FROM req
         JOIN evidence_events v ON v.tenant_id=$1 AND v.case_id=req.case_id AND v.event_type='slot_selected'
        WHERE req.case_type='APPOINTMENT_REQUEST')
     SELECT (SELECT count(*)::int FROM req WHERE case_type='APPOINTMENT_REQUEST') AS booking_requests,
            (SELECT count(*)::int FROM req WHERE case_type='APPOINTMENT_REQUEST' AND workflow_status='BOOKED') AS booked_requests,
            (SELECT count(*)::int FROM req WHERE case_type='APPOINTMENT_REQUEST' AND workflow_status='WITHDRAWN') AS withdrawn,
            (SELECT count(*)::int FROM req WHERE case_type='RESCHEDULING_REQUEST' AND workflow_status='COMPLETED') AS reschedules,
            (SELECT count(*)::int FROM req WHERE case_type='CANCELLATION_REQUEST' AND workflow_status='CANCELLED') AS cancellations,
            (SELECT count(*)::int FROM ex WHERE operation='appointment.create') AS attempts,
            (SELECT count(*)::int FROM ex WHERE operation='appointment.availability.read' AND case_type='APPOINTMENT_REQUEST') AS searches,
            (SELECT count(*)::int FROM sel WHERE workflow_status IN ('BOOKED','WITHDRAWN')) AS selected_finished,
            (SELECT count(*)::int FROM sel WHERE workflow_status='BOOKED') AS selected_booked,
            (SELECT count(*)::int FROM ex WHERE first_ambiguous_at IS NOT NULL) AS ambiguous,
            (SELECT count(*)::int FROM ex WHERE first_ambiguous_at IS NOT NULL AND escalated_at IS NOT NULL) AS ambiguous_escalated,
            (SELECT count(*)::int FROM case_effort_events f JOIN req ON req.case_id=f.case_id
              WHERE f.tenant_id=$1 AND f.source='STAFF') AS interventions`,
    params,
  );
  const r = ready.rows[0]!;
  const o = ops.rows[0]!;
  const ambiguous = m.count(
    o.ambiguous,
    "appointment writes whose outcome was unknown when sent",
  );
  return {
    ready_to_booked_conversion: m.ratio(
      r.booked,
      r.booked + r.closed_known,
      "ready for booking -> booked / (booked + closed with known reason); open excluded",
    ),
    median_ready_to_booked_seconds: m.percentile(
      r.med,
      r.n,
      "median ready for booking (DESTINATION_COMMITTED) -> booked outcome time",
    ),
    p95_ready_to_booked_seconds: m.percentile(
      r.p95,
      r.n,
      "p95 ready for booking -> booked outcome time",
    ),
    booking_requests: m.count(
      o.booking_requests,
      "APPOINTMENT_REQUEST cases for the cohort's referrals",
    ),
    booked_by_access: m.count(
      o.booked_requests,
      "appointment requests booked and read back by ACCESS",
    ),
    booking_attempts_per_booked: m.ratio(
      o.attempts,
      o.booked_requests,
      "submitted bookings (appointment.create) / requests booked",
    ),
    availability_searches_per_booked: m.ratio(
      o.searches,
      o.booked_requests,
      "availability searches / requests booked",
    ),
    selection_to_booking_success: m.ratio(
      o.selected_booked,
      o.selected_finished,
      "requests with a selected slot that ended booked / those that ended (booked or withdrawn)",
    ),
    abandoned_booking_requests: m.count(
      o.withdrawn,
      "appointment requests withdrawn before booking",
    ),
    reschedules_completed: m.count(
      o.reschedules,
      "reschedules completed (replacement verified, original cancelled)",
    ),
    cancellations_completed: m.count(
      o.cancellations,
      "cancellations confirmed by the destination",
    ),
    ambiguous_appointment_writes: {
      ...ambiguous,
      inputs: { escalated_to_staff: o.ambiguous_escalated },
    },
    interventions_per_booking_request: m.ratio(
      o.interventions,
      o.booking_requests,
      "staff interventions (exceptions resolved, destination checks) on appointment cases / booking requests",
    ),
  };
}
