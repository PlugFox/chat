import { expect, open, pages, test } from "./fixtures";

test("pages carry the CSP and break none of it", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  for (const path of pages) await open(page, path);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain("style-src 'self'");
  expect(violations).toEqual([]);
});

test("no request leaves the origin", async ({ page }) => {
  const foreign: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1:4173/")) foreign.push(r.url());
  });
  for (const path of pages) await open(page, path);
  expect(foreign).toEqual([]);
});
