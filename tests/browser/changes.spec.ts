import { expect, test } from "@playwright/test";
import {
  Phone,
  appointmentsOf,
  book,
  closeDb,
  practicePath,
  signIn,
} from "./support/app.js";

test.afterAll(closeDb);

test("reception moves an appointment, then cancels it; the history and the patient's messages follow", async ({
  page,
}) => {
  const phone = Phone.of("pieter");
  const { id: original } = await book("pieter", { day: 1 });
  await signIn(page, "RECEPTIONIST", "sibongile");
  await page.goto(practicePath("appointment", original));
  await expect(page.getByText("Booked through")).toBeVisible();

  await page.getByRole("button", { name: "Reschedule" }).click();
  const move = page.getByRole("dialog", { name: "Reschedule" });
  await move.locator(".slot-days button").nth(2).click();
  await move.locator("button.slot").first().click();
  await move.getByRole("button", { name: /^Move to / }).click();
  await expect(move).toBeHidden();
  // The console opens the new appointment, linked to the old one.
  await expect(
    page.getByText("Booked as a move from an earlier time"),
  ).toBeVisible();
  let rows = await appointmentsOf("pieter");
  expect(rows.map((r) => r.status)).toEqual(["RESCHEDULED", "CONFIRMED"]);
  expect(rows[1]!.rescheduled_from_id).toBe(original);
  // Pieter agreed to WhatsApp messages: the worker tells him of the move.
  await expect
    .poll(async () => (await phone.replies()).map((r) => r.template?.name))
    .toContain("appointment_rescheduled");

  await page.getByRole("button", { name: "Cancel appointment" }).click();
  const cancel = page.getByRole("dialog", { name: "Cancel appointment" });
  await cancel.getByLabel("The patient asked to cancel").check();
  await cancel.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(cancel).toBeHidden();
  await expect(page.locator(".page-header .state")).toHaveText("Cancelled");
  rows = await appointmentsOf("pieter");
  expect(rows[1]).toMatchObject({
    status: "CANCELLED",
    cancellation_reason_code: "PATIENT_REQUEST",
  });
  await expect
    .poll(async () => (await phone.replies()).map((r) => r.template?.name))
    .toContain("appointment_cancelled");
  // Cancelled appointments offer no further changes.
  await expect(page.getByRole("button", { name: "Reschedule" })).toHaveCount(0);
});
