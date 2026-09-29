import { test as base, expect, type Page } from "@playwright/test";

export { expect };

/**
 * Collects what must never happen on a page: an uncaught error, or a
 * request or script the console's Content-Security-Policy refused.
 */
export function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      /Content Security Policy|Refused to (connect|load|execute|apply)/.test(
        m.text(),
      )
    )
      problems.push(`blocked: ${m.text()}`);
  });
  return problems;
}

/** Playwright's test, whose page fails the test on either. */
export const test = base.extend({
  page: async ({ page }, use) => {
    const problems = watch(page);
    await use(page);
    expect(problems).toEqual([]);
  },
});
