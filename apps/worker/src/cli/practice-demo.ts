import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { DateTime } from "luxon";
import { createPool } from "@access/db";
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

/**
 * Synthetic demonstration data for a bootstrapped practice in a local or
 * staging environment: a location, three practitioners, four appointment
 * types, weekday working hours and six fictitious patients (two without
 * message consent). Refused unless ACCESS_DATA_MODE is SYNTHETIC, and for a
 * practice that already has practitioners.
 *
 *   MIGRATION_DATABASE_URL=... IDENTIFIER_HASH_KEY=<the API's> \
 *   npm run practice:demo -- --tenant <org uuid> --practice <practice uuid>
 */
const { values } = parseArgs({
  options: { tenant: { type: "string" }, practice: { type: "string" } },
});
const refuse = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(64);
};
if ((process.env.ACCESS_DATA_MODE ?? "SYNTHETIC") !== "SYNTHETIC")
  refuse("demonstration data is refused outside ACCESS_DATA_MODE=SYNTHETIC");
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) refuse("MIGRATION_DATABASE_URL is required (operator credential)");
const hashKey = process.env.IDENTIFIER_HASH_KEY ?? "";
if (!/^[0-9a-fA-F]{64}$/.test(hashKey))
  refuse("IDENTIFIER_HASH_KEY (the API's, 64 hex characters) is required");
if (!values.tenant || !values.practice)
  refuse("--tenant and --practice are required");

const pool = createPool({
  connectionString: url!,
  ssl: process.env.DATABASE_SSL === "require" ? "require" : undefined,
  caCertPath: process.env.DATABASE_CA_CERT_PATH,
  caCert: process.env.DATABASE_CA_CERT,
  max: 1,
  applicationName: "access-operator",
});
const ctx: CommandContext = {
  tenantId: values.tenant!,
  practiceId: values.practice!,
  actor: { type: "STAFF", id: "operator:demo-seed", role: "PRACTICE_ADMIN" },
  channel: "INTERNAL",
  correlationId: randomUUID(),
  mayOverrideAvailability: true,
};
const hasher = new IdentifierHasher(
  Buffer.from(hashKey, "hex"),
  process.env.IDENTIFIER_HASH_KEY_ID ?? "k1",
);
try {
  const summary = await inPracticeTransaction(pool, ctx, async (c) => {
    const practice = await c.query<{ timezone: string }>(
      "SELECT timezone FROM directory.practices WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, ctx.practiceId],
    );
    const timezone =
      practice.rows[0]?.timezone ??
      refuse("practice not found; run practice:bootstrap first");
    const existing = await c.query(
      "SELECT 1 FROM scheduling.practitioners WHERE tenant_id=$1 AND practice_id=$2 LIMIT 1",
      [ctx.tenantId, ctx.practiceId],
    );
    if (existing.rowCount)
      refuse("the practice already has practitioners; nothing was changed");

    const location = await createLocation(c, ctx, {
      name: "Main Rooms",
      timezone,
    });
    const [gp1, gp2, nurse] = [
      await createPractitioner(c, ctx, {
        displayName: "Dr Naledi Mokoena",
        title: "Dr",
        givenName: "Naledi",
        familyName: "Mokoena",
        profession: "DOCTOR",
        calendarColor: "#2b6b63",
        bookableByPatients: true,
        locationIds: [location.id],
      }),
      await createPractitioner(c, ctx, {
        displayName: "Dr Pieter van Wyk",
        title: "Dr",
        givenName: "Pieter",
        familyName: "van Wyk",
        profession: "DOCTOR",
        calendarColor: "#3b7cb3",
        bookableByPatients: true,
        locationIds: [location.id],
      }),
      await createPractitioner(c, ctx, {
        displayName: "Sr Thandi Dlamini",
        title: "Sr",
        givenName: "Thandi",
        familyName: "Dlamini",
        profession: "NURSE",
        calendarColor: "#b27a12",
        locationIds: [location.id],
      }),
    ];
    const doctors = [gp1.id, gp2.id];
    await createAppointmentType(c, ctx, {
      code: "GENERAL_CONSULT",
      name: "General consultation",
      durationMinutes: 15,
      patientBookable: true,
      calendarColor: "#2b6b63",
      practitionerIds: doctors,
      locationIds: [location.id],
    });
    await createAppointmentType(c, ctx, {
      code: "FOLLOW_UP",
      name: "Follow-up",
      durationMinutes: 10,
      patientBookable: true,
      calendarColor: "#5cc493",
      practitionerIds: doctors,
      locationIds: [location.id],
    });
    await createAppointmentType(c, ctx, {
      code: "CHRONIC_REVIEW",
      name: "Chronic medication review",
      durationMinutes: 30,
      patientBookable: false,
      calendarColor: "#b27a12",
      practitionerIds: [...doctors, nurse.id],
      locationIds: [location.id],
    });
    await createAppointmentType(c, ctx, {
      code: "SPECIALIST_CONSULT",
      name: "Specialist consultation",
      durationMinutes: 30,
      requiresReferral: true,
      patientBookable: false,
      calendarColor: "#933722",
      practitionerIds: [gp2.id],
      locationIds: [location.id],
    });
    const today = DateTime.now().setZone(timezone).toISODate()!;
    for (const practitionerId of [...doctors, nurse.id])
      for (let weekday = 1; weekday <= 5; weekday++)
        await createAvailabilityRule(c, ctx, {
          practitionerId,
          locationId: location.id,
          weekday,
          startMinute: 8 * 60,
          endMinute: 17 * 60,
          validFrom: today,
        });
    await createAvailabilityRule(c, ctx, {
      practitionerId: gp1.id,
      locationId: location.id,
      weekday: 6,
      startMinute: 8 * 60,
      endMinute: 12 * 60,
      validFrom: today,
    });
    // Fictitious people; the +27 82 555 01xx range is used only here.
    const people: [string, string, string, boolean][] = [
      ["Lerato", "Khumalo", "1988-04-12", true],
      ["Johan", "Botha", "1975-09-30", true],
      ["Ayesha", "Patel", "1992-01-07", true],
      ["Sipho", "Ndlovu", "2001-06-21", false],
      ["Maria", "Fernandes", "1964-11-02", true],
      ["Themba", "Zulu", "1983-03-15", false],
    ];
    let n = 0;
    for (const [given, family, dob, consent] of people) {
      n++;
      const created = await createPatient(
        c,
        ctx,
        {
          givenName: given,
          familyName: family,
          dateOfBirth: dob,
          sourceChannel: "INTERNAL",
          identityVerification: "STAFF_VERIFIED",
          contacts: [
            {
              kind: "MOBILE",
              value: `+2782555${String(100 + n).padStart(4, "0")}`,
              isPrimary: true,
              whatsappCapable: true,
            },
          ],
        },
        hasher,
      );
      if (consent)
        await setNotificationPreferences(
          c,
          {
            tenantId: ctx.tenantId,
            practiceId: ctx.practiceId,
            actor: ctx.actor,
          },
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
    return { location: location.id, practitioners: 3, types: 4, patients: n };
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  await pool.end();
}
