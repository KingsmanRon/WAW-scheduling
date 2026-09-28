/**
 * Resets and seeds the browser suite's database, then exits. Runs before the
 * API starts (it is the first step of the API server's command), as the
 * migration owner. Refuses any database whose name does not contain "e2e".
 *
 * The practice's time zone is chosen so that it is mid-day there now: flows
 * that must happen "today" (check-in, same-day booking) then work at any
 * hour the suite runs, and the console is exercised in a zone that is
 * usually not the browser's.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { provisionWhatsApp } from "@access/access";
import { bootstrapPractice, migrate } from "@access/db";
import { simulateSupabase } from "../../../packages/db/src/supabase-simulation.js";
import { setNotificationPreferences } from "@access/notifications";
import { IdentifierHasher, createPatient } from "@access/patients";
import {
  createAppointmentType,
  createAvailabilityRule,
  createLocation,
  createPractitioner,
  inPracticeTransaction,
  type CommandContext,
} from "@access/scheduling";
import {
  E2E_DATABASE_URL,
  IDENTIFIER_HASH_KEY,
  PATIENTS,
  PRACTICE_ID,
  PRACTICE_NAME,
  TENANT_ID,
  WHATSAPP,
} from "./env.js";

const ZONES = [
  "Pacific/Kiritimati",
  "Pacific/Auckland",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Africa/Johannesburg",
  "Atlantic/Azores",
  "America/Sao_Paulo",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "Pacific/Honolulu",
];
/** The zone whose local time is closest to 11:00 now (always within 07:00-15:00). */
function midDayZone(now = DateTime.utc()): string {
  const score = (zone: string) => {
    const local = now.setZone(zone);
    return Math.abs(local.hour + local.minute / 60 - 11);
  };
  return [...ZONES].sort((a, b) => score(a) - score(b))[0]!;
}

async function main() {
  const url = new URL(E2E_DATABASE_URL);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/e2e/i.test(database))
    throw new Error(
      `refusing to reset "${database}": the browser suite's database name must contain "e2e"`,
    );
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const server = new pg.Client({ connectionString: admin.toString() });
  await server.connect();
  const exists = await server.query(
    "SELECT 1 FROM pg_database WHERE datname=$1",
    [database],
  );
  if (!exists.rowCount)
    await server.query(`CREATE DATABASE "${database.replace(/"/g, "")}"`);
  await server.end();

  const owner = new pg.Pool({ connectionString: E2E_DATABASE_URL, max: 4 });
  try {
    await owner.query(
      `DROP SCHEMA IF EXISTS platform, directory, scheduling, messaging, integration CASCADE;
       DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;`,
    );
    // Supabase's browser roles, their grants and Realtime, as in the vitest setup.
    await simulateSupabase(owner);
    await migrate(owner);
    await owner.query(
      "ALTER ROLE access_request LOGIN PASSWORD 'integration-api'; ALTER ROLE access_worker LOGIN PASSWORD 'integration-worker';",
    );

    const timezone = midDayZone();
    await bootstrapPractice(owner, {
      tenantId: TENANT_ID,
      tenantName: "E2E Health Group",
      practiceId: PRACTICE_ID,
      practiceName: PRACTICE_NAME,
      timezone,
    });
    const ctx: CommandContext = {
      tenantId: TENANT_ID,
      practiceId: PRACTICE_ID,
      actor: { type: "STAFF", id: "user:e2e-setup", role: "PRACTICE_ADMIN" },
      channel: "INTERNAL",
      correlationId: randomUUID(),
      mayOverrideAvailability: true,
    };
    const hasher = new IdentifierHasher(
      Buffer.from(IDENTIFIER_HASH_KEY, "hex"),
      "k1",
    );
    const today = DateTime.now().setZone(timezone).toISODate()!;
    await inPracticeTransaction(owner, ctx, async (c) => {
      const location = await createLocation(c, ctx, {
        name: "Main Rooms",
        timezone,
      });
      const [lindiwe, johan, grace] = [
        await createPractitioner(c, ctx, {
          displayName: "Dr Lindiwe Nkosi",
          familyName: "Nkosi",
          locationIds: [location.id],
        }),
        await createPractitioner(c, ctx, {
          displayName: "Dr Johan Smit",
          familyName: "Smit",
          locationIds: [location.id],
        }),
        await createPractitioner(c, ctx, {
          displayName: "Sr Grace Molefe",
          familyName: "Molefe",
          locationIds: [location.id],
        }),
      ];
      const doctors = [lindiwe!.id, johan!.id];
      // One type patients may book themselves (so the WhatsApp flow goes
      // straight to times), and one only reception books.
      await createAppointmentType(c, ctx, {
        code: "GENERAL_CONSULT",
        name: "General consultation",
        durationMinutes: 15,
        minNoticeMinutes: 0,
        maxAdvanceDays: 60,
        patientBookable: true,
        practitionerIds: doctors,
        locationIds: [location.id],
      });
      await createAppointmentType(c, ctx, {
        code: "CHRONIC_REVIEW",
        name: "Chronic medication review",
        durationMinutes: 30,
        minNoticeMinutes: 0,
        maxAdvanceDays: 60,
        patientBookable: false,
        practitionerIds: [...doctors, grace!.id],
        locationIds: [location.id],
      });
      for (const practitionerId of [...doctors, grace!.id])
        for (let weekday = 1; weekday <= 7; weekday++)
          await createAvailabilityRule(c, ctx, {
            practitionerId,
            locationId: location.id,
            weekday,
            startMinute: 6 * 60,
            endMinute: 22 * 60,
            validFrom: today,
          });
      for (const [key, p] of Object.entries(PATIENTS)) {
        const created = await createPatient(
          c,
          ctx,
          {
            givenName: p.given,
            familyName: p.family,
            dateOfBirth: p.dob,
            sourceChannel: "PHONE",
            identityVerification: "STAFF_VERIFIED",
            contacts: [
              {
                kind: "MOBILE",
                value: p.mobile,
                isPrimary: true,
                whatsappCapable: true,
              },
            ],
          },
          hasher,
        );
        // Sipho has not agreed to messages; the others have (on WhatsApp).
        if (key !== "sipho")
          await setNotificationPreferences(
            c,
            { tenantId: TENANT_ID, practiceId: PRACTICE_ID, actor: ctx.actor },
            created.patient.id,
            {
              whatsappOptIn: true,
              emailOptIn: false,
              remindersEnabled: true,
              preferredChannel: "WHATSAPP",
              expectedVersion: undefined,
            },
          );
      }
    });
    await provisionWhatsApp(owner, {
      tenantId: TENANT_ID,
      practiceId: PRACTICE_ID,
      name: "Practice WhatsApp",
      secretRef: WHATSAPP.tokenRef,
      active: true,
      operator: "operator:e2e",
      config: {
        phone_number_id: WHATSAPP.phoneNumberId,
        default_language: "en",
        templates: {},
      },
    });
    process.stdout.write(
      `e2e database ready: ${database}, practice time zone ${timezone}\n`,
    );
  } finally {
    await owner.end();
  }
}

await main();
