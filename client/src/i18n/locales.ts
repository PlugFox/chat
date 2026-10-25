/** Supported locales; the first is the fallback and the message source (docs/i18n.md). */
export const locales = ["en", "ru"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

/** localStorage key of the explicit choice. */
export const localeStorageKey = "locale";

/** Right-to-left locales get `dir="rtl"`; none yet, the CSS is ready for them. */
const rtl: ReadonlySet<string> = new Set(["ar", "fa", "he", "ur"]);

export function isLocale(value: unknown): value is Locale {
  return (locales as readonly unknown[]).includes(value);
}

export function direction(locale: Locale): "ltr" | "rtl" {
  return rtl.has(locale) ? "rtl" : "ltr";
}

/** The saved choice, else the first supported browser language, else the default. */
export function detectLocale(saved: string | null, preferred: readonly string[]): Locale {
  if (isLocale(saved)) return saved;
  for (const tag of preferred) {
    const language = tag.toLowerCase().split("-")[0];
    if (isLocale(language)) return language;
  }
  return defaultLocale;
}
