import { expect, open, test } from "./fixtures";

test("the crypto worker runs chat-crypto under the production CSP", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await open(page, "/ui-kit");
  await page.getByRole("button", { name: "Run self-test" }).click();
  await expect(page.getByText(/Self-test passed/)).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
