import type { Page } from "@playwright/test";
import { expect, isPhone, open, pages, test } from "./fixtures";

/** Every visible focusable element is at least 48×48 CSS px (docs/design-system.md). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const focusable = document.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    return [...focusable]
      .filter((el) => el.checkVisibility() && !el.closest("[inert]"))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 47.5 || r.height < 47.5))
      .map(
        ({ el, r }) =>
          `${el.tagName.toLowerCase()} "${el.textContent?.trim() || el.getAttribute("aria-label")}" ${Math.round(r.width)}×${Math.round(r.height)}`,
      );
  });
}

test.describe("signed out", () => {
  test.use({ signedIn: false });

  test("48px targets: /sign-in, both steps", async ({ page }) => {
    await open(page, "/sign-in");
    expect(await smallTargets(page)).toEqual([]);
    await page.getByLabel("Email address").fill("ann@example.com");
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByLabel("Code from the email")).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);
  });
});

for (const path of pages) {
  test(`48px targets: ${path}`, async ({ page }) => {
    await open(page, path);
    expect(await smallTargets(page)).toEqual([]);
    if (isPhone(page)) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      expect(await smallTargets(page)).toEqual([]);
    }
  });
}
