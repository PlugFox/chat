// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(import.meta.dirname, "../../src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const all = files(src).filter((f) => !f.includes("/generated/"));
const outsideDesignSystem = all.filter((f) => !relative(src, f).startsWith("design-system/"));

describe("design-system contract (docs/design-system.md)", () => {
  it("styles live only in design-system components", () => {
    const css = outsideDesignSystem.filter((f) => f.endsWith(".css"));
    expect(css.map((f) => relative(src, f))).toEqual([]);
  });

  it("features, app and the UI kit set no class or style", () => {
    const offenders = outsideDesignSystem
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /\s(class|classList|style)=\{?/.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f));
    expect(offenders).toEqual([]);
  });

  it("every icon used exists", () => {
    const used = new Set<string>();
    for (const f of all.filter((f) => f.endsWith(".tsx"))) {
      for (const m of readFileSync(f, "utf8").matchAll(/\b(?:icon|name)="([a-z_]+)"/g)) used.add(m[1] ?? "");
    }
    const missing = [...used].filter((name) => !existsSync(join(src, "design-system/icons", `${name}.svg`)));
    expect(missing).toEqual([]);
  });
});
