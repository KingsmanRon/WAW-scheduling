import { expect, test, type Page } from "@playwright/test";
import {
  appointmentsOf,
  closeDb,
  db,
  practicePath,
  signIn,
} from "./support/app.js";
import { PATIENTS, TENANT_ID, type PatientKey } from "./support/env.js";

test.afterAll(closeDb);

/** Opens booking for a patient, Dr Johan Smit's times, the day after tomorrow. */
async function lookAtSmitsDay(page: Page, key: PatientKey) {
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
  await page
    .locator("#book-practitioner")
    .selectOption({ label: "Dr Johan Smit" });
  await page.locator(".slot-days button").nth(2).click();
}

test("two receptionists pick the same time: one holds it, the other is told it has gone", async ({
  browser,
}) => {
  const desks = await Promise.all([browser.newContext(), browser.newContext()]);
  const [one, two] = await Promise.all(desks.map((d) => d.newPage()));
  await signIn(one!, "RECEPTIONIST", "desk-one");
  await signIn(two!, "RECEPTIONIST", "desk-two");
  await lookAtSmitsDay(one!, "johan");
  await lookAtSmitsDay(two!, "fatima");

  const first = one!.locator("button.slot").first();
  const same = two!.locator("button.slot").first();
  const time = (await first.locator(".slot__time").textContent())!;
  await expect(same.locator(".slot__time")).toHaveText(time);

  await first.click();
  await expect(one!.getByRole("timer")).toBeVisible();
  await same.click();
  await expect(two!.getByRole("alert")).toContainText(
    "The requested time is no longer available.",
  );
  // The second desk's list refreshes without the taken time.
  await expect(
    two!.locator("button.slot").first().locator(".slot__time"),
  ).not.toHaveText(time);

  await one!.getByRole("button", { name: "Confirm booking" }).click();
  await expect(one!.getByRole("heading", { name: "Booked" })).toBeVisible();
  expect((await appointmentsOf("johan")).map((a) => a.status)).toEqual([
    "CONFIRMED",
  ]);
  expect(await appointmentsOf("fatima")).toEqual([]);
  // Nobody else holds or has that time with Dr Smit.
  const overlapping = await db().query(
    `SELECT count(*)::int AS n FROM scheduling.appointments a
       JOIN scheduling.practitioners p ON p.id=a.practitioner_id
      WHERE a.tenant_id=$1 AND p.display_name='Dr Johan Smit' AND a.status IN ('HELD','CONFIRMED')
        AND a.starts_at=(SELECT starts_at FROM scheduling.appointments WHERE tenant_id=$1 AND patient_id=(
              SELECT patient_id FROM directory.patient_contacts WHERE tenant_id=$1 AND value=$2))`,
    [TENANT_ID, PATIENTS.johan.mobile],
  );
  expect(overlapping.rows[0]!.n).toBe(1);
  await Promise.all(desks.map((d) => d.close()));
});
