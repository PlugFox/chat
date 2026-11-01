import { deflateSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, open, test } from "./fixtures";

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real PNG of a gradient, `w`×`h`, that the browser decodes. */
function png(w: number, h: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y += 1) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x += 1) row.set([(x * 255) / w, (y * 255) / h, 128], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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

/** Opens a file's settings in the composer and keeps it. */
async function keepFile(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${name}.*File settings$`) }).click();
  const dialog = page.getByRole("dialog", { name });
  await dialog.getByRole("checkbox", { name: "Keep in this chat" }).check();
  return;
}

async function closeSettings(page: Page, name: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
}

async function attach(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(files);
}

function messages(page: Page) {
  return page.getByRole("region", { name: "Messages" });
}

test("an image and a text file are sent, encrypted, shown and described", async ({ page, keys }) => {
  keys.files.description = "A gradient from black to green.";
  await withProvider(page);
  await page.goto("/chats/new");
  await attach(page, [
    { name: "gradient.png", mimeType: "image/png", buffer: png(320, 200) },
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Shopping\n- milk") },
  ]);
  const tray = page.getByRole("list", { name: "Attached files" });
  await expect(tray.getByText("gradient.png")).toBeVisible();
  await expect(tray.getByText("notes.md")).toBeVisible();
  await expect(tray.locator("img")).toHaveCount(1);
  await keepFile(page, "gradient.png");
  await closeSettings(page, "gradient.png");
  await keepFile(page, "notes.md");
  await closeSettings(page, "notes.md");
  await expect(tray.getByText("kept")).toHaveCount(2);
  // A message of files alone sends.
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/);

  // The server got objects it cannot read and the keys for this turn only.
  expect(keys.files.puts).toHaveLength(2);
  const stored = [...keys.files.files.values()];
  for (const file of stored) {
    expect(Buffer.from(file.object ?? []).includes(Buffer.from("Shopping"))).toBe(false);
  }
  const turn = keys.chats.turns.at(-1);
  expect(turn?.files?.map((f) => [f.name, f.type, f.key.length])).toEqual([
    ["gradient.png", "image/png", 32],
    ["notes.md", "text/markdown", 32],
  ]);
  expect(turn?.files?.[0]).toMatchObject({ w: 320, h: 200 });

  const image = messages(page).getByRole("button", { name: /^Open gradient\.png/ });
  await expect(image).toBeVisible();
  await expect(messages(page).getByRole("button", { name: /^Save notes\.md/ })).toBeVisible();
  // The description is the image's alternative text once it comes.
  await expect(image.getByRole("img", { name: "A gradient from black to green." })).toBeVisible();
  await image.click();
  const viewer = page.getByRole("dialog", { name: "gradient.png" });
  await expect(viewer.getByRole("img", { name: "A gradient from black to green." })).toBeVisible();
  await expect(viewer.getByText("A gradient from black to green.")).toBeVisible();
  expect((await new AxeBuilder({ page }).include("dialog").analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();

  // A later turn tells the model of the files by their descriptions.
  await page.getByRole("textbox", { name: "Message" }).fill("What was on it?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(messages(page).getByText("You said: What was on it?")).toBeVisible();
  const context = keys.chats.turns.at(-1)?.context.messages[0];
  expect(context?.files?.[0]).toMatchObject({ name: "gradient.png", description: "A gradient from black to green." });
  expect(keys.chats.turns.at(-1)?.files).toBeUndefined();
});

test("a big image is sent compressed or as it is, as the user chooses", async ({ page, keys }) => {
  await withProvider(page);
  await page.goto("/chats/new");
  await attach(page, [{ name: "wide.png", mimeType: "image/png", buffer: png(2400, 300) }]);
  await expect(page.getByRole("list", { name: "Attached files" }).locator("img")).toHaveCount(1);
  // Only a kept image can go as it is.
  await page.getByRole("button", { name: /^wide\.png.*File settings$/ }).click();
  const dialog = page.getByRole("dialog", { name: "wide.png" });
  await expect(dialog.getByRole("checkbox", { name: "Send as is too" })).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "Keep in this chat" }).check();
  await dialog.getByRole("checkbox", { name: "Send as is too" }).check();
  await closeSettings(page, "wide.png");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/);
  // The copy the model reads, and the original beside it.
  const sent = keys.chats.turns.at(-1)?.files?.[0];
  expect(sent).toMatchObject({ w: 2000, h: 250, original: { type: "image/png" } });
  expect(keys.files.puts).toHaveLength(2);

  // Asked for the files again, the tab gives the copy's key and keeps the original's (D-101).
  const copy = sent?.file_id ?? "";
  const original = sent?.original?.file_id ?? "";
  keys.chats.replies.push({ ask: { tool: "read_file", file_id: original }, reason: "Look again" });
  keys.chats.replies.push({ ask: { tool: "read_file", file_id: copy }, reason: "Look again" });
  for (const [i, text] of ["First", "Second"].entries()) {
    await page.getByRole("textbox", { name: "Message" }).fill(text);
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => keys.chats.answers.length).toBe(i + 1);
  }
  expect(keys.chats.answers.map((a) => a.decision)).toEqual(["refuse", "answer"]);
  expect(Buffer.from(keys.chats.answers[1]?.result ?? "", "base64url")).toEqual(Buffer.from(sent?.key ?? []));
});

test("files no agent reads are refused before anything is sent", async ({ page, keys }) => {
  await withProvider(page);
  await page.goto("/chats/new");
  await attach(page, [{ name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from("not a video") }]);
  await expect(page.getByText("clip.mp4: the agents cannot read files of this type.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Attached files" })).toHaveCount(0);
  expect(keys.files.files.size).toBe(0);
});

test("a refused send takes its files back, and the server's notices show as toasts", async ({ page, keys }) => {
  await withProvider(page);
  await page.goto("/chats/new");
  await attach(page, [{ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Shopping") }]);
  await expect(page.getByRole("list", { name: "Attached files" }).getByText("notes.md")).toBeVisible();
  keys.chats.refuseNext = "turn.limit";
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Replies are being written in three other chats.", { exact: false })).toBeVisible();
  // The file was uploaded, then taken back: nothing waits on the server.
  expect(keys.files.puts).toHaveLength(1);
  expect(keys.files.forgotten).toEqual(keys.files.puts);
  expect(keys.files.files.size).toBe(0);
  // The message stays in the composer to send again.
  await expect(page.getByRole("list", { name: "Attached files" }).getByText("notes.md")).toBeVisible();

  keys.event("notice", { code: "file.undescribed", chat_id: crypto.randomUUID(), file_id: crypto.randomUUID() });
  await expect(page.getByText("The model could not describe a file.", { exact: false })).toBeVisible();
});

test("a file is not kept by default: no preview goes up and it stops opening after the reply", async ({
  page,
  keys,
}) => {
  keys.files.description = "A plate of pasta.";
  await withProvider(page);
  await page.goto("/chats/new");
  await attach(page, [{ name: "meal.png", mimeType: "image/png", buffer: png(320, 200) }]);
  await expect(page.getByRole("list", { name: "Attached files" }).locator("img")).toHaveCount(1);
  await page.getByRole("button", { name: /^meal\.png.*File settings$/ }).click();
  const settings = page.getByRole("dialog", { name: "meal.png" });
  await expect(settings.getByText("The AI provider may keep its own copy.", { exact: false })).toBeVisible();
  await expect(settings.getByRole("checkbox", { name: "Keep in this chat" })).not.toBeChecked();
  expect((await new AxeBuilder({ page }).include("dialog").analyze()).violations).toEqual([]);
  await closeSettings(page, "meal.png");
  await page.getByRole("textbox", { name: "Message" }).fill("Calories?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/);
  await expect(messages(page).getByText("You said: Calories?")).toBeVisible();

  const [file] = [...keys.files.files.values()];
  expect(file?.preview).toBeUndefined();
  await expect.poll(() => [...keys.files.files.values()][0]?.object).toBeUndefined();
  // The turn had it, and the message keeps its description.
  expect(keys.chats.turns.at(-1)?.files?.[0]?.name).toBe("meal.png");
  const image = messages(page).getByRole("button", { name: /^Open meal\.png/ });
  await expect(image.getByRole("img", { name: "A plate of pasta." })).toBeVisible();
  await image.click();
  const viewer = page.getByRole("dialog", { name: "meal.png" });
  await expect(viewer).toContainText("This file was not kept");
  expect((await new AxeBuilder({ page }).include("dialog").analyze()).violations).toEqual([]);
});
