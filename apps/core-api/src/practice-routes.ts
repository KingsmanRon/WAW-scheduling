import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addContactSchema,
  addIdentifierSchema,
  appointmentListQuerySchema,
  appointmentTypePatchSchema,
  appointmentTypeSchema,
  auditQuerySchema,
  availabilityExceptionSchema,
  slotAvailabilityQuerySchema,
  availabilityRuleSchema,
  bookAppointmentSchema,
  calendarQuerySchema,
  cancelSchema,
  confirmHoldSchema,
  createHoldSchema,
  createPatientSchema,
  duplicateReviewSchema,
  emptySchema,
  exceptionListQuerySchema,
  lifecycleSchema,
  locationPatchSchema,
  locationSchema,
  membershipSchema,
  notesSchema,
  patientSearchSchema,
  practiceSettingsSchema,
  practitionerPatchSchema,
  practitionerSchema,
  removalSchema,
  rescheduleSchema,
  scheduleBlockSchema,
  updatePatientSchema,
  uuid,
} from "@access/contracts";
import { AppError, type DbClient } from "@access/db";
import {
  addPatientContact,
  addPatientIdentifier,
  createPatient,
  getPatientDetail,
  listDuplicateCandidates,
  removePatientContact,
  reviewDuplicate,
  searchPatients,
  updatePatient,
} from "@access/patients";
import {
  assertOwnSchedule,
  authorizePractice,
  practicePermissions,
  type PracticePermission,
} from "@access/policy";
import {
  appointmentHistory,
  audit,
  bookAppointment,
  calendar,
  cancelAppointment,
  confirmHold,
  createAppointmentType,
  createAvailabilityException,
  createAvailabilityRule,
  createHold,
  createLocation,
  createPractitioner,
  createScheduleBlock,
  decodeCursor,
  getAppointmentView,
  getHoldView,
  getPracticeSettings,
  listAppointments,
  listAppointmentTypes,
  listAvailabilityExceptions,
  listAvailabilityRules,
  listLocations,
  listPractitioners,
  performAction,
  queryAvailability,
  releaseHold,
  removeAvailabilityException,
  removeAvailabilityRule,
  removeScheduleBlock,
  rescheduleAppointment,
  updateAppointmentType,
  updateLocation,
  updateNotes,
  updatePracticeSettings,
  updatePractitioner,
  type CommandContext,
  type LifecycleAction,
} from "@access/scheduling";
import {
  createPracticeKit,
  idParam,
  type PracticeRouteDeps,
} from "./route-kit.js";

export type { PracticeRouteDeps } from "./route-kit.js";

/**
 * The practice scheduling API. Every route:
 *   1. authenticates the session and resolves the caller's membership of the
 *      practice in the path (never from a header or body);
 *   2. checks the central permission for the operation before parsing the body;
 *   3. validates the payload strictly;
 *   4. runs in one practice-scoped transaction through the Scheduling Core,
 *      which writes the change, its history, outbox event and audit record.
 * Mutations require an Idempotency-Key: a retry replays the original
 * response, a reused key with a different request fails.
 */
