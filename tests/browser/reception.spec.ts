import { expect, test } from "./support/test.js";
import type { Page } from "@playwright/test";
import {
  appointmentsOf,
  closeDb,
  db,
  practicePath,
  signIn,
} from "./support/app.js";
import { PATIENTS, TENANT_ID, type PatientKey } from "./support/env.js";

test.afterAll(closeDb);

/** Books the first time today for a patient, through the booking screen. */
async function bookToday(page: Page, key: PatientKey, channel: string) {
  const p = PATIENTS[key];
  await page.goto(practicePath("book"));
  await page.locator("#patient-search").fill(p.mobile);
  await page.getByRole("button", { name: "Search" }).click();
  await page
    .getByRole("button", { name: new RegExp(`${p.given} ${p.family}`) })
    .click();
  await page
    .getByLabel("Type")
    .selectOption({ label: "General consultation (15 min)" });
  await page.getByLabel("How the request reached us").selectOption(channel);
  // It is mid-day where the practice is: today is the first day offered.
  await page.locator(".slot-days button").first().click();
  await page.locator("button.slot").first().click();
  await expect(page.getByRole("timer")).toContainText(/\d:\d\d left/);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { name: "Booked" })).toBeVisible();
}

test("reception books a phone appointment and takes the visit from arrival to completion @phone", async ({
  page,
}, info) => {
  const key: PatientKey = info.project.name === "phone" ? "lerato" : "naledi";
  const p = PATIENTS[key];
  await signIn(page, "RECEPTIONIST", "thandeka");
  const before = (await appointmentsOf(key)).length;
  await bookToday(page, key, "PHONE");

  // Recorded once by the Scheduling Core, as a phone booking made by the
  // signed-in receptionist.
  const rows = await appointmentsOf(key);
  expect(rows).toHaveLength(before + 1);
  const appointment = rows.at(-1)!;
  expect(appointment).toMatchObject({
    status: "CONFIRMED",
    source_channel: "PHONE",
    booked_by_actor_type: "STAFF",
    booked_by_actor_id: "synthetic:thandeka",
    booked_by_role: "RECEPTIONIST",
  });
  const audit = await db().query(
    "SELECT actor_id, actor_role, channel FROM platform.audit_events WHERE tenant_id=$1 AND action='appointment.created' AND resource_id=$2",
    [TENANT_ID, appointment.id],
  );
  expect(audit.rows).toEqual([
    {
      actor_id: "synthetic:thandeka",
      actor_role: "RECEPTIONIST",
      channel: "PHONE",
    },
  ]);

  // The day view lists it; the visit moves through its states.
  await page.goto(practicePath("today"));
  const row = page.getByRole("row", {
    name: new RegExp(`${p.given} ${p.family}`),
  });
  await expect(row).toContainText("Booked");
  await row.getByRole("button", { name: "Check in" }).click();
  await expect(row).toContainText("Arrived");
  await row.getByRole("button", { name: "Start" }).click();
  await expect(row).toContainText("In consultation");
  await row.getByRole("button", { name: "Complete" }).click();
  await expect(row).toContainText("Completed");
  expect((await appointmentsOf(key)).at(-1)!.status).toBe("COMPLETED");

  // Its history names each step and who took it.
  await row.getByRole("link").first().click();
  const history = page.locator("section", { hasText: "History" }).first();
  for (const step of [
    "Booked",
    "Checked in",
    "Consultation started",
    "Completed",
  ])
    await expect(history).toContainText(step);
});

test("a walk-in is registered at the desk and booked in one sitting", async ({
  page,
}) => {
  await signIn(page, "RECEPTIONIST", "thandeka");
  await page.getByRole("link", { name: "Walk-in" }).click();
  await expect(page.getByLabel("How the request reached us")).toHaveValue(
    "WALK_IN",
  );
  await page.getByRole("button", { name: "Register a new patient" }).click();
  const dialog = page.getByRole("dialog", { name: "Register a patient" });
  await dialog.getByLabel("Given name(s)").fill("Busisiwe");
  await dialog.getByLabel("Family name").fill("Zwane");
  await dialog.getByLabel("Date of birth").fill("1999-04-01");
  await dialog.getByLabel("Mobile number").fill("083 555 0101");
  await dialog
    .getByLabel("I have checked the patient’s identity document")
    .check();
  await expect(dialog.getByLabel("Registered through")).toHaveValue("WALK_IN");
  await dialog.getByRole("button", { name: "Register patient" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Busisiwe Zwane")).toBeVisible();

  await page
    .getByLabel("Type")
    .selectOption({ label: "General consultation (15 min)" });
  await page.locator("button.slot").first().click();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { name: "Booked" })).toBeVisible();
  await expect(page.getByText("booked by walk-in")).toBeVisible();

  const rows = await db().query(
    `SELECT p.source_channel AS registered, p.identity_verification, a.source_channel AS booked, c.value AS mobile
       FROM directory.patients p
       JOIN scheduling.appointments a ON a.patient_id=p.id
       JOIN directory.patient_contacts c ON c.patient_id=p.id AND c.kind='MOBILE'
      WHERE p.tenant_id=$1 AND p.family_name='Zwane'`,
    [TENANT_ID],
  );
  expect(rows.rows).toEqual([
    {
      registered: "WALK_IN",
      identity_verification: "STAFF_VERIFIED",
      booked: "WALK_IN",
      mobile: "+27835550101",
    },
  ]);
});
