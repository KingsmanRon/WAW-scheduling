import {
  BOOKING_CHANNELS,
  type BookingChannel,
  type OutboxEventType,
} from "@access/contracts";
import {
  cancelPendingDeliveries,
  planAppointmentMessages,
  planCancellationNotice,
  type PlanEnvironment,
} from "@access/notifications";
import { emrFanOut, OUTBOX_TO_EMR } from "./integrations.js";
import type { OutboxEvent, OutboxHandler, OutboxRoutes } from "./outbox.js";

const channelOf = (value: unknown): BookingChannel | null =>
  typeof value === "string" &&
  (BOOKING_CHANNELS as readonly string[]).includes(value)
    ? (value as BookingChannel)
    : null;
const scope = (e: OutboxEvent) => ({
  tenantId: e.tenant_id,
  practiceId: e.practice_id!,
  sourceEventId: e.id,
});
/** Scheduling events always carry their practice; others are ignored here. */
const inPractice =
  (handler: OutboxHandler): OutboxHandler =>
  async (c, e) => {
    if (e.practice_id) await handler(c, e);
  };

/**
 * Asynchronous consequences of each scheduling event. Adding an event type
 * to the contracts forces a decision here (the record is exhaustive).
 * Additional routes (waitlist, channel access, referrals) are merged in by
 * their modules through `extend`.
 */
export function platformRoutes(plan: PlanEnvironment): OutboxRoutes {
  const emr = (type: OutboxEventType): OutboxHandler[] => {
    const target = OUTBOX_TO_EMR[type];
    return target ? [emrFanOut(target)] : [];
  };
  // Once the patient has arrived (or the visit is over, or they did not
  // come) no reminder is still useful.
  const closeOut = inPractice(async (c, e) => {
    await cancelPendingDeliveries(
      c,
      scope(e),
      e.aggregate_id,
      "APPOINTMENT_CLOSED",
    );
  });
  return {
    APPOINTMENT_CONFIRMED: [
      inPractice(async (c, e) => {
        await planAppointmentMessages(
          c,
          scope(e),
          plan,
          e.aggregate_id,
          "CONFIRMED",
          channelOf(e.payload.source_channel),
        );
      }),
      ...emr("APPOINTMENT_CONFIRMED"),
    ],
    APPOINTMENT_RESCHEDULED: [
      inPractice(async (c, e) => {
        const previous = e.payload.previous_appointment_id;
        if (typeof previous === "string")
          await cancelPendingDeliveries(
            c,
            scope(e),
            previous,
            "APPOINTMENT_RESCHEDULED",
          );
        await planAppointmentMessages(
          c,
          scope(e),
          plan,
          e.aggregate_id,
          "RESCHEDULED",
          channelOf(e.payload.source_channel),
        );
      }),
      ...emr("APPOINTMENT_RESCHEDULED"),
    ],
    APPOINTMENT_CANCELLED: [
      inPractice(async (c, e) => {
        await planCancellationNotice(
          c,
          scope(e),
          plan,
          e.aggregate_id,
          channelOf(e.payload.channel),
        );
      }),
      ...emr("APPOINTMENT_CANCELLED"),
    ],
    PATIENT_CHECKED_IN: [closeOut, ...emr("PATIENT_CHECKED_IN")],
    APPOINTMENT_STARTED: [closeOut, ...emr("APPOINTMENT_STARTED")],
    APPOINTMENT_COMPLETED: [closeOut, ...emr("APPOINTMENT_COMPLETED")],
    APPOINTMENT_NO_SHOW: [closeOut, ...emr("APPOINTMENT_NO_SHOW")],
    // A lapsed or released hold frees time; availability is computed live,
    // so nothing else needs to happen.
    HOLD_EXPIRED: [],
    HOLD_RELEASED: [],
    WAITLIST_SLOT_AVAILABLE: [],
    WAITLIST_OFFER_DECLINED: [],
    WAITLIST_OFFER_EXPIRED: [],
    CHANNEL_MESSAGE_RECEIVED: [],
    REFERRAL_VERIFIED: [],
  };
}

/** Append module routes (e.g. waitlist offers) to the base routes. */
export function extendRoutes(
  base: OutboxRoutes,
  extra: Partial<Record<OutboxEventType, readonly OutboxHandler[]>>,
): OutboxRoutes {
  const merged = { ...base };
  for (const [type, handlers] of Object.entries(extra) as [
    OutboxEventType,
    readonly OutboxHandler[],
  ][])
    merged[type] = [...merged[type], ...handlers];
  return merged;
}
