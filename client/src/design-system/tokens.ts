/**
 * Design tokens: reads the DTCG JSON files in `tokens/`, resolves `{path}`
 * references and renders the CSS custom properties of every theme. Runs at
 * build time (Vite plugin) and in tests, never in the browser.
 *
 * - `primitives.json` is the raw palette. It is never emitted, so components
 *   cannot bypass the semantic layer.
 * - `base.json` holds theme-independent tokens, emitted on `:root`.
 * - `themes/<name>.json` holds the colors of a theme; a theme may extend another.
 *
 * See docs/design-system.md.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { systemThemes, type Theme, themes } from "./themes";

type TokenValue = string | number;
type FlatTokens = Map<string, TokenValue>;

interface ThemeMeta {
  colorScheme: "light" | "dark";
  extends?: Theme;
}

export interface ResolvedTokens {
  /** Theme-independent tokens: path to value. */
  base: FlatTokens;
  themes: Record<Theme, { meta: ThemeMeta; tokens: FlatTokens }>;
}

const REFERENCE = /\{([^}]+)\}/g;
const THEME_EXTENSION = "chat.theme";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Flattens a DTCG group into `a.b.c` → `$value`, skipping `$`-keys. */
function flatten(group: Record<string, unknown>, prefix = "", out: FlatTokens = new Map()): FlatTokens {
  for (const [key, node] of Object.entries(group)) {
    if (key.startsWith("$") || typeof node !== "object" || node === null) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const record = node as Record<string, unknown>;
    if ("$value" in record) {
      const value = record["$value"];
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`Token ${path}: $value must be a string or a number`);
      }
      out.set(path, value);
    } else {
      flatten(record, path, out);
    }
  }
  return out;
}

function resolve(path: string, scope: FlatTokens, seen: string[] = []): TokenValue {
  const value = scope.get(path);
  if (value === undefined) {
    const from = seen.at(-1);
    throw new Error(`Unknown token {${path}}${from ? ` referenced by ${from}` : ""}`);
  }
  if (seen.includes(path)) throw new Error(`Circular token reference: ${[...seen, path].join(" → ")}`);
  if (typeof value === "number") return value;
  // A value that is exactly one reference keeps the referenced type (numbers stay numbers).
  const whole = /^\{([^}]+)\}$/.exec(value);
  if (whole?.[1]) return resolve(whole[1], scope, [...seen, path]);
  return value.replace(REFERENCE, (_, ref: string) => String(resolve(ref, scope, [...seen, path])));
}

function resolveAll(own: FlatTokens, scope: FlatTokens): FlatTokens {
  const out: FlatTokens = new Map();
  for (const path of own.keys()) out.set(path, resolve(path, scope));
  return out;
}

export function loadTokens(dir: string): ResolvedTokens {
  const primitives = flatten(readJson(join(dir, "primitives.json")));
  const baseOwn = flatten(readJson(join(dir, "base.json")));
  const base = resolveAll(baseOwn, new Map([...primitives, ...baseOwn]));

  const raw = new Map<Theme, { meta: ThemeMeta; own: FlatTokens }>();
  for (const name of themes) {
    const json = readJson(join(dir, "themes", `${name}.json`));
    const extensions = json["$extensions"] as Record<string, ThemeMeta> | undefined;
    const meta = extensions?.[THEME_EXTENSION];
    if (!meta) throw new Error(`Theme ${name}: missing $extensions["${THEME_EXTENSION}"]`);
    raw.set(name, { meta, own: flatten(json) });
  }

  const ownWithParents = (name: Theme, chain: Theme[] = []): FlatTokens => {
    const theme = raw.get(name);
    if (!theme) throw new Error(`Unknown theme ${name}`);
    if (chain.includes(name)) throw new Error(`Circular theme extends: ${[...chain, name].join(" → ")}`);
    const parent = theme.meta.extends ? ownWithParents(theme.meta.extends, [...chain, name]) : new Map();
    return new Map([...parent, ...theme.own]);
  };

  const resolved = {} as ResolvedTokens["themes"];
  for (const name of themes) {
    const own = ownWithParents(name);
    for (const path of own.keys()) {
      if (base.has(path)) throw new Error(`Theme ${name}: ${path} is already defined in base.json`);
    }
    const meta = raw.get(name)?.meta;
    if (!meta) throw new Error(`Unknown theme ${name}`);
    resolved[name] = { meta, tokens: resolveAll(own, new Map([...primitives, ...baseOwn, ...own])) };
  }

  const reference = [...resolved.light.tokens.keys()].sort().join();
  for (const name of themes) {
    if ([...resolved[name].tokens.keys()].sort().join() !== reference) {
      throw new Error(`Theme ${name} must define the same tokens as light (directly or via extends)`);
    }
  }

  return { base, themes: resolved };
}

/** `color.bg.default` → `--color-bg-default` */
export function cssVar(path: string): string {
  return `--${path.replaceAll(".", "-")}`;
}

function declarations(tokens: FlatTokens, indent: string): string {
  return [...tokens].map(([path, value]) => `${indent}${cssVar(path)}: ${value};`).join("\n");
}

function themeBlock(selector: string, theme: ResolvedTokens["themes"][Theme], indent = ""): string {
  const inner = `${indent}  `;
  return `${indent}${selector} {\n${inner}color-scheme: ${theme.meta.colorScheme};\n${declarations(theme.tokens, inner)}\n${indent}}`;
}

/** Renders every token as CSS custom properties (see docs/design-system.md, "Themes"). */
export function renderCss(tokens: ResolvedTokens): string {
  const auto = ":root:not([data-theme])";
  return [
    "/* Generated from src/design-system/tokens/ by src/design-system/tokens.ts. Do not edit. */",
    `:root {\n${declarations(tokens.base, "  ")}\n}`,
    themeBlock(":root", tokens.themes[systemThemes.light]),
    `@media (prefers-color-scheme: dark) {\n${themeBlock(auto, tokens.themes[systemThemes.dark], "  ")}\n}`,
    ...themes.map((name) => themeBlock(`:root[data-theme="${name}"]`, tokens.themes[name])),
    "",
  ].join("\n\n");
}

/** Every CSS custom property name the tokens define (with `--`). */
export function tokenNames(tokens: ResolvedTokens): Set<string> {
  const names = new Set([...tokens.base.keys()].map(cssVar));
  for (const name of themes) for (const path of tokens.themes[name].tokens.keys()) names.add(cssVar(path));
  return names;
}
