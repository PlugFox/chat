/**
 * Settings (`/settings`, `/settings/:section`, D-109): the list of sections
 * beside the open one on large screens, one of them on smaller ones. Only the
 * open section is mounted, so a log loads when it is looked at.
 */
import { Navigate, useNavigate, useParams } from "@solidjs/router";
import { type JSX, Match, Switch } from "solid-js";
import { setThemePreference, themePreference } from "../../app/theme";
import {
  ChatLayout,
  ChatRow,
  ChatRows,
  IconButton,
  Pane,
  Section,
  Select,
  Stack,
} from "../../design-system/components";
import type { ThemePreference } from "../../design-system/themes";
import { useI18n } from "../../i18n/i18n";
import { type Locale, locales } from "../../i18n/locales";
import type { MessageKey } from "../../i18n/messages/en";
import { AccessSection } from "./access";
import { ActivitySection, DeleteSection, IdentitiesSection, SessionsSection, SignOutButton } from "./account";
import { ChatsSection } from "./chats";
import { KeysSection } from "./keys";
import { ProvidersSection } from "./providers";

/** Language names in their own language: a reader of either finds theirs. */
const languageNames: Record<Locale, string> = { en: "English", ru: "Русский" };

const DEFAULT = "general";

const sections: readonly { key: string; icon: string; title: MessageKey; hint: MessageKey }[] = [
  { key: DEFAULT, icon: "settings", title: "settings.general", hint: "settings.general.hint" },
  { key: "providers", icon: "link", title: "providers.title", hint: "settings.providers.hint" },
  { key: "keys", icon: "key", title: "keys.settings.title", hint: "settings.keys.hint" },
  { key: "account", icon: "mail", title: "settings.account", hint: "settings.account.hint" },
  { key: "devices", icon: "qr_code", title: "settings.sessions", hint: "settings.sessions.hint" },
  { key: "activity", icon: "monitoring", title: "settings.activity", hint: "settings.activity.hint" },
  { key: "access", icon: "description", title: "settings.access", hint: "settings.access.hint" },
];

function General(): JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const themeOptions = (): { value: ThemePreference; label: string }[] => [
    { value: "system", label: t("settings.theme.system") },
    { value: "light", label: t("settings.theme.light") },
    { value: "dark", label: t("settings.theme.dark") },
    { value: "amoled", label: t("settings.theme.amoled") },
  ];
  return (
    <Stack gap="lg">
      <Section title={t("settings.appearance")} flat>
        <Stack gap="md">
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
        </Stack>
      </Section>
      <ChatsSection />
    </Stack>
  );
}

function Account(): JSX.Element {
  return (
    <Stack gap="lg">
      <IdentitiesSection />
      <SignOutButton />
      <DeleteSection />
    </Stack>
  );
}

export default function SettingsPage(): JSX.Element {
  const { t } = useI18n();
  const params = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const open = () => params.section ?? DEFAULT;
  const known = () => sections.find((s) => s.key === open());
  return (
    <Switch>
      <Match when={!known()}>
        <Navigate href="/settings" />
      </Match>
      <Match when={known()} keyed>
        {(section) => (
          <ChatLayout
            title={t("settings.title")}
            showing={params.section ? "detail" : "list"}
            list={
              <Pane level={1} bar title={t("settings.title")} scroll>
                <ChatRows items={sections} key={(s) => s.key} label={t("settings.title")}>
                  {(s) => (
                    <ChatRow
                      href={`/settings/${s.key}`}
                      icon={s.icon}
                      title={t(s.title)}
                      detail={t(s.hint)}
                      current={s.key === params.section}
                    />
                  )}
                </ChatRows>
              </Pane>
            }
            detail={
              <Pane
                level={2}
                title={t(section.title)}
                scroll
                narrow
                bar
                leading={
                  params.section ? (
                    <IconButton
                      icon="arrow_back"
                      mirrorInRtl
                      label={t("settings.back")}
                      onClick={() => navigate("/settings")}
                    />
                  ) : undefined
                }
              >
                <Switch>
                  <Match when={section.key === "general"}>
                    <General />
                  </Match>
                  <Match when={section.key === "providers"}>
                    <ProvidersSection />
                  </Match>
                  <Match when={section.key === "keys"}>
                    <KeysSection />
                  </Match>
                  <Match when={section.key === "account"}>
                    <Account />
                  </Match>
                  <Match when={section.key === "devices"}>
                    <SessionsSection />
                  </Match>
                  <Match when={section.key === "activity"}>
                    <ActivitySection />
                  </Match>
                  <Match when={section.key === "access"}>
                    <AccessSection />
                  </Match>
                </Switch>
              </Pane>
            }
          />
        )}
      </Match>
    </Switch>
  );
}
