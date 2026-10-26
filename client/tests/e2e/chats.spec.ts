import type { Page } from "@playwright/test";
import { expect, isPhone, open, test } from "./fixtures";

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

/** Starts a chat from the list with its first message; resolves when the reply is complete. */
async function startChat(page: Page, text: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page).toHaveURL(/\/chats\/new$/);
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/);
}

function messages(page: Page) {
  return page.getByRole("region", { name: "Messages" });
}

test("a first message creates the chat and the reply streams in", async ({ page, keys }) => {
  await withProvider(page);
  await startChat(page, "Plan a trip\nto the sea");
  await expect(messages(page).getByText("Plan a trip")).toBeVisible();
  await expect(messages(page).getByText("You said: Plan a trip")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plan a trip" })).toBeVisible();

  // The server got the text to seal; the title came sealed by the client.
  const [chat] = [...keys.chats.chats.values()];
  expect(Buffer.from(chat?.info.title ?? []).includes("Plan a trip")).toBe(false);

  // A second message carries the first exchange as context.
  await page.getByRole("textbox", { name: "Message" }).fill("And back");
  // Enter sends once the reply is finished.
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(messages(page).getByText("You said: And back")).toBeVisible();
  expect(keys.chats.turns.at(-1)?.context.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

  if (isPhone(page)) await page.getByRole("button", { name: "Back to chats" }).click();
  await expect(page.getByRole("list", { name: "Recent" }).getByRole("link", { name: /Plan a trip/ })).toBeVisible();
});

test("a failed reply shows its error in place and a retry runs it again", async ({ page, keys }) => {
  await withProvider(page);
  keys.chats.replies.push({ error: "provider.refused" });
  await startChat(page, "Hi");
  await expect(messages(page).getByText("The provider refused the request.")).toBeVisible();
  await messages(page).getByRole("button", { name: "Try again" }).click();
  await expect(messages(page).getByText("You said: Hi")).toBeVisible();
  await expect(messages(page).getByText("The provider refused the request.")).toBeHidden();
  expect(keys.chats.turns.at(-1)?.text).toBe("Hi");
});

test("a reply can be stopped", async ({ page, keys }) => {
  await withProvider(page);
  keys.chats.replies.push({ hold: true, parts: ["Thinking"] });
  await startChat(page, "Go");
  await expect(messages(page).getByText(/^Thinking/)).toBeVisible();
  await page.getByRole("button", { name: "Stop the reply" }).click();
  await expect(messages(page).getByText(/Stopped/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("chats are pinned, archived and deleted from their actions", async ({ page }) => {
  await withProvider(page);
  await startChat(page, "First");
  await expect(messages(page).getByText("You said: First")).toBeVisible();
  await startChat(page, "Second");
  await expect(messages(page).getByText("You said: Second")).toBeVisible();
  await page.goto("/");

  await page.getByRole("button", { name: "Actions for First" }).click();
  await page.getByRole("dialog", { name: "First" }).getByRole("button", { name: "Pin" }).click();
  const pinned = page.getByRole("list", { name: "Pinned" });
  await expect(pinned.getByRole("link", { name: /First/ })).toBeVisible();
  await page.getByRole("button", { name: "Actions for Second" }).click();
  await page.getByRole("dialog", { name: "Second" }).getByRole("button", { name: "Pin" }).click();
  await expect(pinned.getByRole("link")).toHaveText([/Second/, /First/]);

  // The handle moves a pinned chat with the keyboard.
  await pinned.getByRole("button", { name: "Move Second" }).press("ArrowDown");
  await expect(pinned.getByRole("link")).toHaveText([/First/, /Second/]);

  await page.getByRole("button", { name: "Actions for First" }).click();
  await page.getByRole("dialog", { name: "First" }).getByRole("button", { name: "Archive" }).click();
  await expect(pinned.getByRole("link")).toHaveText([/Second/]);
  await page.getByRole("button", { name: "Open the archive" }).click();
  await page.getByRole("button", { name: "Actions for First" }).click();
  await page.getByRole("dialog", { name: "First" }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete this chat?" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("The archive is empty.")).toBeVisible();
});

test("the user's message is edited and a reply deleted", async ({ page, keys }) => {
  await withProvider(page);
  await startChat(page, "Draft");
  await expect(messages(page).getByText("You said: Draft")).toBeVisible();

  await messages(page).getByRole("button", { name: "Message actions" }).first().click();
  await page.getByRole("dialog", { name: "Message actions" }).getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit message" });
  await edit.getByLabel("Message").fill("Final");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(messages(page).getByText("Final", { exact: true })).toBeVisible();
  await expect(messages(page).getByText(/Edited/)).toBeVisible();
  // The edit is sealed by the client, not sent in the clear.
  const [chat] = [...keys.chats.chats.values()];
  expect(Buffer.from(chat?.messages.get(0)?.record ?? []).includes("Final")).toBe(false);

  await messages(page).getByRole("button", { name: "Message actions" }).last().click();
  await page.getByRole("dialog", { name: "Message actions" }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete this message?" }).getByRole("button", { name: "Delete" }).click();
  await expect(messages(page).getByText("Deleted")).toBeVisible();
});

test("a message the server refuses is a toast and adds nothing", async ({ page, keys }) => {
  await withProvider(page);
  await startChat(page, "Hi");
  await expect(messages(page).getByText("You said: Hi")).toBeVisible();
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("x".repeat(200 * 1024 + 1));
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The message is too long." })).toBeVisible();
  // The text stays to be shortened; the chat has only the first exchange.
  await expect(box).not.toHaveValue("");
  expect([...keys.chats.chats.values()][0]?.messages.size).toBe(2);
});

test("an open chat survives a reconnect", async ({ page, keys }) => {
  await withProvider(page);
  await startChat(page, "Still here");
  await expect(messages(page).getByText("You said: Still here")).toBeVisible();
  const fetches = keys.requests.filter((r) => r === "message.chunks").length;
  keys.dropSockets();
  // The chunks are fetched again over the new socket, and the chat stays.
  await expect.poll(() => keys.requests.filter((r) => r === "message.chunks").length).toBeGreaterThan(fetches);
  await expect(messages(page).getByText("You said: Still here")).toBeVisible();
  await expect(page.getByText("This chat does not exist or was deleted.")).toBeHidden();
  await expect(messages(page).getByText("The reply was interrupted.")).toBeHidden();
});

test("a chat past the first page of the list opens by its link and survives a reconnect", async ({ page, keys }) => {
  await withProvider(page);
  await startChat(page, "Older");
  await expect(messages(page).getByText("You said: Older")).toBeVisible();
  const older = page.url();
  await startChat(page, "Newer");
  await expect(messages(page).getByText("You said: Newer")).toBeVisible();
  keys.chats.pageSize = 1;
  await page.goto(older);
  await expect(messages(page).getByText("You said: Older")).toBeVisible();
  const lists = keys.requests.filter((r) => r === "chat.list").length;
  keys.dropSockets();
  await expect.poll(() => keys.requests.filter((r) => r === "chat.list").length).toBeGreaterThan(lists + 1);
  await page.waitForTimeout(500);
  await expect(page.getByText("This chat does not exist or was deleted.")).toBeHidden();
  await expect(messages(page).getByText("You said: Older")).toBeVisible();
});
