import type { Page } from "@playwright/test";
import { expect, test } from "./support/test.js";
import { PRACTICE_ID, TENANT_ID } from "./support/env.js";

/**
 * The front page signed-out visitors land on: a sample practice run by the
 * Scheduling Core's own rules in the browser, ending in the console's real
 * sign-in. No API is needed to read it; signing in hands over to the console.
 */

/** Scrolls so an act sits at a given share of its own scroll length. */
async function scrollAct(page: Page, id: string, at: number): Promise<void> {
  await page.evaluate(
    ([id, at]) => {
      const act = document.getElementById(id as string)!;
      const top = act.getBoundingClientRect().top + scrollY;
      const travel = Math.max(act.offsetHeight - innerHeight, 1);
      scrollTo({ top: top + travel * (at as number), behavior: "instant" });
    },
    [id, at] as const,
  );
  // The engine reads scroll on the next frame.
  await page.waitForTimeout(250);
}

test("a signed-out visitor lands on the front page and signs in to the console", async ({
  page,
}) => {
  await page.goto(`/#/p/${PRACTICE_ID}/waitlist`);
  await expect(page).toHaveURL(/\/welcome\/\?next=.*#sign-in$/);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /one appointment book for every way patients reach/,
    }),
  ).toBeVisible();
  // Arriving for the sign-in puts the cursor in it.
  await expect(page.getByLabel("Organisation (tenant) ID")).toBeFocused();
  await page.getByLabel("Organisation (tenant) ID").fill(TENANT_ID);
  await page.getByLabel("Practice role").selectOption("RECEPTIONIST");
  await page.getByLabel("Staff name (synthetic)").fill("front-page");
  await page.getByRole("button", { name: "Enter console" }).click();
  // Back to the page the visitor asked for.
  await expect(page).toHaveURL(new RegExp(`/#/p/${PRACTICE_ID}/waitlist$`));
  await expect(page.getByRole("heading", { name: "Waitlist" })).toBeVisible();
});

test("the sample morning is computed live: requests are placed and one time is never given twice", async ({
  page,
}) => {
  await page.goto("/welcome/");
  await expect(page.locator("html.sc-ready")).toBeAttached();
  // Visit steps go through the state machine.
  const arrived = page.locator(".wp-tile", { hasText: "Arrived" });
  await expect(arrived).toContainText("2");
  await page.getByRole("button", { name: "Check in: Fatima Adams" }).click();
  await expect(arrived).toContainText("3");

  await scrollAct(page, "channels", 1);
  const feed = page.locator(".wp-request");
  await expect(feed).toHaveCount(5);
  await expect(feed.nth(0)).toContainText("Booked 09:15 · Dr Johan Smit");
  await expect(feed.nth(4)).toContainText(
    "Offered 09:15, held until he answers",
  );

  // The race at its end: 25 requests, 1 held, 24 refused, none given twice.
  await scrollAct(page, "race", 1);
  const ledger = page.locator(".wp-ledger__n");
  await expect(ledger.nth(0)).toHaveText("25");
  await expect(ledger.nth(1)).toHaveText("1");
  await expect(ledger.nth(2)).toHaveText("24");
  await expect(ledger.nth(3)).toHaveText("0");
  await expect(page.locator(".wp-race")).toHaveAttribute(
    "data-sc-verify-state",
    /^resolved\|25\|24$/,
  );
  await expect(page.locator(".wp-block--won")).toContainText(
    "10:15 Held · LM · WhatsApp",
  );
  // The visitor's time is carried to the sign-in.
  await expect(page.locator(".wp-close__carry")).toContainText(
    "you gave Lerato",
  );
});

test("the visitor chooses the patient's time and the race, record and close follow it", async ({
  page,
}) => {
  await page.goto("/welcome/");
  await expect(page.locator("html.sc-ready")).toBeAttached();
  await scrollAct(page, "whatsapp", 0.2);
  await page
    .locator(".wp-options")
    .getByRole("button", { name: "11:00" })
    .click();
  await expect(
    page.locator(".wp-options").getByRole("button", { name: "11:00" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".wp-bubble--tap")).toContainText("11:00 please");
  await expect(page.locator("#race .wp-context")).toContainText(
    "11:00 with Dr Lindiwe Nkosi",
  );
  await expect(page.locator("#record-title")).toContainText("11:00");

  // A late afternoon time: refused requests spill to the next working day.
  const late = page.getByRole("button", { name: "16:45, free" });
  await late.focus();
  await expect(late).toBeInViewport();
  await late.press("Enter");
  await scrollAct(page, "race", 1);
  await expect(page.locator(".wp-board__later")).toBeVisible();
  await expect(page.locator(".wp-board__later")).toContainText("placed on");
  await expect(page.locator(".wp-ledger__n").nth(2)).toHaveText("24");
});

test("the skip link and the chrome's sign-in reach the form by keyboard", async ({
  page,
}) => {
  await page.goto("/welcome/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to sign in" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#sign-in$/);
  await expect(page.getByLabel("Organisation (tenant) ID")).toBeFocused();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeInViewport();
});

test("with reduced motion every act still arrives and the whole day stays reachable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/welcome/");
  await expect(page.locator("html.sc-ready")).toBeAttached();
  await scrollAct(page, "whatsapp", 0.5);
  // The sideways day becomes an ordinary scroll region: its last time can be reached.
  const last = page.getByRole("button", { name: "16:45, free" });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await scrollAct(page, "race", 1);
  await expect(page.locator(".wp-ledger__n").nth(2)).toHaveText("24");
  await expect(page.locator(".wp-chips")).toBeHidden();
});

test("the page's own chrome reaches the sign-in, on a desktop and on a phone @phone", async ({
  page,
}, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/welcome/");
  // The console's rail on a desktop; its top bar and tab bar on a phone.
  const chrome = page.locator(phone ? ".wp-topbar" : ".wp-rail");
  await expect(chrome).toBeVisible();
  await expect(page.locator(".wp-tabs")).toBeVisible({ visible: phone });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  await chrome.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByLabel("Organisation (tenant) ID")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Enter console" }),
  ).toBeInViewport();
});
