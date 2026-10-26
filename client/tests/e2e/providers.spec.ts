import { expect, FakeAuth, open, test, unlock } from "./fixtures";

test("adding a provider stores it encrypted and starts the agent with it", async ({ page, keys }) => {
  await open(page, "/settings");
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
  await open(page, "/settings");
  const otherContext = await browser.newContext({ baseURL: "http://localhost:4173" });
  const other = await otherContext.newPage();
  await new FakeAuth(true).install(other);
  await keys.install(other);
  await unlock(other, words);
  await open(other, "/settings");

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
});
