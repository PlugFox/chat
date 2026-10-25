/**
 * The theme preference (docs/design-system.md, "Themes"): `system` removes
 * `data-theme` so CSS follows `prefers-color-scheme`; a theme sets it and is
 * remembered. `public/theme.js` applies the saved value before first paint.
 */
import { createSignal } from "solid-js";
import { isTheme, type ThemePreference, themeStorageKey } from "../design-system/themes";

function read(): ThemePreference {
  try {
    const saved = localStorage.getItem(themeStorageKey);
    return isTheme(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

const [preference, setPreferenceSignal] = createSignal<ThemePreference>(read());

export { preference as themePreference };

export function setThemePreference(next: ThemePreference): void {
  setPreferenceSignal(next);
  const root = document.documentElement;
  try {
    if (next === "system") localStorage.removeItem(themeStorageKey);
    else localStorage.setItem(themeStorageKey, next);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  if (next === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = next;
}
