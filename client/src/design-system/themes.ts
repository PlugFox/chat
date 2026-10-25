/**
 * Every theme, in the order the theme switcher lists them. Each name has a
 * file `tokens/themes/<name>.json`. `system` is not a theme: it is the absence
 * of `data-theme` on `<html>`, so CSS media queries pick one.
 */
export const themes = ["light", "dark"] as const;

export type Theme = (typeof themes)[number];

/** The theme preference: a theme, or follow the operating system. */
export type ThemePreference = Theme | "system";

/** Picked by `prefers-color-scheme` when there is no explicit choice. */
export const systemThemes = { light: "light", dark: "dark" } as const satisfies Record<string, Theme>;

/** localStorage key of the explicit choice; `public/theme.js` reads it before first paint. */
export const themeStorageKey = "theme";

export function isTheme(value: unknown): value is Theme {
  return (themes as readonly unknown[]).includes(value);
}
