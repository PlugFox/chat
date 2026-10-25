import { expect, open, test } from "./fixtures";

test("a saved theme applies before the app renders (no flash)", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("theme", "dark");
    // Record data-theme at the earliest moment the body exists.
    document.addEventListener("DOMContentLoaded", () => {
      (window as unknown as { themeAtLoad: string | undefined }).themeAtLoad =
        document.documentElement.dataset["theme"];
    });
  });
  await page.goto("/");
  expect(await page.evaluate(() => (window as unknown as { themeAtLoad?: string }).themeAtLoad)).toBe("dark");
});

test("system theme follows prefers-color-scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page, "/");
  expect(await page.evaluate(() => document.documentElement.dataset["theme"])).toBeUndefined();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(bg);
});

test("the theme select switches and remembers", async ({ page }) => {
  await open(page, "/settings");
  await page.getByLabel("Theme").selectOption("dark");
  expect(await page.evaluate(() => document.documentElement.dataset["theme"])).toBe("dark");
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset["theme"])).toBe("dark");
  await expect(page.getByLabel("Theme")).toHaveValue("dark");
  await page.getByLabel("Theme").selectOption("system");
  expect(await page.evaluate(() => localStorage.getItem("theme"))).toBeNull();
});
