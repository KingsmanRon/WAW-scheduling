import { expect, test } from "./support/test.js";
import type { Page } from "@playwright/test";
import {
  api,
  book,
  closeDb,
  patientId,
  practicePath,
  signIn,
  type PracticeRole,
} from "./support/app.js";
import { PATIENTS } from "./support/env.js";

test.afterAll(closeDb);

const ALL = [
  "Today",
  "Calendar",
  "Book appointment",
  "Patients",
  "Conversations",
  "Appointments",
  "Waitlist",
  "Referrals",
  "Notifications",
  "Schedule setup",
  "Audit",
];
const NAV: Record<PracticeRole, string[]> = {
  READ_ONLY: ["Today", "Calendar", "Appointments", "Schedule setup"],
  CLINICAL_STAFF: [
    "Today",
    "Calendar",
    "Patients",
    "Appointments",
    "Waitlist",
    "Referrals",
    "Notifications",
    "Schedule setup",
  ],
  RECEPTIONIST: ALL.filter((n) => n !== "Audit"),
  DOCTOR: ALL.filter((n) => n !== "Audit" && n !== "Conversations"),
  PRACTICE_ADMIN: ALL,
};
async function nav(page: Page): Promise<string[]> {
  return page.locator(".rail__nav .rail__text").allTextContents();
}

test.beforeAll(async () => {
  // Something on today's list for every role to look at.
  await book("sipho", { day: 0 });
});

for (const role of Object.keys(NAV) as PracticeRole[])
  test(`${role} sees only the views and actions of the role`, async ({
    page,
  }) => {
    await signIn(page, role);
    expect(await nav(page)).toEqual(NAV[role]);
    const row = page.getByRole("row", {
      name: new RegExp(`${PATIENTS.sipho.given} ${PATIENTS.sipho.family}`),
    });
    await expect(row).toBeVisible();
    const canCheckIn = role !== "READ_ONLY";
    await expect(row.getByRole("button", { name: "Check in" })).toHaveCount(
      canCheckIn ? 1 : 0,
    );
    await expect(page.getByRole("link", { name: "Walk-in" })).toHaveCount(
      NAV[role].includes("Book appointment") ? 1 : 0,
    );
    // A view outside the role explains itself instead of failing.
    const hidden = ALL.find((n) => !NAV[role].includes(n));
    if (hidden) {
      const view =
        hidden === "Book appointment" ? "book" : hidden.toLowerCase();
      await page.goto(practicePath(view));
      await expect(page.getByRole("alert")).toContainText(
        "does not include this view",
      );
    }
    // Only administrators change working hours.
    await page.goto(practicePath("setup", null, { tab: "hours" }));
    await expect(
      page.getByRole("button", { name: "Add working hours" }),
    ).toHaveCount(role === "PRACTICE_ADMIN" ? 1 : 0);
  });

test("the API refuses what the console hides, whoever calls it", async () => {
  const booking = async (role: PracticeRole) => {
    const types = await api<{ items: { id: string; code: string }[] }>(
      "GET",
      "/appointment-types",
    );
    const type = types.items.find((t) => t.code === "GENERAL_CONSULT")!;
    return api(
      "POST",
      "/appointments",
      {
        patient_id: await patientId("sipho"),
        appointment_type_id: type.id,
        practitioner_id: "00000000-0000-4000-8000-000000000000",
        location_id: "00000000-0000-4000-8000-000000000000",
        start: new Date(Date.now() + 86_400_000).toISOString(),
        source_channel: "PHONE",
      },
      role,
    );
  };
  await expect(booking("READ_ONLY")).rejects.toThrow(/: 403 /);
  await expect(booking("CLINICAL_STAFF")).rejects.toThrow(/: 403 /);
  await expect(
    api("GET", "/audit-events", undefined, "RECEPTIONIST"),
  ).rejects.toThrow(/: 403 /);
  await expect(
    api("POST", "/availability-rules", {}, "DOCTOR"),
  ).rejects.toThrow(/: 403 /);
});
