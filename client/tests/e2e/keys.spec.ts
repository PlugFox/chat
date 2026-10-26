import AxeBuilder from "@axe-core/playwright";
import type { CDPSession, Page } from "@playwright/test";
import { USER_ID } from "./fake-keys";
import { expect, FakeAuth, open, test, themes, unlock } from "./fixtures";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => v.id);
}

/** A platform passkey with PRF that approves every prompt (Chromium's virtual authenticator). */
async function virtualPasskey(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

/** Reads the words off the setup screen, then types back the ones asked for. */
async function confirmWords(page: Page): Promise<string[]> {
  const words = await page.getByRole("list", { name: "Recovery key" }).getByRole("listitem").allTextContents();
  expect(words).toHaveLength(12);
  await page.getByRole("button", { name: "I wrote them down" }).click();
  for (const field of await page.getByLabel(/^Word \d+$/).all()) {
    const label = await field.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? "");
    await field.fill(words[Number(label.replace("Word ", "")) - 1] ?? "");
  }
  return words;
}

test.describe("first setup", () => {
  test.use({ vault: "new" });

  test("with the recovery key only, then unlock in a new tab", async ({ page, keys }) => {
    await open(page, "/");
    await expect(page.locator("h1")).toHaveText("Set up your keys");
    await page.getByRole("button", { name: "Set up" }).click();
    await page.getByRole("button", { name: "Skip, use the recovery key only" }).click();
    const words = await page.getByRole("list", { name: "Recovery key" }).getByRole("listitem").allTextContents();
    await page.getByRole("button", { name: "I wrote them down" }).click();
    // A wrong word is caught before anything is uploaded.
    for (const field of await page.getByLabel(/^Word \d+$/).all()) await field.fill("abandon");
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect(page.getByRole("alert")).toContainText("Some words do not match");
    expect(keys.requests).not.toContain("keys.setup");

    await page.getByRole("button", { name: "Show the words again" }).click();
    await confirmWords(page);
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect(page.locator("h1")).toHaveText("Chats");
    expect(keys.account?.wraps).toHaveLength(1);
    expect(keys.account?.scopes).toHaveLength(5);

    // Every tab unlocks on its own (D-019).
    await open(page, "/");
    await expect(page.locator("h1")).toHaveText("Unlock");
    await expect(page.getByRole("button", { name: "Unlock with a passkey" })).toBeHidden();
    const field = page.getByRole("textbox", { name: "Recovery key" });
    // Completion offers list words for the one being typed and keeps the focus in the field.
    await field.fill("abando");
    const suggestions = page.getByRole("list", { name: "Matching words" });
    await suggestions.getByRole("button", { name: "abandon" }).click();
    await expect(field).toHaveValue("abandon ");
    await expect(field).toBeFocused();
    await expect(suggestions).toBeHidden();
    await field.fill(words.slice().reverse().join(" "));
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await field.fill(words.join("  ").toUpperCase());
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.locator("h1")).toHaveText("Chats");
  });

  test("with a passkey, then unlock with it", async ({ page, keys }) => {
    await virtualPasskey(page);
    await open(page, "/");
    await page.getByRole("button", { name: "Set up" }).click();
    await page.getByRole("button", { name: "Create a passkey" }).click();
    await expect(page.getByText("Passkey added.")).toBeVisible();
    await confirmWords(page);
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect(page.locator("h1")).toHaveText("Chats");
    expect(keys.account?.wraps.map((w) => w.wrap[1])).toEqual([2, 1]);

    await open(page, "/");
    await page.getByRole("button", { name: "Unlock with a passkey" }).click();
    await expect(page.locator("h1")).toHaveText("Chats");
  });

  test("warns when the server forgets keys this browser has seen", async ({ page }) => {
    await page.addInitScript((user) => localStorage.setItem(`chat.keys.${user}`, "1"), USER_ID);
    await open(page, "/");
    await expect(page.getByRole("status")).toContainText("this browser unlocked it before");
  });

  for (const theme of themes) {
    test(`axe: setup steps in ${theme}`, async ({ page }) => {
      await open(page, "/", theme);
      expect(await axe(page)).toEqual([]);
      await page.getByRole("button", { name: "Set up" }).click();
      await page.getByRole("button", { name: "Skip, use the recovery key only" }).click();
      expect(await axe(page)).toEqual([]);
      await page.getByRole("button", { name: "I wrote them down" }).click();
      expect(await axe(page)).toEqual([]);
    });
  }
});

