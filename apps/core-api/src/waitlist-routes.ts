import type { FastifyInstance } from "fastify";
import {
  announceSlotSchema,
  versionedSchema,
  waitlistEntrySchema,
  waitlistListQuerySchema,
  waitlistOfferAnswerSchema,
} from "@access/contracts";
import {
  acceptWaitlistOffer,
  addToWaitlist,
  announceFreedSlot,
  cancelWaitlistEntry,
  declineWaitlistOffer,
  getAppointmentView,
  getWaitlistEntry,
  listWaitlist,
} from "@access/scheduling";
import {
  createPracticeKit,
  idParam,
  type PracticeRouteDeps,
} from "./route-kit.js";

/**
 * The waitlist: staff add and remove patients, see the queue and its offers,
 * answer an offer for a patient who phoned in, and tell the waitlist about a
 * time they freed. Offers themselves are made by the worker.
 */
export async function registerWaitlistRoutes(
  app: FastifyInstance,
  deps: PracticeRouteDeps,
): Promise<void> {
  const base = "/v1/practices/:practiceId/waitlist";
  const { authorize, context, read, mutate } = createPracticeKit(deps);

  app.get(base, async (req) => {
    const auth = await authorize(req, "waitlist.read");
    const q = waitlistListQuerySchema.parse(req.query);
    return {
      items: await read(req, auth, (c, ctx) =>
        listWaitlist(c, ctx, {
          status: q.status,
          appointmentTypeId: q.appointment_type_id,
          patientId: q.patient_id,
          limit: q.limit,
        }),
      ),
    };
  });
  app.post(base, async (req, reply) => {
    const auth = await authorize(req, "waitlist.manage");
    const body = waitlistEntrySchema.parse(req.body);
    const ctx = context(req, auth, body.channel ?? "INTERNAL");
    return mutate(req, reply, auth, "waitlist.add", body, ctx, async (c) => {
      const id = await addToWaitlist(c, ctx, {
        patientId: body.patient_id,
        appointmentTypeId: body.appointment_type_id,
        practitionerId: body.practitioner_id,
        locationId: body.location_id,
        earliestDate: body.earliest_date,
        latestDate: body.latest_date,
        preferredWeekdays: body.preferred_weekdays,
        preferredStartMinute: body.preferred_start_minute,
        preferredEndMinute: body.preferred_end_minute,
        priority: body.priority,
        referralId: body.referral_id,
      });
      return {
        status: 201,
        body: await getWaitlistEntry(c, ctx, id),
        resourceType: "waitlist_entry",
        resourceId: id,
      };
    });
  });
  app.post(`${base}/announce-slot`, async (req, reply) => {
    const auth = await authorize(req, "waitlist.manage");
    const body = announceSlotSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "waitlist.announce_slot",
      body,
      ctx,
      async (c) => {
        await announceFreedSlot(c, ctx, {
          practitionerId: body.practitioner_id,
          locationId: body.location_id,
          start: body.start,
        });
        return { status: 202, body: { accepted: true } };
      },
    );
  });
  app.get(`${base}/:entryId`, async (req) => {
    const auth = await authorize(req, "waitlist.read");
    const id = idParam(req, "entryId");
    return read(req, auth, (c, ctx) => getWaitlistEntry(c, ctx, id));
  });
  app.post(`${base}/:entryId/cancel`, async (req, reply) => {
    const auth = await authorize(req, "waitlist.manage");
    const id = idParam(req, "entryId");
    const body = versionedSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "waitlist.cancel",
      { id, body },
      ctx,
      async (c) => {
        await cancelWaitlistEntry(c, ctx, id, {
          expectedVersion: body.expected_version,
        });
        return { status: 200, body: await getWaitlistEntry(c, ctx, id) };
      },
    );
  });

  // Staff answering for a patient who called in (the patient's own answer
  // arrives through WhatsApp).
  const offers = "/v1/practices/:practiceId/waitlist-offers/:offerId";
  app.post(`${offers}/accept`, async (req, reply) => {
    const auth = await authorize(req, "appointment.book");
    const id = idParam(req, "offerId");
    const body = waitlistOfferAnswerSchema.parse(req.body);
    const ctx = context(req, auth, body.channel ?? "PHONE");
    return mutate(
      req,
      reply,
      auth,
      "waitlist.offer.accept",
      { id, body },
      ctx,
      async (c) => {
        const appointmentId = await acceptWaitlistOffer(c, ctx, id);
        return {
          status: 200,
          body: {
            appointment: await getAppointmentView(c, ctx, appointmentId),
          },
          resourceType: "appointment",
          resourceId: appointmentId,
        };
      },
    );
  });
  app.post(`${offers}/decline`, async (req, reply) => {
    const auth = await authorize(req, "waitlist.manage");
    const id = idParam(req, "offerId");
    const body = waitlistOfferAnswerSchema.parse(req.body);
    const ctx = context(req, auth, body.channel ?? "PHONE");
    return mutate(
      req,
      reply,
      auth,
      "waitlist.offer.decline",
      { id, body },
      ctx,
      async (c) => {
        await declineWaitlistOffer(c, ctx, id);
        return { status: 200, body: { declined: true } };
      },
    );
  });
}