export async function registerPracticeRoutes(
  app: FastifyInstance,
  deps: PracticeRouteDeps,
): Promise<void> {
  const { hasher, metrics } = deps;
  const base = "/v1/practices/:practiceId";
  const { authorize, context, read, mutate } = createPracticeKit(deps);
  const appointmentBody = async (
    c: DbClient,
    ctx: CommandContext,
    id: string,
  ) => ({
    appointment: await getAppointmentView(c, ctx, id),
  });

  // -------------------------------------------------------------------------
  // Context and configuration.
  // -------------------------------------------------------------------------

  app.get(`${base}/context`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    return read(req, auth, async (c, ctx) => ({
      practice: await getPracticeSettings(c, ctx),
      membership: {
        user_id: auth.userId,
        role: auth.role,
        display_name: auth.displayName,
        practitioner_id: auth.practitionerId,
        permissions: practicePermissions(auth.role),
      },
      locations: await listLocations(c, ctx),
      practitioners: await listPractitioners(c, ctx, true),
      appointment_types: await listAppointmentTypes(c, ctx, true),
    }));
  });

  app.get(`${base}/settings`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    return read(req, auth, (c, ctx) => getPracticeSettings(c, ctx));
  });
  app.patch(`${base}/settings`, async (req, reply) => {
    const auth = await authorize(req, "configuration.manage");
    const body = practiceSettingsSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "practice.settings.update",
      body,
      ctx,
      async (c) => ({
        status: 200,
        body: {
          practice: await updatePracticeSettings(
            c,
            ctx,
            {
              name: body.name,
              timezone: body.timezone,
              contactPhone: body.contact_phone,
              contactEmail: body.contact_email,
              holdTtlSeconds: body.hold_ttl_seconds,
              defaultSlotIntervalMinutes: body.default_slot_interval_minutes,
              reminder24hEnabled: body.reminder_24h_enabled,
              nearTermReminderMinutes: body.near_term_reminder_minutes,
              waitlistOfferTtlMinutes: body.waitlist_offer_ttl_minutes,
              referralVerificationRequired: body.referral_verification_required,
              patientChangeCutoffMinutes: body.patient_change_cutoff_minutes,
            },
            body.expected_version,
          ),
        },
      }),
    );
  });

  app.get(`${base}/locations`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    return { items: await read(req, auth, (c, ctx) => listLocations(c, ctx)) };
  });
  app.post(`${base}/locations`, async (req, reply) => {
    const auth = await authorize(req, "configuration.manage");
    const body = locationSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(req, reply, auth, "location.create", body, ctx, async (c) => {
      const location = await createLocation(c, ctx, {
        name: body.name,
        timezone: body.timezone,
        addressLine1: body.address_line1,
        addressLine2: body.address_line2,
        city: body.city,
        postalCode: body.postal_code,
        phone: body.phone,
        active: body.active,
      });
      return {
        status: 201,
        body: { location },
        resourceType: "location",
        resourceId: location.id,
      };
    });
  });
  app.patch(`${base}/locations/:locationId`, async (req, reply) => {
    const auth = await authorize(req, "configuration.manage");
    const id = idParam(req, "locationId");
    const body = locationPatchSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "location.update",
      { id, body },
      ctx,
      async (c) => ({
        status: 200,
        body: {
          location: await updateLocation(
            c,
            ctx,
            id,
            {
              name: body.name,
              timezone: body.timezone,
              addressLine1: body.address_line1,
              addressLine2: body.address_line2,
              city: body.city,
              postalCode: body.postal_code,
              phone: body.phone,
              active: body.active,
            },
            body.expected_version,
          ),
        },
      }),
    );
  });

  app.get(`${base}/practitioners`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    return {
      items: await read(req, auth, (c, ctx) => listPractitioners(c, ctx, true)),
    };
  });
  const practitionerInput = (b: z.infer<typeof practitionerPatchSchema>) => ({
    displayName: b.display_name,
    title: b.title,
    givenName: b.given_name,
    familyName: b.family_name,
    profession: b.profession,
    registrationNumber: b.registration_number,
    calendarColor: b.calendar_color,
    active: b.active,
    bookableByPatients: b.bookable_by_patients,
    locationIds: b.location_ids,
  });
  app.post(`${base}/practitioners`, async (req, reply) => {
    const auth = await authorize(req, "configuration.manage");
    const body = practitionerSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "practitioner.create",
      body,
      ctx,
      async (c) => {
        const practitioner = await createPractitioner(c, ctx, {
          ...practitionerInput(body),
          displayName: body.display_name,
          familyName: body.family_name,
        });
        return {
          status: 201,
          body: { practitioner },
          resourceType: "practitioner",
          resourceId: practitioner.id,
        };
      },
    );
  });
  app.patch(`${base}/practitioners/:practitionerId`, async (req, reply) => {
    const auth = await authorize(req, "configuration.manage");
    const id = idParam(req, "practitionerId");
    const body = practitionerPatchSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "practitioner.update",
      { id, body },
      ctx,
      async (c) => ({
        status: 200,
        body: {
          practitioner: await updatePractitioner(
            c,
            ctx,
            id,
            practitionerInput(body),
            body.expected_version,
          ),
        },
      }),
    );
  });

  app.get(`${base}/appointment-types`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    return {
      items: await read(req, auth, (c, ctx) =>
        listAppointmentTypes(c, ctx, true),
      ),
    };
  });
  const typeInput = (b: z.infer<typeof appointmentTypePatchSchema>) => ({
    code: b.code,
    name: b.name,
    description: b.description,
    durationMinutes: b.duration_minutes,
    bufferBeforeMinutes: b.buffer_before_minutes,
    bufferAfterMinutes: b.buffer_after_minutes,
    slotIntervalMinutes: b.slot_interval_minutes,
    requiresReferral: b.requires_referral,
    newPatientAllowed: b.new_patient_allowed,
    followUpOnly: b.follow_up_only,
    minNoticeMinutes: b.min_notice_minutes,
    maxAdvanceDays: b.max_advance_days,
    patientBookable: b.patient_bookable,
    calendarColor: b.calendar_color,
    active: b.active,
    practitionerIds: b.practitioner_ids,
    locationIds: b.location_ids,
  });
  app.post(`${base}/appointment-types`, async (req, reply) => {
    const auth = await authorize(req, "configuration.manage");
    const body = appointmentTypeSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "appointment_type.create",
      body,
      ctx,
      async (c) => {
        const appointmentType = await createAppointmentType(c, ctx, {
          ...typeInput(body),
          code: body.code,
          name: body.name,
          durationMinutes: body.duration_minutes,
        });
        return {
          status: 201,
          body: { appointment_type: appointmentType },
          resourceType: "appointment_type",
          resourceId: appointmentType.id,
        };
      },
    );
  });
  app.patch(`${base}/appointment-types/:typeId`, async (req, reply) => {
    const auth = await authorize(req, "configuration.manage");
    const id = idParam(req, "typeId");
    const body = appointmentTypePatchSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "appointment_type.update",
      { id, body },
      ctx,
      async (c) => ({
        status: 200,
        body: {
          appointment_type: await updateAppointmentType(
            c,
            ctx,
            id,
            typeInput(body),
            body.expected_version,
          ),
        },
      }),
    );
  });

  // Working hours (recurring availability).
  app.get(`${base}/availability-rules`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    const q = z.object({ practitioner_id: uuid.optional() }).parse(req.query);
    return {
      items: await read(req, auth, (c, ctx) =>
        listAvailabilityRules(c, ctx, q.practitioner_id),
      ),
    };
  });
  app.post(`${base}/availability-rules`, async (req, reply) => {
    const auth = await authorize(req, "schedule.hours.manage");
    const body = availabilityRuleSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "availability_rule.create",
      body,
      ctx,
      async (c) => ({
        status: 201,
        body: {
          availability_rule: await createAvailabilityRule(c, ctx, {
            practitionerId: body.practitioner_id,
            locationId: body.location_id,
            weekday: body.weekday,
            startMinute: body.start_minute,
            endMinute: body.end_minute,
            validFrom: body.valid_from,
            validUntil: body.valid_until,
          }),
        },
      }),
    );
  });
  app.post(`${base}/availability-rules/:ruleId/remove`, async (req, reply) => {
    const auth = await authorize(req, "schedule.hours.manage");
    const id = idParam(req, "ruleId");
    emptySchema.parse(req.body ?? {});
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "availability_rule.remove",
      { id },
      ctx,
      async (c) => {
        await removeAvailabilityRule(c, ctx, id);
        return { status: 200, body: { removed: id } };
      },
    );
  });

  // Leave, one-off sessions and calendar blocks.
  app.get(`${base}/availability-exceptions`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    const q = exceptionListQuerySchema.parse(req.query);
    return {
      items: await read(req, auth, (c, ctx) =>
        listAvailabilityExceptions(c, ctx, {
          practitionerId: q.practitioner_id,
          from: q.from,
          to: q.to,
        }),
      ),
    };
  });
  app.post(`${base}/availability-exceptions`, async (req, reply) => {
    const auth = await authorize(req, "schedule.exceptions.manage");
    const body = availabilityExceptionSchema.parse(req.body);
    assertOwnSchedule(auth.role, auth.practitionerId, body.practitioner_id);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "availability_exception.create",
      body,
      ctx,
      async (c) => ({
        status: 201,
        body: {
          availability_exception: await createAvailabilityException(c, ctx, {
            practitionerId: body.practitioner_id,
            locationId: body.location_id,
            kind: body.kind,
            reasonCode: body.reason_code,
            start: body.start,
            end: body.end,
            note: body.note,
            acknowledgeConflicts: body.acknowledge_conflicts,
          }),
        },
      }),
    );
  });
  app.post(
    `${base}/availability-exceptions/:exceptionId/remove`,
    async (req, reply) => {
      const auth = await authorize(req, "schedule.exceptions.manage");
      const id = idParam(req, "exceptionId");
      emptySchema.parse(req.body ?? {});
      const ctx = context(req, auth);
      return mutate(
        req,
        reply,
        auth,
        "availability_exception.remove",
        { id },
        ctx,
        async (c) => {
          if (auth.role === "DOCTOR") {
            const owner = await c.query<{ practitioner_id: string }>(
              "SELECT practitioner_id FROM scheduling.availability_exceptions WHERE tenant_id=$1 AND practice_id=$2 AND id=$3",
              [auth.tenantId, auth.practiceId, id],
            );
            if (owner.rows[0])
              assertOwnSchedule(
                auth.role,
                auth.practitionerId,
                owner.rows[0].practitioner_id,
              );
          }
          await removeAvailabilityException(c, ctx, id);
          return { status: 200, body: { removed: id } };
        },
      );
    },
  );
  app.post(`${base}/schedule-blocks`, async (req, reply) => {
    const auth = await authorize(req, "schedule.blocks.manage");
    const body = scheduleBlockSchema.parse(req.body);
    assertOwnSchedule(auth.role, auth.practitionerId, body.practitioner_id);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "schedule_block.create",
      body,
      ctx,
      async (c) => ({
        status: 201,
        body: {
          schedule_block: await createScheduleBlock(c, ctx, {
            practitionerId: body.practitioner_id,
            locationId: body.location_id,
            reasonCode: body.reason_code,
            start: body.start,
            end: body.end,
            note: body.note,
            acknowledgeConflicts: body.acknowledge_conflicts,
          }),
        },
      }),
    );
  });
  app.post(`${base}/schedule-blocks/:blockId/remove`, async (req, reply) => {
    const auth = await authorize(req, "schedule.blocks.manage");
    const id = idParam(req, "blockId");
    const body = removalSchema.parse(req.body ?? {});
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "schedule_block.remove",
      { id, body },
      ctx,
      async (c) => {
        if (auth.role === "DOCTOR") {
          const owner = await c.query<{ practitioner_id: string }>(
            "SELECT practitioner_id FROM scheduling.schedule_blocks WHERE tenant_id=$1 AND practice_id=$2 AND id=$3",
            [auth.tenantId, auth.practiceId, id],
          );
          if (owner.rows[0])
            assertOwnSchedule(
              auth.role,
              auth.practitionerId,
              owner.rows[0].practitioner_id,
            );
        }
        await removeScheduleBlock(c, ctx, id, body.reason);
        return { status: 200, body: { removed: id } };
      },
    );
  });

  // -------------------------------------------------------------------------
  // Availability, calendar and appointments.
  // -------------------------------------------------------------------------

  app.get(`${base}/availability`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    const q = slotAvailabilityQuerySchema.parse(req.query);
    const started = performance.now();
    const slots = await read(req, auth, (c, ctx) =>
      queryAvailability(c, ctx, {
        appointmentTypeId: q.appointment_type_id,
        from: q.from,
        to: q.to,
        practitionerId: q.practitioner_id,
        locationId: q.location_id,
        excludeAppointmentId: q.reschedule_of,
        limit: q.limit,
      }),
    );
    metrics.observe(
      "availability_query_seconds",
      (performance.now() - started) / 1000,
    );
    return { slots };
  });

  app.get(`${base}/calendar`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    const q = calendarQuerySchema.parse(req.query);
    return read(req, auth, (c, ctx) =>
      calendar(c, ctx, {
        from: q.from,
        to: q.to,
        practitionerIds: q.practitioner_ids,
        locationId: q.location_id,
        includeCancelled: q.include_cancelled,
      }),
    );
  });

  app.get(`${base}/appointments`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    const q = appointmentListQuerySchema.parse(req.query);
    if (q.patient_id) authorizePractice(auth.role, "patient.read");
    return read(req, auth, (c, ctx) =>
      listAppointments(c, ctx, {
        from: q.from,
        to: q.to,
        practitionerIds: q.practitioner_id ? [q.practitioner_id] : undefined,
        locationId: q.location_id,
        patientId: q.patient_id,
        statuses: q.status,
        after: decodeCursor(q.cursor),
        limit: q.limit,
      }),
    );
  });
  app.post(`${base}/appointments`, async (req, reply) => {
    const auth = await authorize(req, "appointment.book");
    const body = bookAppointmentSchema.parse(req.body);
    const ctx = context(req, auth, body.source_channel);
    return mutate(
      req,
      reply,
      auth,
      "appointment.create",
      body,
      ctx,
      async (c) => {
        const id = await bookAppointment(c, ctx, {
          patientId: body.patient_id,
          appointmentTypeId: body.appointment_type_id,
          practitionerId: body.practitioner_id,
          locationId: body.location_id,
          start: body.start,
          referralId: body.referral_id,
          notes: body.notes,
          overrideAvailability: body.override_availability,
          waitlistEntryId: body.waitlist_entry_id,
        });
        return {
          status: 201,
          body: await appointmentBody(c, ctx, id),
          resourceType: "appointment",
          resourceId: id,
        };
      },
    );
  });
  app.get(`${base}/appointments/:appointmentId`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    const id = idParam(req, "appointmentId");
    return read(req, auth, (c, ctx) => appointmentBody(c, ctx, id));
  });
  app.get(`${base}/appointments/:appointmentId/history`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    const id = idParam(req, "appointmentId");
    return read(req, auth, async (c, ctx) => {
      await getAppointmentView(c, ctx, id);
      return { items: await appointmentHistory(c, ctx, id) };
    });
  });
  app.post(
    `${base}/appointments/:appointmentId/reschedule`,
    async (req, reply) => {
      const auth = await authorize(req, "appointment.reschedule");
      const id = idParam(req, "appointmentId");
      const body = rescheduleSchema.parse(req.body);
      const ctx = context(req, auth, body.channel);
      return mutate(
        req,
        reply,
        auth,
        "appointment.reschedule",
        { id, body },
        ctx,
        async (c) => {
          const replacement = await rescheduleAppointment(c, ctx, id, {
            start: body.start,
            practitionerId: body.practitioner_id,
            locationId: body.location_id,
            note: body.note,
            expectedVersion: body.expected_version,
            overrideAvailability: body.override_availability,
          });
          return {
            status: 200,
            body: {
              ...(await appointmentBody(c, ctx, replacement)),
              previous_appointment_id: id,
            },
            resourceType: "appointment",
            resourceId: replacement,
          };
        },
      );
    },
  );
  app.post(`${base}/appointments/:appointmentId/cancel`, async (req, reply) => {
    const auth = await authorize(req, "appointment.cancel");
    const id = idParam(req, "appointmentId");
    const body = cancelSchema.parse(req.body);
    const ctx = context(req, auth, body.channel);
    return mutate(
      req,
      reply,
      auth,
      "appointment.cancel",
      { id, body },
      ctx,
      async (c) => {
        await cancelAppointment(c, ctx, id, {
          reasonCode: body.reason_code,
          note: body.note,
          expectedVersion: body.expected_version,
        });
        return { status: 200, body: await appointmentBody(c, ctx, id) };
      },
    );
  });
  const LIFECYCLE: Record<string, [LifecycleAction, PracticePermission]> = {
    "check-in": ["check_in", "appointment.check_in"],
    start: ["start", "appointment.progress"],
    complete: ["complete", "appointment.progress"],
    "no-show": ["no_show", "appointment.no_show"],
  };
  for (const [path, [action, permission]] of Object.entries(LIFECYCLE))
    app.post(
      `${base}/appointments/:appointmentId/${path}`,
      async (req, reply) => {
        const auth = await authorize(req, permission);
        const id = idParam(req, "appointmentId");
        const body = lifecycleSchema.parse(req.body ?? {});
        const ctx = context(req, auth, body.channel);
        return mutate(
          req,
          reply,
          auth,
          `appointment.${action}`,
          { id, body },
          ctx,
          async (c) => {
            await performAction(c, ctx, id, action, {
              expectedVersion: body.expected_version,
            });
            return { status: 200, body: await appointmentBody(c, ctx, id) };
          },
        );
      },
    );
  app.patch(`${base}/appointments/:appointmentId/notes`, async (req, reply) => {
    const auth = await authorize(req, "appointment.notes");
    const id = idParam(req, "appointmentId");
    const body = notesSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "appointment.notes",
      { id, body },
      ctx,
      async (c) => {
        await updateNotes(c, ctx, id, {
          notes: body.notes,
          expectedVersion: body.expected_version,
        });
        return { status: 200, body: await appointmentBody(c, ctx, id) };
      },
    );
  });

  // Slot holds.
  app.post(`${base}/slot-holds`, async (req, reply) => {
    const auth = await authorize(req, "appointment.book");
    const body = createHoldSchema.parse(req.body);
    if (body.reschedule_of_id)
      authorizePractice(auth.role, "appointment.reschedule");
    const ctx = context(req, auth, body.source_channel, body.session_ref);
    return mutate(
      req,
      reply,
      auth,
      "slot_hold.create",
      body,
      ctx,
      async (c) => {
        const hold = await createHold(c, ctx, {
          patientId: body.patient_id,
          appointmentTypeId: body.appointment_type_id,
          practitionerId: body.practitioner_id,
          locationId: body.location_id,
          start: body.start,
          referralId: body.referral_id,
          purpose: body.reschedule_of_id ? "RESCHEDULE" : "BOOKING",
          rescheduleOfId: body.reschedule_of_id,
        });
        return {
          status: 201,
          body: { hold: await getHoldView(c, ctx, hold.holdId) },
          resourceType: "slot_hold",
          resourceId: hold.holdId,
        };
      },
    );
  });
  app.get(`${base}/slot-holds/:holdId`, async (req) => {
    const auth = await authorize(req, "schedule.read");
    const id = idParam(req, "holdId");
    return read(req, auth, async (c, ctx) => ({
      hold: await getHoldView(c, ctx, id),
    }));
  });
  app.post(`${base}/slot-holds/:holdId/confirm`, async (req, reply) => {
    const auth = await authorize(req, "appointment.book");
    const id = idParam(req, "holdId");
    const body = confirmHoldSchema.parse(req.body ?? {});
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "slot_hold.confirm",
      { id, body },
      ctx,
      async (c) => {
        const appointmentId = await confirmHold(c, ctx, id, {
          notes: body.notes,
        });
        return {
          status: 200,
          body: await appointmentBody(c, ctx, appointmentId),
          resourceType: "appointment",
          resourceId: appointmentId,
        };
      },
    );
  });
  app.post(`${base}/slot-holds/:holdId/release`, async (req, reply) => {
    const auth = await authorize(req, "appointment.book");
    const id = idParam(req, "holdId");
    emptySchema.parse(req.body ?? {});
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "slot_hold.release",
      { id },
      ctx,
      async (c) => {
        await releaseHold(c, ctx, id);
        return { status: 200, body: { hold: await getHoldView(c, ctx, id) } };
      },
    );
  });

  // -------------------------------------------------------------------------
  // Patients.
  // -------------------------------------------------------------------------

  app.get(`${base}/patients`, async (req) => {
    const auth = await authorize(req, "patient.read");
    const q = patientSearchSchema.parse(req.query);
    return read(req, auth, (c, ctx) =>
      searchPatients(
        c,
        ctx,
        {
          text: q.q,
          mobile: q.mobile,
          email: q.email,
          patientNumber: q.patient_number,
          nationalId: q.national_id,
          dateOfBirth: q.date_of_birth,
          includeArchived: q.include_archived,
          cursor: q.cursor,
          limit: q.limit,
        },
        hasher,
      ),
    );
  });
  app.post(`${base}/patients`, async (req, reply) => {
    const auth = await authorize(req, "patient.write");
    const body = createPatientSchema.parse(req.body);
    const ctx = context(req, auth, body.source_channel);
    return mutate(req, reply, auth, "patient.create", body, ctx, async (c) => {
      const created = await createPatient(
        c,
        ctx,
        {
          givenName: body.given_name,
          familyName: body.family_name,
          preferredName: body.preferred_name,
          dateOfBirth: body.date_of_birth,
          administrativeSex: body.administrative_sex,
          preferredLanguage: body.preferred_language,
          sourceChannel: body.source_channel,
          identityVerification: body.identity_verified
            ? "STAFF_VERIFIED"
            : "UNVERIFIED",
          contacts: body.contacts?.map((x) => ({
            kind: x.kind,
            value: x.value,
            isPrimary: x.is_primary,
            whatsappCapable: x.whatsapp_capable,
            verifiedVia: x.verified_by_staff ? ("STAFF" as const) : undefined,
          })),
          identifiers: body.identifiers,
        },
        hasher,
      );
      return {
        status: 201,
        body: created,
        resourceType: "patient",
        resourceId: created.patient.id,
      };
    });
  });
  app.get(`${base}/patients/:patientId`, async (req) => {
    const auth = await authorize(req, "patient.read");
    const id = idParam(req, "patientId");
    return read(req, auth, async (c, ctx) => ({
      patient: await getPatientDetail(c, ctx, id),
    }));
  });
  app.patch(`${base}/patients/:patientId`, async (req, reply) => {
    const auth = await authorize(req, "patient.write");
    const id = idParam(req, "patientId");
    const body = updatePatientSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "patient.update",
      { id, body },
      ctx,
      async (c) => {
        await updatePatient(
          c,
          ctx,
          id,
          {
            givenName: body.given_name,
            familyName: body.family_name,
            preferredName: body.preferred_name,
            dateOfBirth: body.date_of_birth,
            administrativeSex: body.administrative_sex,
            preferredLanguage: body.preferred_language,
            identityVerification:
              body.identity_verified === undefined
                ? undefined
                : body.identity_verified
                  ? "STAFF_VERIFIED"
                  : "UNVERIFIED",
            status: body.status,
          },
          body.expected_version,
        );
        return {
          status: 200,
          body: { patient: await getPatientDetail(c, ctx, id) },
        };
      },
    );
  });
  app.post(`${base}/patients/:patientId/contacts`, async (req, reply) => {
    const auth = await authorize(req, "patient.write");
    const id = idParam(req, "patientId");
    const body = addContactSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "patient.contact.add",
      { id, body },
      ctx,
      async (c) => {
        await addPatientContact(c, ctx, id, {
          kind: body.kind,
          value: body.value,
          isPrimary: body.is_primary,
          whatsappCapable: body.whatsapp_capable,
          verifiedVia: body.verified_by_staff ? "STAFF" : undefined,
        });
        return {
          status: 201,
          body: { patient: await getPatientDetail(c, ctx, id) },
        };
      },
    );
  });
  app.post(
    `${base}/patients/:patientId/contacts/:contactId/remove`,
    async (req, reply) => {
      const auth = await authorize(req, "patient.write");
      const id = idParam(req, "patientId");
      const contactId = idParam(req, "contactId");
      emptySchema.parse(req.body ?? {});
      const ctx = context(req, auth);
      return mutate(
        req,
        reply,
        auth,
        "patient.contact.remove",
        { id, contactId },
        ctx,
        async (c) => {
          await removePatientContact(c, ctx, id, contactId);
          return {
            status: 200,
            body: { patient: await getPatientDetail(c, ctx, id) },
          };
        },
      );
    },
  );
  app.post(`${base}/patients/:patientId/identifiers`, async (req, reply) => {
    const auth = await authorize(req, "patient.write");
    const id = idParam(req, "patientId");
    const body = addIdentifierSchema.parse(req.body);
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "patient.identifier.add",
      { id, body },
      ctx,
      async (c) => {
        await addPatientIdentifier(c, ctx, id, body, hasher);
        return {
          status: 201,
          body: { patient: await getPatientDetail(c, ctx, id) },
        };
      },
    );
  });
  app.get(`${base}/patient-duplicates`, async (req) => {
    const auth = await authorize(req, "patient.duplicates.review");
    const q = z
      .object({
        status: z.enum(["OPEN", "DISMISSED", "CONFIRMED"]).default("OPEN"),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    return {
      items: await read(req, auth, (c, ctx) =>
        listDuplicateCandidates(c, ctx, q),
      ),
    };
  });
  app.post(
    `${base}/patient-duplicates/:reviewId/review`,
    async (req, reply) => {
      const auth = await authorize(req, "patient.duplicates.review");
      const id = idParam(req, "reviewId");
      const body = duplicateReviewSchema.parse(req.body);
      const ctx = context(req, auth);
      return mutate(
        req,
        reply,
        auth,
        "patient.duplicate.review",
        { id, body },
        ctx,
        async (c) => {
          await reviewDuplicate(c, ctx, id, body.decision);
          return { status: 200, body: { id, status: body.decision } };
        },
      );
    },
  );

  // -------------------------------------------------------------------------
  // Staff and audit.
  // -------------------------------------------------------------------------

  app.get(`${base}/memberships`, async (req) => {
    const auth = await authorize(req, "staff.manage");
    return {
      items: await read(
        req,
        auth,
        async (c, ctx) =>
          (
            await c.query(
              `SELECT user_id,role,status,display_name,email,practitioner_id,created_by,updated_by,created_at,updated_at,version
                 FROM directory.practice_memberships WHERE tenant_id=$1 AND practice_id=$2 ORDER BY display_name, user_id`,
              [ctx.tenantId, ctx.practiceId],
            )
          ).rows,
      ),
    };
  });
  app.put(`${base}/memberships/:userId`, async (req, reply) => {
    const auth = await authorize(req, "staff.manage");
    const userId = idParam(req, "userId");
    const body = membershipSchema.parse({
      ...(req.body as object),
      user_id: userId,
    });
    if (
      userId === auth.userId &&
      (body.role !== "PRACTICE_ADMIN" || body.status !== "ACTIVE")
    )
      throw new AppError(
        409,
        "SELF_DEMOTION",
        "an administrator cannot demote or suspend themselves",
      );
    const ctx = context(req, auth);
    return mutate(
      req,
      reply,
      auth,
      "membership.upsert",
      body,
      ctx,
      async (c) => {
        const before = await c.query(
          "SELECT role,status,practitioner_id FROM directory.practice_memberships WHERE tenant_id=$1 AND practice_id=$2 AND user_id=$3",
          [ctx.tenantId, ctx.practiceId, userId],
        );
        const row = await c.query(
          `INSERT INTO directory.practice_memberships(tenant_id,practice_id,user_id,role,status,display_name,email,practitioner_id,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
         ON CONFLICT (tenant_id,practice_id,user_id) DO UPDATE
           SET role=excluded.role, status=excluded.status, display_name=excluded.display_name, email=excluded.email,
               practitioner_id=excluded.practitioner_id, updated_by=excluded.updated_by,
               version=directory.practice_memberships.version+1
         RETURNING user_id,role,status,display_name,email,practitioner_id,version`,
          [
            ctx.tenantId,
            ctx.practiceId,
            userId,
            body.role,
            body.status,
            body.display_name,
            body.email ?? null,
            body.practitioner_id ?? null,
            ctx.actor.id,
          ],
        );
        await audit(c, ctx, {
          action: "membership.upserted",
          resourceType: "user",
          resourceId: userId,
          before: before.rows[0] ?? null,
          after: {
            role: body.role,
            status: body.status,
            practitioner_id: body.practitioner_id ?? null,
          },
        });
        return { status: 200, body: { membership: row.rows[0] } };
      },
    );
  });

  app.get(`${base}/audit-events`, async (req) => {
    const auth = await authorize(req, "audit.read");
    const q = auditQuerySchema.parse(req.query);
    const rows = await read(req, auth, (c, ctx) =>
      c.query(
        `SELECT id::text,occurred_at,actor_type,actor_id,actor_role,action,resource_type,resource_id,channel,changes,reason,
                request_id,correlation_id
           FROM platform.audit_events
          WHERE tenant_id=$1 AND practice_id=$2
            AND ($3::text IS NULL OR resource_type=$3) AND ($4::text IS NULL OR resource_id=$4)
            AND ($5::bigint IS NULL OR id < $5)
          ORDER BY id DESC LIMIT $6`,
        [
          ctx.tenantId,
          ctx.practiceId,
          q.resource_type ?? null,
          q.resource_id ?? null,
          q.before_id ?? null,
          q.limit,
        ],
      ),
    );
    const items = rows.rows;
    return {
      items,
      next_before_id:
        items.length === q.limit ? items[items.length - 1]!.id : null,
    };
  });
}
