import type { DbClient } from "@access/db";
import { planWaitlistOffer, type PlanEnvironment } from "@access/notifications";
import { log, type Metrics } from "@access/observability";
import {
  SYSTEM_SCHEDULING_ACTOR,
  SchedulingError,
  closeOfferForHold,
  createWaitlistOffer,
  schedulingErrorFromDatabase,
  waitlistCandidates,
  type CommandContext,
  type CreatedOffer,
  type FreedSlot,
} from "@access/scheduling";
import type { OutboxEvent, OutboxHandler, OutboxRoutes } from "./outbox.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Candidates tried for one slot before giving up on it. */
const MAX_CANDIDATES = 20;

function systemContext(e: OutboxEvent): CommandContext {
  return {
    tenantId: e.tenant_id,
    practiceId: e.practice_id!,
    actor: { ...SYSTEM_SCHEDULING_ACTOR, id: "system:waitlist" },
    channel: "INTERNAL",
    correlationId: e.correlation_id,
  };
}

/**
 * Offer a freed slot to the first waitlisted patient who can take it and be
 * told about it. Each candidate is tried in a savepoint: a patient the slot
 * does not suit (type duration, referral, their own other bookings) or who
 * cannot be reached (no consent or contact) leaves no trace, and the next
 * one is tried. Unexpected failures propagate so the outbox retries.
 */
export async function offerFreedSlot(
  c: DbClient,
  ctx: CommandContext,
  plan: PlanEnvironment,
  slot: FreedSlot,
  sourceEventId: string | null,
  metrics?: Metrics,
): Promise<CreatedOffer | null> {
  const candidates = await waitlistCandidates(c, ctx, slot, MAX_CANDIDATES);
  for (const candidate of candidates) {
    await c.query("SAVEPOINT waitlist_offer");
    try {
      const offer = await createWaitlistOffer(c, ctx, {
        entryId: candidate.entryId,
        practitionerId: slot.practitionerId,
        locationId: slot.locationId,
        start: slot.start,
        sourceEventId,
      });
      const unreachable = await planWaitlistOffer(
        c,
        {
          tenantId: ctx.tenantId,
          practiceId: ctx.practiceId,
          sourceEventId,
        },
        plan,
        offer.offerId,
      );
      if (unreachable) {
        await c.query("ROLLBACK TO SAVEPOINT waitlist_offer");
        metrics?.inc("waitlist_candidates_skipped_total", {
          reason: unreachable,
        });
        continue;
      }
      await c.query("RELEASE SAVEPOINT waitlist_offer");
      metrics?.inc("waitlist_offers_total", { outcome: "offered" });
      log("info", "waitlist_offer_created", {
        practice_id: ctx.practiceId,
        event_id: sourceEventId,
        hold_id: offer.holdId,
        appointment_id: offer.appointmentId,
      });
      return offer;
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT waitlist_offer");
      const refusal =
        e instanceof SchedulingError ? e : schedulingErrorFromDatabase(e);
      if (!refusal) throw e;
      metrics?.inc("waitlist_candidates_skipped_total", {
        reason: refusal.code,
      });
      // Too soon for anyone to answer: no candidate will do.
      if (refusal.code === "WAITLIST_SLOT_TOO_SOON") break;
    }
  }
  metrics?.inc("waitlist_offers_total", { outcome: "no_candidate" });
  return null;
}

/** The slot an appointment occupied, if it is still in the future. */
async function appointmentSlot(
  c: DbClient,
  ctx: CommandContext,
  appointmentId: unknown,
): Promise<FreedSlot | null> {
  if (typeof appointmentId !== "string" || !UUID.test(appointmentId))
    return null;
  const r = await c.query<{
    practitioner_id: string;
    location_id: string;
    starts_at: Date;
    patient_id: string;
    future: boolean;
  }>(
    `SELECT practitioner_id, location_id, starts_at, patient_id, starts_at > now() AS future
       FROM scheduling.appointments WHERE tenant_id=$1 AND practice_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.practiceId, appointmentId],
  );
  const a = r.rows[0];
  if (!a || !a.future) return null;
  return {
    practitionerId: a.practitioner_id,
    locationId: a.location_id,
    start: a.starts_at,
    excludePatientId: a.patient_id,
  };
}

/** A slot carried in a waitlist event's payload. */
function payloadSlot(p: Record<string, unknown>): FreedSlot | null {
  const start = new Date(String(p.starts_at ?? ""));
  if (
    typeof p.practitioner_id !== "string" ||
    !UUID.test(p.practitioner_id) ||
    typeof p.location_id !== "string" ||
    !UUID.test(p.location_id) ||
    Number.isNaN(+start)
  )
    return null;
  return {
    practitionerId: p.practitioner_id,
    locationId: p.location_id,
    start,
  };
}

/**
 * Waitlist consequences of scheduling events: freed future slots (a
 * cancellation, the old time of a move, a slot staff announce, an offer
 * declined or lapsed) are offered on; an offer whose hold lapsed or was
 * released by staff is closed.
 */
export function waitlistRoutes(
  plan: PlanEnvironment,
  metrics?: Metrics,
): Partial<Record<keyof OutboxRoutes, OutboxHandler[]>> {
  const inPractice =
    (
      handler: (
        c: DbClient,
        e: OutboxEvent,
        ctx: CommandContext,
      ) => Promise<void>,
    ): OutboxHandler =>
    async (c, e) => {
      if (e.practice_id) await handler(c, e, systemContext(e));
    };
  const offer = (
    c: DbClient,
    e: OutboxEvent,
    ctx: CommandContext,
    slot: FreedSlot | null,
  ) =>
    slot
      ? offerFreedSlot(c, ctx, plan, slot, e.id, metrics).then(() => undefined)
      : Promise.resolve();
  const fromPayload = inPractice((c, e, ctx) =>
    offer(c, e, ctx, payloadSlot(e.payload)),
  );
  return {
    APPOINTMENT_CANCELLED: [
      inPractice(async (c, e, ctx) => {
        if (e.payload.slot_freed === true)
          await offer(c, e, ctx, await appointmentSlot(c, ctx, e.aggregate_id));
      }),
    ],
    APPOINTMENT_RESCHEDULED: [
      inPractice(async (c, e, ctx) =>
        offer(
          c,
          e,
          ctx,
          await appointmentSlot(c, ctx, e.payload.previous_appointment_id),
        ),
      ),
    ],
    WAITLIST_SLOT_AVAILABLE: [fromPayload],
    WAITLIST_OFFER_DECLINED: [fromPayload],
    WAITLIST_OFFER_EXPIRED: [fromPayload],
    HOLD_EXPIRED: [
      inPractice(async (c, e, ctx) => {
        if (e.payload.purpose === "WAITLIST_OFFER")
          await closeOfferForHold(c, ctx, e.aggregate_id, "EXPIRED");
      }),
    ],
    HOLD_RELEASED: [
      inPractice(async (c, e, ctx) => {
        // Declines close their own offer; this catches staff releasing the
        // hold directly.
        if (
          e.payload.purpose === "WAITLIST_OFFER" &&
          e.payload.close_reason !== "OFFER_DECLINED"
        )
          await closeOfferForHold(c, ctx, e.aggregate_id, "WITHDRAWN");
      }),
    ],
  };
}
