import type {
  BookingChannel,
  PracticeRole,
  SchedulingActorType,
} from "@access/contracts";
import type { AuditRequestMeta } from "@access/db";
import { SchedulingError } from "../domain/errors.js";

/**
 * Who is acting, for which practice, through which channel. Built by the API
 * from the verified session (staff), by the access layer from a channel
 * conversation (patient), or by the worker (system). Never from request
 * bodies.
 */
export interface SchedulingActor {
  type: SchedulingActorType;
  /** user:<auth uuid> | patient:<patient uuid> | system:<component> */
  id: string;
  role: PracticeRole | null;
}
export interface CommandContext {
  tenantId: string;
  practiceId: string;
  actor: SchedulingActor;
  channel: BookingChannel;
  correlationId: string;
  /** The session that owns holds created here (conversation, console flow). */
  sessionRef?: string | null;
  /** The actor may book outside published availability (audited). */
  mayOverrideAvailability?: boolean;
  request?: AuditRequestMeta;
}

export const SYSTEM_SCHEDULING_ACTOR: SchedulingActor = {
  type: "SYSTEM",
  id: "system:scheduling-worker",
  role: null,
};

/**
 * Translate PostgreSQL invariant violations raised inside a scheduling
 * transaction into domain errors. These fire when a concurrent writer won a
 * race the application-level checks could not see: the database constraint
 * is the final authority.
 */
export function schedulingErrorFromDatabase(
  e: unknown,
): SchedulingError | null {
  const err = e as { code?: unknown; constraint?: unknown };
  const constraint = typeof err.constraint === "string" ? err.constraint : "";
  switch (err.code) {
    case "23P01":
      if (constraint === "appointments_no_practitioner_overlap")
        return new SchedulingError("SLOT_UNAVAILABLE");
      if (constraint === "availability_rules_no_overlap")
        return new SchedulingError("AVAILABILITY_RULE_CONFLICT");
      return null;
    case "23505":
      if (constraint === "appointments_one_live_replacement")
        return new SchedulingError(
          "INVALID_TRANSITION",
          "The appointment is already being rescheduled.",
        );
      if (constraint === "waitlist_entries_one_open_per_type")
        return new SchedulingError("WAITLIST_DUPLICATE");
      return null;
    case "SCH01":
      return new SchedulingError("HOLD_EXPIRED");
    case "SCH02":
      return new SchedulingError("INVALID_TRANSITION");
    default:
      return null;
  }
}
