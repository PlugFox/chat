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
