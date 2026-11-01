import { expect, open, test } from "./fixtures";

test.describe("Russian browser", () => {
  test.use({ locale: "ru-RU" });

  test("picks Russian from the browser languages", async ({ page }) => {
    await open(page, "/");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.locator("h1")).toHaveText("Чаты");
  });
});

test("the language select switches every string and remembers", async ({ page }) => {
  await open(page, "/settings/general");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByLabel("Language").selectOption("ru");
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.locator("h1:visible")).toHaveText("Настройки");
  await page.reload();
  await expect(page.locator("h1:visible")).toHaveText("Настройки");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});
