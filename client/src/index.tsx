import "./design-system/styles/global.css";
import { render } from "solid-js/web";
import { AgentProvider } from "./agent/context";
import { PermissionsProvider } from "./agent/permissions-context";
import { takeProviderFromUrl } from "./agent/share";
import { App } from "./app/App";
import { ToastProvider } from "./app/toasts";
import { AuthProvider } from "./auth/context";
import { ChatsProvider } from "./chats/context";
import { I18nProvider } from "./i18n/i18n";
import { detectLocale, localeStorageKey } from "./i18n/locales";
import { SocketProvider } from "./transport/context";
import { VaultProvider } from "./vault/context";
import { takeLinkFromUrl } from "./vault/link";

function savedLocale(): string | null {
  try {
    return localStorage.getItem(localeStorageKey);
  } catch {
    return null;
  }
}

// Before anything renders or navigates: the link secret and a shared API key leave the address bar at once.
takeLinkFromUrl();
takeProviderFromUrl();

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
const locale = detectLocale(savedLocale(), navigator.languages);
render(
  () => (
    <I18nProvider locale={locale}>
      <AuthProvider>
        <SocketProvider>
          <VaultProvider>
            <AgentProvider>
              <ChatsProvider>
                <PermissionsProvider>
                  <ToastProvider>
                    <App />
                  </ToastProvider>
                </PermissionsProvider>
              </ChatsProvider>
            </AgentProvider>
          </VaultProvider>
        </SocketProvider>
      </AuthProvider>
    </I18nProvider>
  ),
  root,
);
