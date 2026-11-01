import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, open, test, themes } from "./fixtures";

/** Adds a provider in Settings, so the agent starts and messages can be sent. */
async function withProvider(page: Page): Promise<void> {
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "AI providers" });
  await section.getByRole("button", { name: "Add a provider" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a provider" });
  await dialog.getByLabel("Preset").selectOption("openrouter");
  await dialog.getByLabel("API key").fill("sk-or-secret");
  await dialog.getByLabel("Model").fill("some/model");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

/** Adds a weight entry through the data screen; `when` is on this device's clock. */
async function weigh(page: Page, value: string, when: string, comment = ""): Promise<void> {
  await open(page, "/registers/body.weight");
  await page.getByRole("button", { name: "Add an entry" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Value/).fill(value);
  await dialog.getByLabel("Date and time").fill(when);
  if (comment) await dialog.getByLabel("Comment").fill(comment);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

async function startChat(page: Page, text: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New chat" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/);
}

function permission(page: Page) {
  return page.getByRole("dialog", { name: "Allow the agent to read your data?" });
}

function messages(page: Page) {
  return page.getByRole("region", { name: "Messages" });
}

async function axe(page: Page): Promise<string[]> {
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
  const results = await new AxeBuilder({ page }).withTags(tags).analyze();
  return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("an approved register read sends the days' entries and the log keeps the request", async ({ page, keys }) => {
  await weigh(page, "81", "2026-10-27T08:00");
  await weigh(page, "80.5", "2026-10-28T08:00", "after a run");
  await withProvider(page);
  keys.chats.replies.push({
    ask: { tool: "read_register", metric: "body.weight", scope_id: "", from: "2026-10-28", to: "2026-10-28" },
    reason: "To see how your weight changed",
    parts: ["You weigh ", "80.5 kg."],
  });
  await startChat(page, "How is my weight?");

  const dialog = permission(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("How is my weight?");
  await expect(dialog.getByRole("list", { name: "Data the agent asked for" })).toContainText("Weight");
  await expect(dialog.getByRole("list", { name: "Data the agent asked for" })).toContainText("Oct 28, 2026");
  await expect(dialog.getByRole("figure")).toContainText("To see how your weight changed");
  await expect(dialog).toContainText("openrouter.ai");
  await dialog.getByRole("button", { name: "Allow" }).click();
  await expect(dialog).toBeHidden();

  await expect(messages(page).getByText("You weigh 80.5 kg.")).toBeVisible();
  await expect(messages(page).getByRole("list", { name: "Data the agent asked for" })).toContainText(
    "Weight, Oct 28, 2026 · allowed",
  );
  // Only that day, decrypted here.
  const answer = keys.chats.answers[0];
  expect(answer?.decision).toBe("approve");
  const result = JSON.parse(answer?.result ?? "{}");
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({ value: 80.5, comment: "after a run" });
  expect(result.unit).toBe("kg");

  await page.goto("/settings");
  const log = page.getByRole("region", { name: "Agent access" });
  await expect(log.getByRole("list", { name: "Agent access" })).toContainText("Allowed");
  await log.getByRole("button", { name: "Reason" }).click();
  await expect(page.getByRole("dialog", { name: "Reason" })).toContainText("To see how your weight changed");
});

test("closing the dialog denies, and the reply says so", async ({ page, keys }) => {
  await withProvider(page);
  keys.chats.replies.push({ ask: { tool: "session_context" }, parts: ["I cannot tell the time."] });
  await startChat(page, "What time is it?");
  const dialog = permission(page);
  await expect(dialog.getByRole("list", { name: "Data the agent asked for" })).toContainText(
    "Time zone, country and language of this device",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(messages(page).getByText("I cannot tell the time.")).toBeVisible();
  await expect(messages(page).getByRole("list", { name: "Data the agent asked for" })).toContainText(
    "Time zone, country and language · denied",
  );
  expect(keys.chats.answers).toEqual([{ request_id: expect.any(String), decision: "deny" }]);
});

test("a request still waiting comes back after a reload", async ({ page, keys }) => {
  await withProvider(page);
  keys.chats.replies.push({ ask: { tool: "session_context" }, parts: ["Evening."] });
  await startChat(page, "Time?");
  await expect(permission(page)).toBeVisible();
  await page.reload();
  await expect(permission(page)).toBeVisible();
  await permission(page).getByRole("button", { name: "Allow" }).click();
  await expect(messages(page).getByText("Evening.")).toBeVisible();
  expect(keys.chats.answers.map((a) => a.decision)).toEqual(["approve"]);
});

test("a register this device does not know is refused without asking", async ({ page, keys }) => {
  await weigh(page, "81", "2026-10-27T08:00");
  await withProvider(page);
  keys.chats.replies.push({
    ask: { tool: "read_register", metric: "body.weight", scope_id: "0190d2c4-8b7e-7000-8000-0000000000ff" },
    parts: ["No data."],
  });
  await startChat(page, "Weight?");
  await expect(messages(page).getByText("No data.")).toBeVisible();
  await expect(permission(page)).toBeHidden();
  expect(keys.chats.answers.map((a) => a.decision)).toEqual(["refuse"]);
});

test("a request for a provider this device does not hold cannot be allowed", async ({ page, keys }) => {
  await withProvider(page);
  keys.chats.requestProvider = "0190d2c4-8b7e-7000-8000-0000000000ee";
  keys.chats.replies.push({ ask: { tool: "session_context" }, parts: ["Fine."] });
  await startChat(page, "Time?");
  const dialog = permission(page);
  await expect(dialog).toContainText("no longer in your settings");
  await expect(dialog.getByRole("button", { name: "Allow" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(messages(page).getByText("Fine.")).toBeVisible();
  expect(keys.chats.answers.map((a) => a.decision)).toEqual(["deny"]);
});

test("earlier messages are read without asking, and the reply and the log show it", async ({ page, keys }) => {
  await withProvider(page);
  await startChat(page, "Plan a trip to Rome");
  await expect(messages(page).getByText("You said: Plan a trip to Rome")).toBeVisible();
  keys.chats.replies.push({
    ask: { tool: "read_history", before: 2, count: 50 },
    reason: "To recall the plan",
    parts: ["We planned Rome."],
  });
  await page.getByRole("textbox", { name: "Message" }).fill("What did we plan?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(messages(page).getByText("We planned Rome.")).toBeVisible();
  await expect(permission(page)).toBeHidden();
  await expect(messages(page).getByRole("list", { name: "Data the agent asked for" })).toContainText(
    "Earlier messages of the chat: 2",
  );
  const answer = keys.chats.answers[0];
  expect(answer?.decision).toBe("answer");
  const result = JSON.parse(answer?.result ?? "{}");
  expect(result.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([
    ["user", "Plan a trip to Rome"],
    ["assistant", "You said: Plan a trip to Rome"],
  ]);
  expect(result.before).toBeUndefined();

  await page.goto("/settings");
  const log = page.getByRole("region", { name: "Agent access" });
  await expect(log.getByRole("list", { name: "Agent access" })).toContainText("Earlier messages of the chat, up to 50");
  await expect(log.getByRole("list", { name: "Agent access" })).toContainText("Read without asking");
});

for (const theme of themes) {
  test(`the permission dialog passes axe (${theme})`, async ({ page, keys }) => {
    await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
    await withProvider(page);
    keys.chats.replies.push({ ask: { tool: "session_context" }, parts: ["Fine."] });
    await startChat(page, "Time?");
    await expect(permission(page)).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
}

test("an entry the agent proposes shows what it adds and lands in the register on approval", async ({ page, keys }) => {
  await withProvider(page);
  keys.chats.replies.push({
    ask: { tool: "add_measurement", metric: "body.weight" },
    reason: JSON.stringify({ reason: "You told me your weight", value: 115, comment: "Morning" }),
    parts: ["Recorded."],
  });
  await startChat(page, "I weigh 115 kg");

  const dialog = page.getByRole("dialog", { name: "Add this entry to your data?" });
  await expect(dialog).toBeVisible();
  const entry = dialog.getByRole("list", { name: "Entry the agent proposes" });
  await expect(entry).toContainText("115");
  await expect(entry).toContainText("kg");
  await expect(entry).toContainText("Morning");
  await expect(dialog.getByRole("figure")).toContainText("You told me your weight");
  // It sends nothing out, so it names no host.
  await expect(dialog).not.toContainText("openrouter.ai");
  expect(await axe(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(messages(page).getByText("Recorded.")).toBeVisible();
  await expect(messages(page).getByRole("list", { name: "Data the agent asked for" })).toContainText(
    "Proposed entry: Weight · allowed",
  );
  const result = JSON.parse(keys.chats.answers[0]?.result ?? "{}");
  expect(result).toMatchObject({ recorded: true, metric: "body.weight", unit: "kg", value: 115 });

  await open(page, "/registers/body.weight");
  await expect(page.getByRole("list", { name: "Average of the day" })).toContainText("115 kg");
});

test("a denied entry stores nothing, and a value the metric does not allow asks no one", async ({ page, keys }) => {
  await withProvider(page);
  keys.chats.replies.push({
    ask: { tool: "add_measurement", metric: "body.weight" },
    reason: JSON.stringify({ reason: "You told me", value: 115 }),
    parts: ["Not recorded."],
  });
  await startChat(page, "I weigh 115 kg");
  const dialog = page.getByRole("dialog", { name: "Add this entry to your data?" });
  await dialog.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(messages(page).getByText("Not recorded.")).toBeVisible();
  expect(keys.chats.answers[0]?.decision).toBe("deny");

  keys.chats.replies.push({
    ask: { tool: "add_measurement", metric: "body.weight" },
    reason: JSON.stringify({ reason: "x", value: 99_999 }),
    parts: ["Refused."],
  });
  await page.getByRole("textbox", { name: "Message" }).fill("I weigh a lot");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(messages(page).getByText("Refused.")).toBeVisible();
  expect(keys.chats.answers[1]?.decision).toBe("refuse");

  await open(page, "/registers/body.weight");
  await expect(page.getByText("115")).toHaveCount(0);
});