test.describe("locked", () => {
  test.use({ vault: "locked" });

  test("settings stay usable and say what needs unlocking", async ({ page }) => {
    await open(page, "/settings");
    await expect(page.getByText("Unlock to manage your passkeys and recovery key.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out on this device" })).toBeVisible();
  });

  test("a remembered device unlocks by itself until it is forgotten", async ({ page, words, keys }) => {
    await unlock(page, words);
    expect(keys.account?.wraps.map((w) => w.wrap[1])).toEqual([2, 4]);
    await open(page, "/notes");
    await expect(page.locator("h1")).toHaveText("Notebook");

    await open(page, "/settings");
    await page.getByRole("checkbox", { name: "Remember this device" }).uncheck();
    await expect.poll(() => keys.account?.wraps.length).toBe(1);
    await open(page, "/");
    await expect(page.locator("h1")).toHaveText("Unlock");
  });

  test("a device wrap gone from the server means unlocking again", async ({ page, words, keys }) => {
    await unlock(page, words);
    if (keys.account) keys.account.wraps = keys.account.wraps.filter((w) => w.wrap[1] !== 4);
    await open(page, "/");
    await expect(page.locator("h1")).toHaveText("Unlock");
  });

  for (const theme of themes) {
    test(`axe: unlock in ${theme}`, async ({ page }) => {
      await open(page, "/", theme);
      await expect(page.locator("h1")).toHaveText("Unlock");
      expect(await axe(page)).toEqual([]);
    });
  }
});

test("settings: add and remove a passkey, replace the recovery key", async ({ page, keys }) => {
  await virtualPasskey(page);
  await open(page, "/settings");
  const methods = page.getByRole("list", { name: "Unlock methods" });
  const rows = methods.locator(":scope > li");
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("checkbox", { name: "Remember this device" })).toBeChecked();

  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(rows.filter({ hasText: "Passkey" })).toHaveCount(1);
  await methods.getByRole("button", { name: /Remove the passkey/ }).click();
  await expect(rows.filter({ hasText: "Passkey" })).toHaveCount(0);

  const old = keys.account?.wraps.find((w) => w.wrap[1] === 2)?.wrap;
  await page.getByRole("button", { name: "Replace…" }).click();
  const dialog = page.getByRole("dialog", { name: "Replace the recovery key" });
  await dialog.getByRole("button", { name: "Show new words" }).click();
  expect(await axe(page)).toEqual([]);
  await confirmWords(page);
  await dialog.getByRole("button", { name: "Replace the recovery key" }).click();
  await expect(dialog.getByRole("status")).toContainText("The old words no longer work");
  expect(keys.account?.wraps.find((w) => w.wrap[1] === 2)?.wrap).not.toEqual(old);
  await expect(page.getByRole("list", { name: "Activity" })).toBeVisible();
});

test.describe("linking", () => {
  test.use({ vault: "locked" });

  test("an unlocked phone unlocks a new device from its QR code", async ({ page, browser, keys, words }) => {
    // The phone: another browser, signed in to the same account and unlocked.
    const phoneContext = await browser.newContext({ baseURL: "http://localhost:4173" });
    const phone = await phoneContext.newPage();
    await new FakeAuth(true).install(phone);
    await keys.install(phone);

    await open(page, "/");
    await page.getByRole("checkbox", { name: "Remember this device" }).check();
    await page.getByRole("button", { name: "Show a code" }).click();
    await expect(page.getByRole("img", { name: "Code to scan with your phone" })).toBeVisible();
    const url = await page.evaluate(() => (window as unknown as { scannedQr: string }).scannedQr);
    expect(url).toMatch(/^http:\/\/localhost:4173\/link#1\./);

    // The camera opens the link in a new tab; the secret leaves the address bar at
    // once and waits in memory while that tab is unlocked (D-019).
    await phone.goto(url);
    expect(new URL(phone.url()).hash).toBe("");
    await expect(phone.locator("h1")).toHaveText("Unlock");
    await phone.getByRole("textbox", { name: "Recovery key" }).fill(words);
    await phone.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(phone.locator("h1")).toHaveText("Unlock another device");
    await expect(phone.getByRole("listitem").filter({ hasText: "Firefox on Windows" })).toBeVisible();
    expect(await axe(phone)).toEqual([]);
    await phone.getByRole("button", { name: "Unlock that device" }).click();
    await expect(phone.getByRole("status")).toContainText("The other device is unlocked");

    await expect(page.locator("h1")).toHaveText("Chats");
    // "Remember this device" applied to the linked unlock too.
    expect(keys.account?.wraps.map((w) => w.wrap[1])).toEqual([2, 4]);

    // The page holds nothing to send again after a reload.
    await phone.reload();
    await phone.getByRole("textbox", { name: "Recovery key" }).fill(words);
    await phone.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(phone.getByRole("alert")).toContainText("no longer valid");
    await phoneContext.close();
  });

  test("a phone that is not signed in is told to sign in and scan again", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: "http://localhost:4173" });
    const phone = await context.newPage();
    await new FakeAuth(false).install(phone);
    await phone.goto(`/link#1.${"A".repeat(22)}.${"A".repeat(43)}.${"A".repeat(43)}`);
    await expect(phone.locator("h1")).toHaveText("Sign in on this phone first");
    expect(new URL(phone.url()).hash).toBe("");
    expect(await axe(phone)).toEqual([]);
    await context.close();
  });

  for (const theme of themes) {
    test(`axe: the code on the unlock screen in ${theme}`, async ({ page }) => {
      await open(page, "/", theme);
      await page.getByRole("button", { name: "Show a code" }).click();
      await expect(page.getByRole("img", { name: "Code to scan with your phone" })).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });
  }
});
