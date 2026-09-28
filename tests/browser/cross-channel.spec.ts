import { expect, test } from "./support/test.js";
import {
  Phone,
  appointmentsOf,
  book,
  closeDb,
  db,
  patientId,
  practicePath,
  signIn,
} from "./support/app.js";
import { PATIENTS, TENANT_ID } from "./support/env.js";

test.afterAll(closeDb);

test("a WhatsApp booking reaches reception, reception's change reaches WhatsApp, and a WhatsApp cancellation reaches reception", async ({
  page,
}) => {
  const phone = Phone.of("aisha");
  const aisha = `${PATIENTS.aisha.given} ${PATIENTS.aisha.family}`;

  // The patient books on WhatsApp: every time offered comes from the
  // Scheduling Core, and nothing is booked until she confirms.
  expect(await phone.send({ text: "Hi" })).toMatchObject({
    type: "button",
    options: ["M:BOOK", "M:LIST", "M:STAFF"],
  });
  const times = await phone.send({ tap: "M:BOOK" });
  expect(times.type).toBe("list");
  expect(times.options[0]).toBe("S:1");
  expect(await phone.send({ tap: "S:1" })).toMatchObject({
    options: ["H:YES", "H:NO"],
  });
  expect((await phone.send({ tap: "H:YES" })).text).toMatch(
    /^You're booked for /,
  );
  const [booked] = await appointmentsOf("aisha");
  expect(booked).toMatchObject({
    status: "CONFIRMED",
    source_channel: "WHATSAPP",
    booked_by_actor_type: "PATIENT",
  });

  // Reception sees it, booked through WhatsApp by the patient herself.
  await signIn(page, "RECEPTIONIST", "reception");
  await page.goto(practicePath("appointment", booked!.id));
  await expect(
    page.getByRole("heading", { name: new RegExp(aisha) }),
  ).toBeVisible();
  await expect(
    page.getByText("WhatsApp · The patient (self-service)"),
  ).toBeVisible();

  // Reception moves it; the patient is told on WhatsApp.
  const before = (await phone.replies()).length;
  await page.getByRole("button", { name: "Reschedule" }).click();
  const move = page.getByRole("dialog", { name: "Reschedule" });
  await move.locator(".slot-days button").nth(2).click();
  await move.locator("button.slot").first().click();
  await move.getByRole("button", { name: /^Move to / }).click();
  await expect(
    page.getByText("Booked as a move from an earlier time"),
  ).toBeVisible();
  const told = await phone.next(before);
  expect(told.template?.name).toBe("appointment_rescheduled");
  const moved = (await appointmentsOf("aisha")).at(-1)!;
  expect(moved.rescheduled_from_id).toBe(booked!.id);

  // The patient cancels on WhatsApp; reception's open page follows.
  expect(await phone.send({ text: "cancel" })).toMatchObject({
    options: ["C:YES", "C:NO"],
  });
  expect((await phone.send({ tap: "C:YES" })).text).toMatch(/is cancelled/);
  await expect(page.locator(".page-header .state")).toHaveText("Cancelled", {
    timeout: 30_000,
  });
  expect((await appointmentsOf("aisha")).at(-1)).toMatchObject({
    id: moved.id,
    status: "CANCELLED",
    cancellation_reason_code: "PATIENT_REQUEST",
  });
});

test("a freed time goes to the waitlist; the patient takes it on WhatsApp and reception sees the booking", async ({
  page,
}) => {
  const phone = Phone.of("zanele");
  const zanele = `${PATIENTS.zanele.given} ${PATIENTS.zanele.family}`;
  // Tomorrow's time for Sipho is the one that will be freed.
  const freed = await book("sipho", {
    practitioner: "Dr Lindiwe Nkosi",
    day: 1,
    notBefore: "10:00",
  });

  await signIn(page, "RECEPTIONIST", "reception");
  await page.goto(practicePath("waitlist"));
  await page.getByRole("button", { name: "Add patient" }).click();
  const add = page.getByRole("dialog", { name: "Add to waitlist" });
  await add.locator("#patient-search").fill(PATIENTS.zanele.mobile);
  await add.getByRole("button", { name: "Search" }).click();
  await add.getByRole("button", { name: new RegExp(zanele) }).click();
  await add.getByLabel("Appointment type").selectOption({
    label: "General consultation",
  });
  await add.getByRole("button", { name: "Add to waitlist" }).click();
  await expect(add).toBeHidden();
  await expect(
    page.getByRole("row", { name: new RegExp(zanele) }),
  ).toContainText("Active");

  // Sipho's appointment is cancelled at the desk: the worker offers the
  // time to Zanele, the first waiting patient it fits, and holds it for her.
  const before = (await phone.replies()).length;
  await page.goto(practicePath("appointment", freed.id));
  await page.getByRole("button", { name: "Cancel appointment" }).click();
  const cancel = page.getByRole("dialog", { name: "Cancel appointment" });
  await cancel.getByLabel("The practice cancelled").check();
  await cancel.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(cancel).toBeHidden();
  const offer = await phone.next(before);
  expect(offer.template?.name).toBe("waitlist_offer");
  const [accept] = offer.template!.payloads;
  expect(accept).toMatch(/^OFFER:[0-9a-f-]{36}:ACCEPT$/);
  await page.goto(practicePath("waitlist"));
  await expect(
    page.getByRole("row", { name: new RegExp(zanele) }),
  ).toContainText("Offered");
  // Held for her while the offer runs; nothing is booked until she answers.
  expect((await appointmentsOf("zanele")).map((a) => a.status)).toEqual([
    "HELD",
  ]);

  expect((await phone.send({ button: accept! })).text).toMatch(
    /^You're booked for /,
  );
  const [taken] = await appointmentsOf("zanele");
  expect(taken).toMatchObject({ status: "CONFIRMED" });
  expect(taken!.starts_at.toISOString()).toBe(
    new Date(freed.slot.start).toISOString(),
  );
  const entry = await db().query(
    "SELECT status FROM scheduling.waitlist_entries WHERE tenant_id=$1 AND patient_id=$2",
    [TENANT_ID, await patientId("zanele")],
  );
  expect(entry.rows).toEqual([{ status: "BOOKED" }]);
  await page.goto(practicePath("appointment", taken!.id));
  await expect(
    page.getByRole("heading", { name: new RegExp(zanele) }),
  ).toBeVisible();
});
