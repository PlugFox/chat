import { test as base, expect, type Page } from "@playwright/test";

/** Every route; the UI kit holds every component and variant. */
export const pages = ["/", "/notes", "/registers", "/saved", "/settings", "/ui-kit"] as const;

export const themes = ["light", "dark"] as const;

/** Opens a page with an explicit theme saved, as a returning user would. */
export async function open(page: Page, path: string, theme?: (typeof themes)[number]): Promise<void> {
  if (theme) {
    await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
  }
  await page.goto(path);
  await expect(page.locator("h1")).toBeVisible();
}

export function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 840;
}

export const test = base;
export { expect };
