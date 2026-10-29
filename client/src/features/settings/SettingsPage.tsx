import type { JSX } from "solid-js";
import { setThemePreference, themePreference } from "../../app/theme";
import { Page, Section, Select } from "../../design-system/components";
import type { ThemePreference } from "../../design-system/themes";
import { useI18n } from "../../i18n/i18n";
import { type Locale, locales } from "../../i18n/locales";
import { AccessSection } from "./access";
import { AccountSections } from "./account";
import { ChatsSection } from "./chats";
import { KeysSection } from "./keys";
import { ProvidersSection } from "./providers";

/** Language names in their own language: a reader of either finds theirs. */
const languageNames: Record<Locale, string> = { en: "English", ru: "Русский" };

export default function SettingsPage(): JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const themeOptions = (): { value: ThemePreference; label: string }[] => [
    { value: "system", label: t("settings.theme.system") },
    { value: "light", label: t("settings.theme.light") },
    { value: "dark", label: t("settings.theme.dark") },
  ];
  return (
    <Page title={t("settings.title")} narrow>
      <Section title={t("settings.appearance")}>
        <Select
          label={t("settings.theme")}
          value={themePreference()}
          options={themeOptions()}
          onChange={setThemePreference}
        />
        <Select
          label={t("settings.language")}
          value={locale()}
          options={locales.map((l) => ({ value: l, label: languageNames[l] }))}
          onChange={setLocale}
        />
      </Section>
      <ProvidersSection />
      <ChatsSection />
      <AccessSection />
      <KeysSection />
      <AccountSections />
    </Page>
  );
}
