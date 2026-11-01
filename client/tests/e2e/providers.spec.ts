import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, FakeAuth, open, test, themes, unlock } from "./fixtures";

async function addOpenRouter(page: Page): Promise<void> {
  const section = page.getByRole("region", { name: "AI providers" });
  await section.getByRole("button", { name: "Add a provider" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a provider" });
  await dialog.getByLabel("Preset").selectOption("openrouter");
  await dialog.getByLabel("API key").fill("sk-or-secret");
  await dialog.getByLabel("Model").fill("some/model");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

async function axe(page: Page): Promise<string[]> {
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
  const results = await new AxeBuilder({ page }).withTags(tags).analyze();
  return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("adding a provider stores it encrypted and starts the agent with it", async ({ page, keys }) => {
  await open(page, "/settings/providers");
  const section = page.getByRole("region", { name: "AI providers" });
  await expect(section.getByText("No providers yet")).toBeVisible();

  await section.getByRole("button", { name: "Add a provider" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a provider" });
  await dialog.getByLabel("Preset").selectOption("openrouter");
  await expect(dialog.getByLabel("Base URL")).toHaveValue("https://openrouter.ai/api/v1");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Required.")).toBeVisible();
  await dialog.getByLabel("API key").fill("sk-or-secret");
  await dialog.getByLabel("Model").fill("some/model");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const list = section.getByRole("list", { name: "Providers" });
  await expect(list.getByRole("button", { name: /^Edit / })).toHaveCount(1);
  await expect(list).toContainText("OpenRouter");
  await expect(list).toContainText("In use");
  await expect
    .poll(() => keys.agentStarts.at(-1))
    .toEqual({
      kind: "openai_compatible",
      base_url: "https://openrouter.ai/api/v1",
      api_key: "sk-or-secret",
      model: "some/model",
    });
  // The server holds a sealed record, never the key in the clear.
  const stored = keys.settings.get("providers");
  expect(stored?.rev).toBe(1);
  expect(Buffer.from(stored?.record ?? []).includes("sk-or-secret")).toBe(false);

  // A new page opens the record with the real worker and starts again.
  const starts = keys.agentStarts.length;
  await page.reload();
  await expect(list).toContainText("OpenRouter");
  await expect.poll(() => keys.agentStarts.length).toBe(starts + 1);
});

test("a change on another device reaches this one", async ({ page, keys, browser, words }) => {
  await open(page, "/settings/providers");
  const otherContext = await browser.newContext({ baseURL: "http://localhost:4173" });
  const other = await otherContext.newPage();
  await new FakeAuth(true).install(other);
  await keys.install(other);
  await unlock(other, words);
  await open(other, "/settings/providers");

  const section = page.getByRole("region", { name: "AI providers" });
  await section.getByRole("button", { name: "Add a provider" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a provider" });
  await dialog.getByLabel("Preset").selectOption("anthropic");
  await dialog.getByLabel("API key").fill("sk-ant");
  await dialog.getByLabel("Model").fill("a-model");
  await dialog.getByRole("button", { name: "Save" }).click();

  const theirs = other.getByRole("region", { name: "AI providers" }).getByRole("list", { name: "Providers" });
  await expect(theirs).toContainText("Anthropic");
  await other.getByRole("button", { name: "Remove Anthropic" }).click();
  await other.getByRole("dialog", { name: "Remove Anthropic?" }).getByRole("button", { name: "Remove" }).click();
  await expect(section.getByText("No providers yet")).toBeVisible();
  expect(keys.settings.get("providers")?.rev).toBe(2);
  // Both pages drop their agent session: no provider is active any more.
  await expect.poll(() => keys.requests.filter((r) => r === "agent.stop").length).toBe(2);
  // The removing page retires the config on every device.
  await expect.poll(() => keys.requests.filter((r) => r === "agent.retire").length).toBe(1);
});

test("a reconnect resumes the agent session instead of stopping it", async ({ page, keys }) => {
  await open(page, "/settings/providers");
  const section = page.getByRole("region", { name: "AI providers" });
  await section.getByRole("button", { name: "Add a provider" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a provider" });
  await dialog.getByLabel("API key").fill("sk-secret");
  await dialog.getByLabel("Model").fill("a-model");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => keys.agentStarts.length).toBe(1);

  const count = (type: string) => keys.requests.filter((r) => r === type).length;
  const loads = count("settings.get");
  keys.dropSockets();
  // Every connect reads the setting again.
  await expect.poll(() => count("settings.get"), { timeout: 15_000 }).toBeGreaterThan(loads);
  await page.waitForTimeout(300);
  expect(count("agent.stop")).toBe(0);
  expect(keys.agentStarts).toHaveLength(1);
});

test.describe("sharing", () => {
  test("a provider shared by QR without its key is added on another device", async ({ page, keys, browser, words }) => {
    await open(page, "/settings/providers");
    await addOpenRouter(page);
    await page.getByRole("button", { name: "Share OpenRouter" }).click();
    const share = page.getByRole("dialog", { name: "Share OpenRouter" });
    await expect(share.getByText("hold the API key in the clear")).toBeVisible();
    await share.getByRole("checkbox", { name: "Include the API key" }).uncheck();
    await expect(share.getByText("without the API key")).toBeVisible();
    await share.getByRole("button", { name: "Show the QR code" }).click();
    await expect(share.getByRole("img", { name: "Code with the provider's settings" })).toBeVisible();
    const url = await page.evaluate(() => (window as unknown as { scannedQr: string }).scannedQr);
    expect(url).toMatch(/^http:\/\/localhost:4173\/provider#1\./);
    expect(Buffer.from(url.split(".")[1] ?? "", "base64url").includes("sk-or-secret")).toBe(false);

    const otherContext = await browser.newContext({ baseURL: "http://localhost:4173" });
    const other = await otherContext.newPage();
    await new FakeAuth(true).install(other);
    await keys.install(other);
    await unlock(other, words);
    // The camera opens the link; the config leaves the address bar at once.
    await other.goto(url);
    expect(new URL(other.url()).hash).toBe("");
    await expect(other.locator("h1")).toHaveText("Add a shared provider");
    const item = other.getByRole("list", { name: "Add a shared provider" });
    await expect(item).toContainText("openrouter.ai · some/model");
    await expect(item).toContainText("Without an API key");
    await expect(other.getByText("sends its messages to openrouter.ai")).toBeVisible();
    await other.getByRole("button", { name: "Add the provider" }).click();
    await expect(other.getByRole("status")).toContainText("OpenRouter is added. Choose it in settings");

    const list = page.getByRole("region", { name: "AI providers" }).getByRole("list", { name: "Providers" });
    await expect(list.getByRole("button", { name: /^Edit / })).toHaveCount(2);
    // The added one is not the one turns use.
    await expect(list.getByText("In use")).toHaveCount(1);
    await otherContext.close();
  });

  test("a copied link fills the add form, and one already added is not added again", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, "/settings/providers");
    await addOpenRouter(page);
    await page.getByRole("button", { name: "Share OpenRouter" }).click();
    await page.getByRole("dialog", { name: "Share OpenRouter" }).getByRole("button", { name: "Copy the link" }).click();
    await expect(page.getByText("Link copied.")).toBeVisible();
    // Made when asked for: no QR was shown, so the test build's encoder never saw it.
    expect(await page.evaluate(() => (window as unknown as { scannedQr?: string }).scannedQr)).toBeUndefined();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toMatch(/^http:\/\/localhost:4173\/provider#1\./);
    await page.getByRole("dialog", { name: "Share OpenRouter" }).getByRole("button", { name: "Close" }).last().click();

    await page.getByRole("button", { name: "Add a provider" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a provider" });
    const link = dialog.getByLabel("Shared link");
    await link.fill("https://elsewhere.example/provider#1.broken");
    await expect(dialog.getByText("This is not a provider link")).toBeVisible();
    await link.fill(url.replace("http://localhost:4173", "https://elsewhere.example"));
    await expect(link).toHaveValue("");
    await expect(dialog.getByText("Filled in from the link")).toBeVisible();
    await expect(dialog.getByLabel("Name")).toHaveValue("OpenRouter");
    await expect(dialog.getByLabel("Base URL")).toHaveValue("https://openrouter.ai/api/v1");
    await expect(dialog.getByLabel("API key")).toHaveValue("sk-or-secret");
    await expect(dialog.getByLabel("Model")).toHaveValue("some/model");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.goto(url);
    await expect(page.getByText("You already have this provider as OpenRouter.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add the provider" })).toHaveCount(0);
  });

  test("a damaged link says so", async ({ page }) => {
    await page.goto("/provider#1.AAAA");
    expect(new URL(page.url()).hash).toBe("");
    await expect(page.getByRole("alert")).toContainText("This link is damaged");
  });

  test("a device that is not signed in is told to sign in and open it again", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: "http://localhost:4173" });
    const phone = await context.newPage();
    await new FakeAuth(false).install(phone);
    await phone.goto("/provider#1.AAAA");
    await expect(phone.locator("h1")).toHaveText("Sign in first");
    expect(new URL(phone.url()).hash).toBe("");
    expect(await axe(phone)).toEqual([]);
    await context.close();
  });

  for (const theme of themes) {
    test(`axe: the share dialog and the page that adds a shared provider in ${theme}`, async ({ page }) => {
      await open(page, "/settings/providers", theme);
      await addOpenRouter(page);
      await page.getByRole("button", { name: "Share OpenRouter" }).click();
      const share = page.getByRole("dialog", { name: "Share OpenRouter" });
      await share.getByRole("checkbox", { name: "Include the API key" }).uncheck();
      await share.getByRole("button", { name: "Show the QR code" }).click();
      await expect(share.getByRole("img")).toBeVisible();
      expect(await axe(page)).toEqual([]);
      const url = await page.evaluate(() => (window as unknown as { scannedQr: string }).scannedQr);
      await page.goto(url);
      await expect(page.getByRole("button", { name: "Add the provider" })).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });
  }
});
