// Applies the saved theme before first paint (docs/design-system.md, "Themes").
// A file, not an inline script: the CSP allows scripts from 'self' only.
// Keep in sync with src/design-system/themes.ts.
(() => {
  try {
    const theme = localStorage.getItem("theme");
    const colors = { light: "#f7f8fa", dark: "#0f1115", amoled: "#000000" };
    if (Object.hasOwn(colors, theme)) {
      document.documentElement.dataset.theme = theme;
      // The browser's bars follow the chosen theme, not the system's.
      for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = colors[theme];
    }
  } catch {
    // Storage blocked: follow the system preference.
  }
})();
