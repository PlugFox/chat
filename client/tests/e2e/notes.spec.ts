import type { Page } from "@playwright/test";
import { expect, isPhone, open, test } from "./fixtures";

function editor(page: Page) {
  return page.getByRole("textbox", { name: "Note text" });
}

function toolbar(page: Page) {
  return page.getByRole("toolbar", { name: "Formatting" });
}

/** Opens a new note and waits for its editor. */
async function newNote(page: Page): Promise<void> {
  await open(page, "/notes");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page).toHaveURL(/\/notes\/new$/);
  await expect(editor(page)).toBeVisible();
}

async function saved(page: Page): Promise<void> {
  await expect(page.getByRole("main").locator("p", { hasText: /^Saved$/ })).toBeVisible();
}

/** Pastes `text` as plain text into the editor, as a copy from a chat would come. */
async function pastePlain(page: Page, text: string): Promise<void> {
  await editor(page).evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

test("a note is created by typing, formatted, and opens again as it was", async ({ page, keys }) => {
  await newNote(page);
  await page.getByLabel("Title").fill("Trip plan");
  await editor(page).click();
  await page.keyboard.type("## Packing");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- passport");
  await page.keyboard.press("Enter");
  await page.keyboard.type("tickets");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(toolbar(page).getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("Do not forget");
  await saved(page);
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);

  // The server holds sealed records only.
  const [note] = [...keys.notes.notes.values()];
  expect(Buffer.from(note?.body ?? []).includes("passport")).toBe(false);
  expect(Buffer.from(note?.info.title ?? []).includes("Trip plan")).toBe(false);

  await page.reload();
  await expect(editor(page).getByRole("heading", { name: "Packing" })).toBeVisible();
  await expect(editor(page).getByRole("listitem")).toHaveText(["passport", "tickets"]);
  await expect(editor(page).locator("strong")).toHaveText("Do not forget");
  await expect(page.getByLabel("Title")).toHaveValue("Trip plan");

  if (isPhone(page)) await page.getByRole("button", { name: "Back to notes" }).click();
  const row = page.getByRole("link", { name: /Trip plan/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Packing passport tickets");
});

test("tasks tick, tables and callouts come from the toolbar", async ({ page }) => {
  await newNote(page);
  await editor(page).click();
  await toolbar(page).getByRole("button", { name: "Task list" }).click();
  await page.keyboard.type("Buy milk");
  const task = editor(page).getByRole("checkbox", { name: "Not done" });
  await task.click();
  await expect(editor(page).getByRole("checkbox", { name: "Done" })).toBeChecked();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");

  await toolbar(page).getByRole("button", { name: "Table" }).click();
  await page.keyboard.type("Day");
  await expect(editor(page).getByRole("table")).toBeVisible();
  await toolbar(page).getByRole("button", { name: "Table" }).click();
  await page.getByRole("dialog", { name: "Table" }).getByRole("button", { name: "Add a row" }).click();
  await expect(editor(page).getByRole("row")).toHaveCount(4);

  await editor(page).locator("p").last().click();
  await toolbar(page).getByRole("button", { name: "Callout" }).click();
  await page.keyboard.type("Shops close at 8");
  await expect(editor(page).locator("aside[data-callout='note']")).toHaveText("Shops close at 8");
  await toolbar(page).getByRole("button", { name: "Callout" }).click();
  await page.getByRole("dialog", { name: "Callout" }).getByRole("button", { name: "Warning" }).click();
  await expect(editor(page).locator("aside[data-callout='warning']")).toBeVisible();
  await saved(page);
});

test("pasted Markdown keeps its structure and charts", async ({ page }) => {
  await newNote(page);
  await editor(page).click();
  const chart = JSON.stringify({
    kind: "bar",
    title: "Steps",
    labels: ["Mon", "Tue"],
    series: [{ name: "Steps", values: [4000, 6500] }],
  });
  await pastePlain(page, `# Week\n\n1. walk\n2. swim\n\n\`\`\`chart\n${chart}\n\`\`\`\n`);
  await expect(editor(page).getByRole("heading", { name: "Week" })).toBeVisible();
  await expect(editor(page).locator("ol > li")).toHaveText(["walk", "swim"]);
  await expect(editor(page).getByRole("figure")).toContainText("Steps");
  await saved(page);
});

test("a change made elsewhere meanwhile leaves this version as a copy", async ({ page, keys }) => {
  await newNote(page);
  await page.getByLabel("Title").fill("Budget");
  await saved(page);
  keys.notes.conflictNext = true;
  await editor(page).click();
  await page.keyboard.type("my version");
  await expect(page.getByText("Your version was saved as a copy.")).toBeVisible();
  await saved(page);
  expect(keys.notes.notes.size).toBe(2);
  await expect(page.getByRole("heading", { name: /Budget \(copy / })).toBeVisible();
  await expect(page.getByLabel("Title")).toHaveValue(/^Budget \(copy /);
});

test("a note is deleted after a confirmation", async ({ page, keys }) => {
  await newNote(page);
  await page.getByLabel("Title").fill("Old");
  await saved(page);
  await page.getByRole("button", { name: "Delete note" }).click();
  await page.getByRole("dialog", { name: "Delete this note?" }).getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.getByText("No notes yet.", { exact: false })).toBeVisible();
  expect(keys.notes.notes.size).toBe(0);
});

test("the toolbar hides what scrolls under it, also in the gutters and above", async ({ page }) => {
  await newNote(page);
  await editor(page).click();
  for (let i = 0; i < 60; i += 1) await page.keyboard.press("Enter");
  const covered = await page.evaluate(() => {
    const bar = document.querySelector('[role="toolbar"]')?.parentElement;
    let scroller = bar?.parentElement ?? null;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
    if (!bar || !scroller) return null;
    scroller.scrollTop = 400;
    const s = scroller.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    const top = document.elementFromPoint(s.left + s.width / 2, s.top + 1);
    const side = document.elementFromPoint(s.left + 2, b.top + b.height / 2);
    return { top: !top?.closest("[data-rich-text]"), side: !side?.closest("[data-rich-text]") };
  });
  expect(covered).toEqual({ top: true, side: true });
});
