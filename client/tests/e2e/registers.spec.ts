import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, isPhone, open, test, themes } from "./fixtures";

/** The rows of a `List`, without the lines of details inside each. */
function rows(list: Locator) {
  return list.locator(":scope > li");
}

function dialog(page: Page) {
  return page.getByRole("dialog");
}

/** Adds an entry through the dialog; `when` is `YYYY-MM-DDTHH:mm` on this device's clock. */
async function add(page: Page, value: string, when?: string, comment?: string): Promise<void> {
  await page.getByRole("button", { name: "Add an entry" }).click();
  await dialog(page)
    .getByLabel(/^Value/)
    .fill(value);
  if (when) await dialog(page).getByLabel("Date and time").fill(when);
  if (comment) await dialog(page).getByLabel("Comment").fill(comment);
  await dialog(page).getByRole("button", { name: "Save" }).click();
  await expect(dialog(page)).toBeHidden();
}

test("an entry is added, shown by day and as itself, changed and deleted", async ({ page, keys }) => {
  await open(page, "/registers");
  await expect(page.getByRole("heading", { name: "Body" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Weight/ })).toContainText("No entries");
  await page.getByRole("link", { name: /Weight/ }).click();
  await expect(page).toHaveURL(/\/registers\/body\.weight$/);
  await expect(page.getByText("No entries yet.")).toBeVisible();

  await add(page, "80,5", "2026-10-28T08:00", "fasting");
  await add(page, "81.5", "2026-10-28T20:00");
  // The server holds sealed values only.
  expect(keys.registers.entries.size).toBe(2);
  for (const entry of keys.registers.entries.values()) {
    expect(Buffer.from(entry.value).includes("fasting")).toBe(false);
  }
  await expect(page.getByRole("img", { name: "Chart: Weight" })).toBeVisible();
  const days = page.getByRole("list", { name: "Average of the day" });
  await expect(rows(days)).toHaveCount(1);
  await expect(days).toContainText("81 kg");
  await expect(days).toContainText("2 entries");

  await page.getByLabel("Show").selectOption({ label: "Every entry" });
  const entries = page.getByRole("list", { name: "Every entry" });
  await expect(rows(entries)).toHaveCount(2);
  await expect(rows(entries).first()).toContainText("81.5 kg");
  await expect(rows(entries).last()).toContainText("fasting");

  await rows(entries).first().getByRole("button", { name: "Edit the entry" }).click();
  await expect(dialog(page).getByLabel(/^Value/)).toHaveValue("81.5");
  await expect(dialog(page).getByLabel("Date and time")).toHaveValue("2026-10-28T20:00");
  await dialog(page)
    .getByLabel(/^Value/)
    .fill("82");
  await dialog(page).getByRole("button", { name: "Save" }).click();
  await expect(rows(entries).first()).toContainText("82 kg");

  await rows(entries).last().getByRole("button", { name: "Delete the entry" }).click();
  await page.getByRole("dialog", { name: "Delete this entry?" }).getByRole("button", { name: "Delete" }).click();
  await expect(rows(entries)).toHaveCount(1);
  expect(keys.registers.entries.size).toBe(1);

  await page.reload();
  if (isPhone(page)) await page.getByRole("button", { name: "Back to data" }).click();
  await expect(page.getByRole("link", { name: /Weight/ })).toContainText("82 kg");
});

test("a metric that adds up shows the day's total", async ({ page }) => {
  await open(page, "/registers/activity.steps");
  await add(page, "4000", "2026-10-27T09:00");
  await add(page, "6 500", "2026-10-27T18:00");
  await add(page, "1000", "2026-10-28T09:00");
  const days = page.getByRole("list", { name: "Total of the day" });
  await expect(rows(days)).toHaveCount(2);
  await expect(rows(days).first()).toContainText("1,000");
  await expect(rows(days).last()).toContainText("10,500");
  if (isPhone(page)) await page.getByRole("button", { name: "Back to data" }).click();
  await expect(page.getByRole("link", { name: /Steps/ })).toContainText("1,000");
});

test("a value is checked against its metric", async ({ page, keys }) => {
  await open(page, "/registers/activity.steps");
  await page.getByRole("button", { name: "Add an entry" }).click();
  const value = dialog(page).getByLabel(/^Value/);
  const save = dialog(page).getByRole("button", { name: "Save" });
  for (const [typed, error] of [
    ["many", "Enter a number."],
    ["10.5", "Enter a whole number."],
    ["300000", "Enter a value from 0 to 200,000."],
  ] as const) {
    await value.fill(typed);
    await save.click();
    await expect(dialog(page).getByText(error)).toBeVisible();
  }
  expect(keys.registers.entries.size).toBe(0);
});

test("a change made elsewhere first keeps that version", async ({ page, keys }) => {
  await open(page, "/registers/body.weight");
  await add(page, "80", "2026-10-28T08:00");
  await page.getByLabel("Show").selectOption({ label: "Every entry" });
  keys.registers.conflictNext = true;
  await page.getByRole("button", { name: "Edit the entry" }).click();
  await dialog(page)
    .getByLabel(/^Value/)
    .fill("90");
  await dialog(page).getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("The entry was changed on another device")).toBeVisible();
  await expect(page.getByRole("list", { name: "Every entry" })).toContainText("80 kg");
});

for (const theme of themes) {
  test(`axe: a metric with its chart and the entry dialog in ${theme}`, async ({ page }) => {
    await open(page, "/registers/body.weight", theme);
    await add(page, "80", "2026-10-27T08:00");
    await add(page, "79.5", "2026-10-28T08:00");
    await expect(page.getByRole("img", { name: "Chart: Weight" })).toBeVisible();
    const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
    const results = await new AxeBuilder({ page }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    await page.getByRole("button", { name: "Add an entry" }).click();
    await expect(dialog(page)).toBeVisible();
    const open_ = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
    expect(open_.violations.map((v) => v.id)).toEqual([]);
  });
}
