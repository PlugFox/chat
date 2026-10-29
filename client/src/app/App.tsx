import { Navigate, Router, type RouteSectionProps, useLocation } from "@solidjs/router";
import { type JSX, lazy, Match, Show, Switch } from "solid-js";
import { useAuth } from "../auth/context";
import { AppShell, EntryShell, NavLink, NavList } from "../design-system/components";
import { VaultGate } from "../features/keys/VaultGate";
import { useI18n } from "../i18n/i18n";

/** Usable while the keys are locked: sign-out, sessions and deletion must never depend on unlocking. */
const LOCKED_OK = new Set(["/settings", "/ui-kit"]);

/** Reachable without signing in; everything else needs a session. */
const PUBLIC = new Set(["/sign-in", ...(import.meta.env.VITE_UI_KIT === "true" ? ["/ui-kit"] : [])]);

const LinkSignedOut = lazy(() => import("../features/keys/LinkPage").then((m) => ({ default: m.LinkSignedOut })));

const routes = [
  { path: "/sign-in", component: lazy(() => import("../features/auth/SignInPage")) },
  { path: ["/", "/chats/:id"], component: lazy(() => import("../features/chats/ChatsPage")) },
  { path: ["/notes", "/notes/:id"], component: lazy(() => import("../features/notes/NotesPage")) },
  { path: ["/registers", "/registers/:metric"], component: lazy(() => import("../features/registers/RegistersPage")) },
  { path: "/saved", component: lazy(() => import("../features/saved/SavedPage")) },
  { path: "/settings", component: lazy(() => import("../features/settings/SettingsPage")) },
  // Opened by a phone camera from a device-linking QR (docs/crypto.md, "Device linking").
  { path: "/link", component: lazy(() => import("../features/keys/LinkPage")) },
  // The UI kit ships in development and test builds only (docs/design-system.md).
  ...(import.meta.env.VITE_UI_KIT === "true"
    ? [{ path: "/ui-kit", component: lazy(() => import("../ui-kit/UiKit")) }]
    : []),
];

function Layout(props: RouteSectionProps): JSX.Element {
  const { t } = useI18n();
  const { state } = useAuth();
  const location = useLocation();
  return (
    <Switch>
      <Match when={location.pathname === "/sign-in"}>
        <EntryShell brand={t("app.name")}>{props.children}</EntryShell>
      </Match>
      <Match when={state().kind === "signed_out" && location.pathname === "/link"}>
        <EntryShell brand={t("app.name")}>
          <LinkSignedOut />
        </EntryShell>
      </Match>
      <Match when={state().kind === "signed_out" && !PUBLIC.has(location.pathname)}>
        <Navigate href="/sign-in" />
      </Match>
      <Match when={state().kind !== "loading" || PUBLIC.has(location.pathname)}>
        <Signed {...props} />
      </Match>
    </Switch>
  );
}

function Signed(props: RouteSectionProps): JSX.Element {
  const { t } = useI18n();
  const location = useLocation();
  return (
    <AppShell
      brand={t("app.name")}
      labels={{ nav: t("nav.label"), open: t("nav.open"), close: t("nav.close"), skip: t("app.skipToContent") }}
      nav={
        <NavList>
          <NavLink href="/" end active={location.pathname.startsWith("/chats/")} icon="chat">
            {t("nav.chats")}
          </NavLink>
          <NavLink href="/notes" icon="description">
            {t("nav.notes")}
          </NavLink>
          <NavLink href="/registers" icon="monitoring">
            {t("nav.registers")}
          </NavLink>
          <NavLink href="/saved" icon="bookmark">
            {t("nav.saved")}
          </NavLink>
          <NavLink href="/settings" icon="settings">
            {t("nav.settings")}
          </NavLink>
        </NavList>
      }
    >
      <Show when={!LOCKED_OK.has(location.pathname)} fallback={props.children}>
        <VaultGate>{props.children}</VaultGate>
      </Show>
    </AppShell>
  );
}

export function App(): JSX.Element {
  return <Router root={Layout}>{routes}</Router>;
}
