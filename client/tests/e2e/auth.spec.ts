import AxeBuilder from "@axe-core/playwright";
import { expect, open, test, themes } from "./fixtures";

test.describe("signed out", () => {
  test.use({ signedIn: false });

  test("every page leads to sign-in", async ({ page }) => {
    for (const path of ["/", "/settings"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in$/);
      await expect(page.locator("h1")).toHaveText("Sign in");
    }
  });

  test("sign in with an email code", async ({ page, auth }) => {
    await open(page, "/sign-in");
    await page.getByLabel("Email address").fill("ann@example.com");
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByText("We sent an 8-digit code to ann@example.com")).toBeVisible();

    await page.getByLabel("Code from the email").fill("00000000");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(/does not match/);

    await page.getByLabel("Code from the email").fill("12345678");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // Signing in is not unlocking (G6).
    await expect(page.locator("h1")).toHaveText("Unlock");
    await expect.poll(() => auth.requests).toContain("PUT /auth/session");
  });

  test("errors from the Google redirect are shown", async ({ page }) => {
    await open(page, "/sign-in?error=signup_closed");
    await expect(page.getByRole("alert")).toHaveText("This address cannot create an account on this server.");
  });

  for (const theme of themes) {
    test(`axe: /sign-in in ${theme}`, async ({ page }) => {
      await open(page, "/sign-in", theme);
      await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      expect(results.violations.map((v) => v.id)).toEqual([]);
    });
  }
});

test("signed in: /sign-in returns to the app", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.locator("h1")).toHaveText("Chats");
});

test("settings list sessions, sign-in methods and activity; sign-out leaves", async ({ page, auth }) => {
  await open(page, "/settings/devices");
  const sessions = page.getByRole("list", { name: "Signed-in devices" });
  await expect(sessions.getByRole("listitem").filter({ hasText: "This device" })).toContainText("Chrome on macOS");
  await expect(sessions).toContainText("Germany");
  await expect(page.getByRole("button", { name: "Sign out Firefox on macOS" })).toBeVisible();
  await open(page, "/settings/activity");
  await expect(page.getByRole("list", { name: "Activity" })).toContainText("Signed in with Google");
  await open(page, "/settings/account");
  await expect(page.getByRole("list", { name: "Sign-in methods" })).toContainText("ann@gmail.example");

  await page.getByRole("button", { name: "Sign out on this device" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(auth.requests).toContain("POST /auth/sign-out");
});

test("deleting the account asks for the confirmation phrase", async ({ page }) => {
  await open(page, "/settings/account");
  await page.getByRole("button", { name: "Delete account…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account?" });
  const confirm = dialog.getByRole("button", { name: "Delete forever" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type delete to confirm").fill("delete");
  await expect(confirm).toBeEnabled();
});
