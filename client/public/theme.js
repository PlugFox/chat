// Applies the saved theme before first paint (docs/design-system.md, "Themes").
// A file, not an inline script: the CSP allows scripts from 'self' only.
// Keep in sync with src/design-system/themes.ts.
(() => {
  try {
    const theme = localStorage.getItem("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch {
    // Storage blocked: follow the system preference.
  }
})();
