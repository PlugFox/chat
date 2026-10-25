/**
 * Translation context: `useI18n().t(key, values)` formats an ICU message for
 * the current locale; changing the locale updates `<html lang dir>` and every
 * string reactively (docs/i18n.md).
 */
import { IntlMessageFormat, type PrimitiveType } from "intl-messageformat";
import { createContext, createSignal, type JSX, useContext } from "solid-js";
import { direction, type Locale, localeStorageKey } from "./locales";
import { en, type MessageKey, type Messages } from "./messages/en";
import { ru } from "./messages/ru";

const catalogs: Record<Locale, Messages> = { en, ru };

export type Values = Record<string, PrimitiveType>;

export interface I18n {
  locale: () => Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, values?: Values) => string;
}

const cache = new Map<string, IntlMessageFormat>();

export function format(locale: Locale, key: MessageKey, values?: Values): string {
  const id = `${locale}\u0000${key}`;
  let message = cache.get(id);
  if (!message) {
    message = new IntlMessageFormat(catalogs[locale][key], locale);
    cache.set(id, message);
  }
  return String(message.format(values));
}

function apply(locale: Locale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = direction(locale);
}

const I18nContext = createContext<I18n>();

export function I18nProvider(props: { locale: Locale; children: JSX.Element }): JSX.Element {
  const [locale, setLocaleSignal] = createSignal(props.locale);
  apply(props.locale);
  const value: I18n = {
    locale,
    setLocale(next) {
      setLocaleSignal(next);
      apply(next);
      try {
        localStorage.setItem(localeStorageKey, next);
      } catch {
        // Storage blocked: the choice lasts for this page only.
      }
    },
    t: (key, values) => format(locale(), key, values),
  };
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const i18n = useContext(I18nContext);
  if (!i18n) throw new Error("useI18n outside I18nProvider");
  return i18n;
}
