// @vitest-environment node
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { themes } from "../../src/design-system/themes";
import { loadTokens, renderCss } from "../../src/design-system/tokens";

const tokens = loadTokens(join(import.meta.dirname, "../../src/design-system/tokens"));

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`not a #rrggbb color: ${hex}`);
  const channel = (i: number) => {
    const c = Number.parseInt(match[1]?.slice(i, i + 2) ?? "0", 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The text/background pairs components use, and the minimum ratio:
 * 4.5 for text (WCAG 1.4.3), 3 for control boundaries and focus (1.4.11).
 * When a component puts one token on another, add the pair here.
 */
const pairs: [fg: string, bg: string, min: number][] = [
  ["color.fg.default", "color.bg.default", 4.5],
  ["color.fg.default", "color.bg.subtle", 4.5],
  ["color.fg.default", "color.bg.raised", 4.5],
  ["color.fg.muted", "color.bg.default", 4.5],
  ["color.fg.muted", "color.bg.subtle", 4.5],
  ["color.fg.muted", "color.bg.raised", 4.5],
  ["color.fg.link", "color.bg.default", 4.5],
  ["color.fg.link", "color.bg.raised", 4.5],
  ["color.fg.inverse", "color.bg.inverse", 4.5],
  ["color.accent.fg", "color.accent.default", 4.5],
  ["color.accent.subtle-fg", "color.accent.subtle", 4.5],
  ["color.danger.fg", "color.danger.default", 4.5],
  ["color.danger.subtle-fg", "color.danger.subtle", 4.5],
  ["color.danger.subtle-fg", "color.bg.default", 4.5],
  ["color.danger.subtle-fg", "color.bg.raised", 4.5],
  ["color.success.subtle-fg", "color.success.subtle", 4.5],
  ["color.warning.subtle-fg", "color.warning.subtle", 4.5],
  ["color.border.strong", "color.bg.default", 3],
  ["color.border.strong", "color.bg.raised", 3],
  ["color.focus", "color.bg.default", 3],
  ["color.focus", "color.bg.raised", 3],
  ["color.accent.default", "color.bg.raised", 3],
  ["color.danger.default", "color.bg.raised", 3],
  ["color.qr.dark", "color.qr.light", 7],
];

describe("tokens", () => {
  for (const theme of themes) {
    it(`${theme}: contrast of every pair`, () => {
      const t = tokens.themes[theme].tokens;
      const failures = pairs
        .map(([fg, bg, min]) => ({ fg, bg, min, ratio: contrast(String(t.get(fg)), String(t.get(bg))) }))
        .filter((p) => p.ratio < p.min)
        .map((p) => `${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)} < ${p.min}`);
      expect(failures).toEqual([]);
    });
  }

  it("emits no primitives", () => {
    const css = renderCss(tokens);
    expect(css).not.toMatch(/--color-(neutral|indigo|red|green|amber|series)-/);
    expect(css).toContain(":root:not([data-theme])");
    for (const theme of themes) expect(css).toContain(`:root[data-theme="${theme}"]`);
  });
});
