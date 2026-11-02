import type { Page } from "@playwright/test";
import { expect, isPhone, open, test } from "./fixtures";

/** Adds a provider in Settings, so the agent starts and messages can be sent. */
async function withProvider(page: Page): Promise<void> {
  await open(page, "/settings/providers");
  const section = page.getByRole("region", { name: "AI providers" });
  await section.getByRole("button", { name: "Add a provider" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a provider" });
  await dialog.getByLabel("Preset").selectOption("openrouter");
  await dialog.getByLabel("API key").fill("sk-or-secret");
  await dialog.getByLabel("Model").fill("some/model");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

/** The list, from an open chat on a phone: through the menu. */
async function backToChats(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Chats" }).click();
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

  if (isPhone(page)) await backToChats(page);
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

test("a reply shows as a document while it streams and once stored, and its table copies as CSV", async ({
  page,
  context,
  keys,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await withProvider(page);
  keys.chats.replies.push({
    hold: true,
    parts: [
      "## Beaches\n\n",
      "| Beach | Km |\n|-|-:|\n| Pine, Bay | 30 |\n\n",
      "<b>raw</b> [site](javascript:alert(1)) [guide](https://example.org)\n\n",
    ],
  });
  await startChat(page, "Beaches?");
  const list = messages(page);
  const check = async () => {
    await expect(list.getByRole("heading", { name: "Beaches" })).toBeVisible();
    await expect(list.getByRole("cell", { name: "Pine, Bay" })).toBeVisible();
    // HTML stays text, and only a safe address makes a link.
    await expect(list.getByText("<b>raw</b>")).toBeVisible();
    await expect(list.getByRole("link", { name: "site" })).toHaveCount(0);
    await expect(list.getByRole("link", { name: "guide" })).toHaveAttribute("href", "https://example.org");
  };
  // The preview, converted while the reply streams.
  await check();
  await page.getByRole("button", { name: "Stop the reply" }).click();
  await expect(list.getByText(/Stopped/)).toBeVisible();
  // The document the last record holds.
  await check();

  await list.getByRole("button", { name: "Copy table as CSV" }).click();
  await expect(page.getByText("Table copied as CSV")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Beach,Km\r\n"Pine, Bay",30');
});

test("a chart in a reply draws once its block is whole, and shows as a table", async ({ page, context, keys }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await withProvider(page);
  keys.chats.replies.push({
    hold: true,
    parts: [
      '```chart\n{"kind":"bar","title":"Steps","x":"Day","labels":["Mon","Tue"],',
      '"series":[{"name":"Ann","values":[1500,null]},{"name":"Bo","values":[900,1200]}]}\n```\n',
    ],
  });
  await startChat(page, "Steps?");
  const list = messages(page);
  const chart = list.getByRole("img", { name: "Steps" });
  await expect(chart).toBeVisible();
  // Drawn: the canvas has pixels that are not the surface.
  await expect
    .poll(() =>
      chart.evaluate((canvas: HTMLCanvasElement) => {
        const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
        return data.some((v, i) => i % 4 === 3 && v > 0);
      }),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Stop the reply" }).click();
  await expect(list.getByText(/Stopped/)).toBeVisible();
  await expect(chart).toBeVisible();

  await list.getByRole("button", { name: "Show as a table" }).click();
  await expect(chart).toHaveCount(0);
  await expect(list.getByRole("cell", { name: "1,500" })).toBeVisible();
  await list.getByRole("button", { name: "Copy table as CSV" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Day,Ann,Bo\r\nMon,1500,900\r\nTue,,1200");
  await list.getByRole("button", { name: "Show as a chart" }).click();
  await expect(chart).toBeVisible();
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

test("a saved reply shows in Saved messages and opens its chat at it", async ({ page, keys }) => {
  await withProvider(page);
  await startChat(page, "Plan");
  const list = messages(page);
  await expect(list.getByText("You said: Plan")).toBeVisible();
  const actions = page.getByRole("dialog", { name: "Message actions" });

  await list.getByRole("button", { name: "Message actions" }).last().click();
  await actions.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Message saved")).toBeVisible();
  await expect(list.getByRole("img", { name: "Saved" })).toHaveCount(1);
  const [chat] = [...keys.chats.chats.values()];
  expect([...keys.chats.saved.values()].map((s) => s.message_id)).toEqual([1]);

  await page.goto("/saved");
  const saved = page.getByRole("main");
  await expect(saved.getByText("You said: Plan")).toBeVisible();
  await expect(saved.getByText(/Plan · /)).toBeVisible();
  await saved.getByRole("link", { name: "Open in chat" }).click();
  await expect(page).toHaveURL(new RegExp(`/chats/${chat?.info.chat_id}\\?message=1$`));
  await expect(list.locator("article[data-target]")).toContainText("You said: Plan");

  // Removed from the saved page, the mark leaves the chat too.
  await page.goto("/saved");
  await saved.getByRole("button", { name: "Remove from saved" }).click();
  await expect(saved.getByText("Messages you save appear here.")).toBeVisible();

  // A deleted message leaves the saved ones.
  await page.goBack();
  await expect(list.getByRole("img", { name: "Saved" })).toHaveCount(0);
  await list.getByRole("button", { name: "Message actions" }).last().click();
  await actions.getByRole("button", { name: "Save" }).click();
  await list.getByRole("button", { name: "Message actions" }).last().click();
  await expect(actions.getByRole("button", { name: "Remove from saved" })).toBeVisible();
  await actions.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete this message?" }).getByRole("button", { name: "Delete" }).click();
  await expect(list.getByText("Deleted")).toBeVisible();
  expect(keys.chats.saved.size).toBe(0);
  await page.goto("/saved");
  await expect(saved.getByText("Messages you save appear here.")).toBeVisible();
});

test("a saved message far up a long chat opens in view", async ({ page, keys }) => {
  await withProvider(page);
  await startChat(page, "Start");
  await expect(messages(page).getByText("You said: Start")).toBeVisible();
  const [chat] = [...keys.chats.chats.values()];
  const chatId = chat?.info.chat_id ?? "";
  // Three chunks of history after the saved reply, which the end of the chat does not load.
  keys.chats.fill(
    chatId,
    Array.from({ length: 200 }, (_, i) => `Filler ${i}`),
  );
  keys.chats.saved.set(`${chatId}/1`, { chat_id: chatId, message_id: 1, saved_at: 1 });

  await page.goto("/saved");
  await page.getByRole("main").getByRole("link", { name: "Open in chat" }).click();
  const target = messages(page).locator("article[data-target]");
  await expect(target).toContainText("You said: Start");
  await expect(target).toBeInViewport();
  await expect(target.getByRole("img", { name: "Saved" })).toBeVisible();
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

test("the model's memory goes with a turn, and the chat's settings show and clear it", async ({ page, keys }) => {
  await withProvider(page);
  await startChat(page, "Remember tea");
  await expect(messages(page).getByText("You said: Remember tea")).toBeVisible();
  const [chat] = [...keys.chats.chats.values()];
  keys.chats.memories.set(chat?.info.chat_id ?? "", "Likes tea\nLives by the sea");

  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Message" }).fill("What do I like?");
  await page.keyboard.press("Enter");
  await expect(messages(page).getByText("You said: What do I like?")).toBeVisible();
  expect(keys.chats.turns.at(-1)?.context.memory).toBe("Likes tea\nLives by the sea");

  await page.getByRole("button", { name: /^Chat settings: / }).click();
  const dialog = page.getByRole("dialog", { name: "Chat settings" });
  await expect(dialog.getByText("Lives by the sea")).toBeVisible();
  await dialog.getByRole("button", { name: "Clear memory" }).click();
  await expect(dialog.getByText("The model has saved nothing for this chat.")).toBeVisible();
  expect(keys.chats.memories.size).toBe(0);
});

test("a chat's settings are chosen in the composer and travel with its turns", async ({ page, keys }) => {
  await withProvider(page);
  await page.goto("/chats/new");
  const options = page.getByRole("button", { name: /^Chat settings: / });
  await expect(options).toHaveAccessibleName("Chat settings: some/model");
  await options.click();
  const dialog = page.getByRole("dialog", { name: "Chat settings" });
  await dialog.getByLabel("Reasoning effort").selectOption({ label: "High" });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(options).toHaveAccessibleName("Chat settings: some/model · High");
  await page.getByRole("textbox", { name: "Message" }).fill("First");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(messages(page).getByText("You said: First")).toBeVisible();
  // The first message created the chat with them.
  expect([...keys.chats.chats.values()][0]?.info.settings).toEqual({ effort: "high" });

  await options.click();
  await dialog.getByLabel("History sent with a message").selectOption({ label: "The last 10 messages" });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(options).toHaveAccessibleName("Chat settings: some/model · High · 10 messages");
  expect([...keys.chats.chats.values()][0]?.info.settings).toEqual({
    effort: "high",
    history: { mode: "recent", messages: 10 },
  });
});

test("a chat past its threshold compacts before a send, and a deletion under the summary deletes it", async ({
  page,
  keys,
}) => {
  await withProvider(page);
  // The account's default threshold, from Settings.
  await open(page, "/settings/general");
  const section = page.getByRole("region", { name: "Chats" });
  await section.getByLabel("Auto-compaction").selectOption({ label: "At about 16k tokens" });
  await expect(section.getByLabel("Auto-compaction")).toHaveValue("16000");
  await expect(section.getByLabel("History sent with a message")).toHaveValue("compact");

  // About 36k tokens of history once the reply echoes it.
  await startChat(page, `Long ${"x".repeat(70 * 1024)}`);
  await expect(messages(page).getByText(/^You said: Long/)).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Next");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(messages(page).getByText("You said: Next")).toBeVisible();

  // Both earlier messages folded; the send carried the summary instead.
  expect(keys.chats.compactions.map((c) => c.through)).toEqual([1]);
  expect(keys.chats.turns.at(-1)?.context).toEqual({ summary: "Summary of 2 messages", messages: [] });
  const card = messages(page).getByText("Summary of the messages above");
  await card.click();
  await expect(messages(page).getByText("Summary of 2 messages")).toBeVisible();

  // The first reply is under the summary: deleting it deletes the summary.
  await messages(page).getByRole("article").filter({ hasText: "You said: Long" }).getByRole("button").click();
  await page.getByRole("dialog", { name: "Message actions" }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete this message?" }).getByRole("button", { name: "Delete" }).click();
  await expect(messages(page).getByText("Summary deleted")).toBeVisible();
});

test("a chat takes the model's title after its first reply and a new one from each summary, until the user names it", async ({
  page,
  keys,
}) => {
  await withProvider(page);
  keys.chats.modelTitle = '"Sea trip."';
  await open(page, "/settings/general");
  const section = page.getByRole("region", { name: "Chats" });
  await section.getByLabel("Auto-compaction").selectOption({ label: "At about 16k tokens" });
  await expect(section.getByLabel("Auto-compaction")).toHaveValue("16000");
  // Past the threshold once the reply echoes it.
  await startChat(page, `Plan a trip ${"x".repeat(70 * 1024)}`);
  await expect(messages(page).getByText(/^You said: Plan a trip/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sea trip" })).toBeVisible();
  expect(keys.chats.titles.map((t) => t.context.messages.map((m) => m.role))).toEqual([["user", "assistant"]]);

  // A summary's title line renames the chat and does not show in the card.
  await page.getByRole("textbox", { name: "Message" }).fill("Next");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(messages(page).getByText("You said: Next")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Summed up 2" })).toBeVisible();
  await messages(page).getByText("Summary of the messages above").click();
  await expect(messages(page).getByText("Summary of 2 messages")).toBeVisible();
  await expect(messages(page).getByText(/<title>/)).toHaveCount(0);

  // A name the user gives stays.
  if (isPhone(page)) await backToChats(page);
  else await page.goto("/");
  await page.getByRole("button", { name: "Actions for Summed up 2" }).click();
  await page.getByRole("dialog", { name: "Summed up 2" }).getByRole("button", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename chat" });
  await rename.getByLabel("Title").fill("My trip");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Actions for My trip" })).toBeVisible();
  expect([...keys.chats.chats.values()][0]?.info.title_auto).toBe(false);
});

test("a chat's title takes one line beside the menu, however long", async ({ page }) => {
  await withProvider(page);
  const long = "A greeting and a long overview of everything this assistant can do for you and more";
  await startChat(page, long);
  const heading = page.getByRole("heading", { name: /^A greeting and a long/ });
  await expect(heading).toBeVisible();
  const box = await heading.boundingBox();
  expect(box?.height).toBeLessThan(40);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  // The whole title is there on hover.
  await expect(page.locator("main [title^='A greeting and a long']")).toHaveCount(1);
  if (isPhone(page)) expect(box?.y ?? 100).toBeLessThan(40);
});

test("the page itself does not scroll in a chat: only its messages do", async ({ page }) => {
  await withProvider(page);
  await startChat(page, "First");
  for (const text of ["Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"]) {
    await page.getByRole("textbox", { name: "Message" }).fill(`${text}\n${"line\n".repeat(8)}`);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
    await expect(page.getByRole("region", { name: "Messages" }).getByText(`You said: ${text}`)).toBeVisible();
  }
  const composer = page.getByRole("textbox", { name: "Message" });
  const before = await composer.boundingBox();
  const sizes = await page.evaluate(() => {
    window.scrollTo(0, 500);
    const root = document.documentElement;
    return { scroll: root.scrollHeight, client: root.clientHeight, y: window.scrollY };
  });
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
  expect(sizes.y).toBe(0);
  expect((await composer.boundingBox())?.y).toBe(before?.y);
  // A virtual keyboard takes the bottom of the screen: the composer stays above it.
  const size = page.viewportSize();
  await page.setViewportSize({ width: size?.width ?? 400, height: 360 });
  await expect
    .poll(async () => {
      const box = await composer.boundingBox();
      return (box?.y ?? 999) + (box?.height ?? 0);
    })
    .toBeLessThan(360);
  await page.setViewportSize(size ?? { width: 400, height: 800 });
  // A status line above the panes does not push the composer off the screen.
  await page.evaluate(() => {
    const line = document.createElement("div");
    line.style.height = "60px";
    document.querySelector("main")?.prepend(line);
  });
  const moved = await composer.boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect((moved?.y ?? 0) + (moved?.height ?? 0)).toBeLessThan(height);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(height);
});

test("messages scroll under the composer, stop clear of it, and it takes the clicks over them", async ({ page }) => {
  await withProvider(page);
  await startChat(page, "Hello");
  const reply = messages(page).getByText("You said: Hello");
  await expect(reply).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message" });
  const list = await messages(page).boundingBox();
  const covered = await composer.evaluate((input) => {
    const footer = input.closest("div[class*='footer']") as Element;
    const edge = footer.getBoundingClientRect();
    const hit = document.elementFromPoint(edge.left + 1, edge.top + edge.height / 2);
    return { bottom: edge.bottom, hit: footer.contains(hit) };
  });
  expect(list?.y ?? 0).toBeLessThan(covered.bottom);
  expect((list?.y ?? 0) + (list?.height ?? 0)).toBeGreaterThanOrEqual(covered.bottom - 1);
  expect(covered.hit).toBe(true);
  const [text, field] = [await reply.boundingBox(), await composer.boundingBox()];
  expect((text?.y ?? 0) + (text?.height ?? 0)).toBeLessThanOrEqual(field?.y ?? 0);
});

test("the composer shows its focus on the card, with no ring of its own", async ({ page }) => {
  await open(page, "/chats/new");
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.focus();
  expect(await composer.evaluate((input) => getComputedStyle(input).outlineStyle)).toBe("none");
});
