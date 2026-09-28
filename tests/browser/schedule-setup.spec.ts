import { expect, test } from "@playwright/test";
import { DateTime } from "luxon";
import {
  appointmentsOf,
  book,
  closeDb,
  db,
  slotsOn,
  practiceDate,
  practicePath,
  practiceZone,
  signIn,
} from "./support/app.js";
import { TENANT_ID } from "./support/env.js";

test.afterAll(closeDb);

test("blocking time over a booked appointment asks first, keeps the appointment and closes the time to booking", async ({
  page,
}) => {
  const zone = await practiceZone();
  const booked = await book("themba", {
    practitioner: "Dr Lindiwe Nkosi",
    day: 1,
    notBefore: "09:00",
  });
  const start = DateTime.fromISO(booked.slot.start).setZone(zone);
  const day = start.toISODate()!;
  await signIn(page, "RECEPTIONIST", "nomsa");
  await page.goto(practicePath("calendar", null, { date: day }));
  await page.getByRole("button", { name: "Block time" }).click();
  const dialog = page.getByRole("dialog", { name: "Block time" });
  await dialog
    .getByLabel("Practitioner")
    .selectOption({ label: "Dr Lindiwe Nkosi" });
  await dialog.getByLabel("Date").fill(day);
  await dialog.getByLabel("From").fill(start.toFormat("HH:mm"));
  await dialog
    .getByLabel("Until")
    .fill(start.plus({ hours: 1 }).toFormat("HH:mm"));
  await dialog.getByLabel("Reason").selectOption("MEETING");
  await dialog.getByRole("button", { name: "Block time" }).click();
  await expect(dialog).toContainText("1 booked appointment falls in this time");
  await dialog.getByRole("button", { name: "Block anyway" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Blocked · Meeting")).toBeVisible();

  // The appointment stays booked; the rest of the hour is no longer offered.
  expect((await appointmentsOf("themba")).at(-1)!.status).toBe("CONFIRMED");
  const slots = await slotsOn(day, "Dr Lindiwe Nkosi");
  expect(slots.length).toBeGreaterThan(0);
  const inBlock = slots.filter(
    (s) =>
      Date.parse(s.start) >= start.toMillis() &&
      Date.parse(s.start) < start.plus({ hours: 1 }).toMillis(),
  );
  expect(inBlock).toEqual([]);
  const audit = await db().query(
    "SELECT actor_id, action FROM platform.audit_events WHERE tenant_id=$1 AND resource_type='schedule_block'",
    [TENANT_ID],
  );
  expect(audit.rows).toContainEqual({
    actor_id: "synthetic:nomsa",
    action: "schedule_block.created",
  });
});

test("leave entered in schedule setup removes the practitioner's times", async ({
  page,
}) => {
  const day = await practiceDate(3);
  const offered = async () => (await slotsOn(day, "Dr Johan Smit")).length;
  expect(await offered()).toBeGreaterThan(0);

  await signIn(page, "PRACTICE_ADMIN", "admin");
  await page.goto(practicePath("setup", null, { tab: "leave" }));
  await page
    .getByLabel("Practitioner")
    .selectOption({ label: "Dr Johan Smit" });
  await page.getByRole("button", { name: "Add leave or session" }).click();
  const dialog = page.getByRole("dialog", { name: /Leave or extra session/ });
  await dialog.getByLabel("From", { exact: true }).fill(day);
  await dialog.getByLabel("Until", { exact: true }).fill(day);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Unavailable\s+Leave/)).toBeVisible();

  expect(await offered()).toBe(0);
});
