import AxeBuilder from "@axe-core/playwright";
import { expect, open, pages, test, themes } from "./fixtures";

for (const theme of themes) {
  for (const path of pages) {
    test(`axe: ${path} in ${theme}`, async ({ page }) => {
      await open(page, path, theme);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual(
        [],
      );
    });
  }
}

test("axe: the open dialog", async ({ page }) => {
  await open(page, "/ui-kit");
  await page.getByRole("button", { name: "Open dialog" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});
