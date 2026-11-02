import { expect, isPhone, open, test } from "./fixtures";

test("the current page is marked and headings take focus after navigation", async ({ page }) => {
  await open(page, "/");
  if (isPhone(page)) await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Notebook" }).click();
  await expect(page.locator("h1")).toHaveText("Notebook");
  await expect(page.getByRole("link", { name: "Notebook" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("h1")).toBeFocused();
});

test("phone: the drawer opens, traps nothing behind it and closes with Esc", async ({ page }) => {
  test.skip(!isPhone(page), "phone layout only");
  await open(page, "/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Chats" })).toBeHidden();
  const menu = page.getByRole("button", { name: "Open navigation" });
  await menu.click();
  await expect(nav.getByRole("link", { name: "Chats" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(nav.getByRole("link", { name: "Chats" })).toBeHidden();
  await expect(menu).toBeFocused();
});

test("desktop: the sidebar is always there", async ({ page }) => {
  test.skip(isPhone(page), "desktop layout only");
  await open(page, "/");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" })).toBeVisible();
});

test("the skip link moves focus to the content", async ({ page }) => {
  await open(page, "/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

test("no horizontal scroll at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of ["/", "/settings", "/ui-kit"]) {
    await open(page, path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test("the site can be installed: a manifest with icons of the sizes browsers ask for", async ({ page }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  const response = await page.request.get(href ?? "");
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({ name: "Vault Chat", display: "standalone", start_url: "/" });
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBe(true);
});

test("settings: each section has its address, and the list leads to it", async ({ page }) => {
  await open(page, "/settings");
  await page.getByRole("link", { name: /^Activity/ }).click();
  await expect(page).toHaveURL(/\/settings\/activity$/);
  await expect(page.getByRole("list", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Sign-in methods" })).toHaveCount(0);
});

test("a dialog closes on its barrier, unless it holds work; its focus ring is not clipped", async ({ page }) => {
  await open(page, "/settings/account");
  await page.getByRole("button", { name: "Delete account…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account?" });
  const field = dialog.getByRole("textbox");
  await field.focus();
  const room = await field.evaluate((input) => {
    const scroller = input.closest("div[class*='body']") as Element;
    const inner = input.getBoundingClientRect();
    const outer = scroller.getBoundingClientRect();
    return Math.min(
      inner.left - outer.left,
      outer.right - inner.right,
      inner.top - outer.top,
      outer.bottom - inner.bottom,
    );
  });
  expect(room).toBeGreaterThanOrEqual(5);

  const box = await dialog.boundingBox();
  await dialog.click({ position: { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) - 8 } });
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, (page.viewportSize()?.height ?? 0) - 2);
  await expect(dialog).toBeHidden();
});

test("phone: a section leads with its back button alone, the list with the menu", async ({ page }) => {
  test.skip(!isPhone(page), "phone layout only");
  const menu = page.getByRole("button", { name: "Open navigation" });
  await open(page, "/settings/devices");
  await expect(menu).toBeHidden();
  await page.getByRole("button", { name: "Back to settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(menu).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to settings" })).toHaveCount(0);
});

test("narrowing a large screen folds the sidebar to icons first", async ({ page }) => {
  test.skip(isPhone(page));
  await open(page, "/notes");
  const link = page.getByRole("navigation").getByRole("link", { name: "Notebook" });
  await page.setViewportSize({ width: 1440, height: 800 });
  expect((await link.boundingBox())?.width).toBeGreaterThan(200);
  for (const width of [1400, 900]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await link.boundingBox();
    expect(box?.width).toBeLessThan(60);
    expect(box?.width).toBeGreaterThanOrEqual(47.5);
  }
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
});
