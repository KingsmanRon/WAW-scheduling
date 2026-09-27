import pg from "pg";
import { randomUUID } from "node:crypto";
import type { PracticeRole } from "../../packages/contracts/src/index.js";
import {
  bootstrapPractice,
  withIdempotency,
  type DbClient,
} from "../../packages/db/src/index.js";
import {
  IdentifierHasher,
  createPatient,
  type PatientInput,
} from "../../packages/patients/src/index.js";
import {
  DAY_MS,
  SchedulingError,
  createAppointmentType,
  createAvailabilityRule,
  createLocation,
  createPractitioner,
  inPracticeTransaction,
  localDateOf,
  schedulingErrorFromDatabase,
  wallClockToInstant,
  type AppointmentTypeInput,
  type CommandContext,
} from "../../packages/scheduling/src/index.js";
import { apiPool, ownerPool } from "./harness.js";

export const TZ = "Africa/Johannesburg";
export const hasher = new IdentifierHasher(Buffer.alloc(32, 7), "test-key-1");

export interface TestPractice {
  tenantId: string;
  practiceId: string;
  locationId: string;
  practitionerIds: [string, string];
  typeId: string;
  adminUserId: string;
}

export function staffCtx(
  p: Pick<TestPractice, "tenantId" | "practiceId">,
  role: PracticeRole = "RECEPTIONIST",
  over: Partial<CommandContext> = {},
): CommandContext {
  return {
    tenantId: p.tenantId,
    practiceId: p.practiceId,
    actor: { type: "STAFF", id: `user:${randomUUID()}`, role },
    channel: "PHONE",
    correlationId: randomUUID(),
    mayOverrideAvailability: role !== "READ_ONLY",
    ...over,
  };
}
export function patientCtx(
  p: Pick<TestPractice, "tenantId" | "practiceId">,
  patientId: string,
  sessionRef: string,
): CommandContext {
  return {
    tenantId: p.tenantId,
    practiceId: p.practiceId,
    actor: { type: "PATIENT", id: `patient:${patientId}`, role: null },
    channel: "WHATSAPP",
    correlationId: randomUUID(),
    sessionRef,
  };
}
export function systemCtx(
  p: Pick<TestPractice, "tenantId" | "practiceId">,
): CommandContext {
  return {
    tenantId: p.tenantId,
    practiceId: p.practiceId,
    actor: { type: "SYSTEM", id: "system:test", role: null },
    channel: "INTERNAL",
    correlationId: randomUUID(),
  };
}

/** Run scheduling work as the least-privilege API login. */
export function run<T>(
  ctx: CommandContext,
  fn: (c: DbClient) => Promise<T>,
  pool: pg.Pool = apiPool(),
): Promise<T> {
  return inPracticeTransaction(pool, ctx, fn);
}

/** The code a scheduling command fails with (undefined when it succeeds). */
export async function failure(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    if (e instanceof SchedulingError) return e.code;
    throw e;
  }
}

/** A practice with one location, two practitioners working 08:00-17:00 every day, and a 30-minute type. */
export async function newPractice(
  options: {
    timezone?: string;
    type?: Partial<AppointmentTypeInput>;
    holdTtlSeconds?: number;
  } = {},
): Promise<TestPractice> {
  const tenantId = randomUUID();
  const practiceId = randomUUID();
  const adminUserId = randomUUID();
  const timezone = options.timezone ?? TZ;
  await bootstrapPractice(ownerPool(), {
    tenantId,
    tenantName: `Test organisation ${tenantId.slice(0, 8)}`,
    practiceId,
    practiceName: `Test practice ${practiceId.slice(0, 8)}`,
    timezone,
    admin: { userId: adminUserId, displayName: "Test Admin" },
  });
  if (options.holdTtlSeconds)
    await ownerPool().query(
      "UPDATE directory.practices SET hold_ttl_seconds=$2, version=version+1 WHERE id=$1",
      [practiceId, options.holdTtlSeconds],
    );
  const admin = staffCtx({ tenantId, practiceId }, "PRACTICE_ADMIN", {
    actor: { type: "STAFF", id: `user:${adminUserId}`, role: "PRACTICE_ADMIN" },
  });
  return run(admin, async (c) => {
    const location = await createLocation(c, admin, {
      name: "Main rooms",
      timezone,
    });
    const a = await createPractitioner(c, admin, {
      displayName: "Dr Alpha Test",
      familyName: "Test",
      locationIds: [location.id],
    });
    const b = await createPractitioner(c, admin, {
      displayName: "Dr Beta Test",
      familyName: "Beta",
      locationIds: [location.id],
    });
    const type = await createAppointmentType(c, admin, {
      code: "CONSULT",
      name: "Consultation",
      durationMinutes: 30,
      minNoticeMinutes: 0,
      maxAdvanceDays: 120,
      practitionerIds: [a.id, b.id],
      locationIds: [location.id],
      ...options.type,
    });
    for (const practitionerId of [a.id, b.id])
      for (let weekday = 1; weekday <= 7; weekday++)
        await createAvailabilityRule(c, admin, {
          practitionerId,
          locationId: location.id,
          weekday,
          startMinute: 8 * 60,
          endMinute: 17 * 60,
          validFrom: "2026-01-01",
        });
    return {
      tenantId,
      practiceId,
      locationId: location.id,
      practitionerIds: [a.id, b.id] as [string, string],
      typeId: type.id,
      adminUserId,
    };
  });
}

let patientCounter = 0;
export async function newPatient(
  p: TestPractice,
  input: Partial<PatientInput> = {},
): Promise<string> {
  patientCounter++;
  const ctx = staffCtx(p);
  return run(ctx, async (c) => {
    const created = await createPatient(
      c,
      ctx,
      {
        givenName: `Synthetic${patientCounter}`,
        familyName: `Patient${randomUUID().slice(0, 6)}`,
        dateOfBirth: "1985-04-12",
        sourceChannel: "PHONE",
        contacts: [
          {
            kind: "MOBILE",
            value: `+2782${String(1_000_000 + patientCounter * 7919).slice(-7)}`,
          },
        ],
        ...input,
      },
      hasher,
    );
    return created.patient.id;
  });
}

/** A local wall-clock time `days` days from today in the practice zone. */
export function slot(days: number, hhmm: string, tz = TZ): Date {
  const date = localDateOf(Date.now() + days * DAY_MS, tz);
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return wallClockToInstant(date, h * 60 + m, tz)!;
}

/** The API's refusal mapping for idempotent commands (see apps/core-api). */
export function storedRefusal(
  e: unknown,
): { status: number; body: unknown } | null {
  const domain =
    e instanceof SchedulingError ? e : schedulingErrorFromDatabase(e);
  return domain
    ? {
        status: domain.statusCode,
        body: { error: domain.code, message: domain.message },
      }
    : null;
}
export { withIdempotency };
