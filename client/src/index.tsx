import "./design-system/styles/global.css";
import { render } from "solid-js/web";
import { App } from "./app/App";
import { AuthProvider } from "./auth/context";
import { I18nProvider } from "./i18n/i18n";
import { detectLocale, localeStorageKey } from "./i18n/locales";
import { SocketProvider } from "./transport/context";
import { VaultProvider } from "./vault/context";

function savedLocale(): string | null {
  try {
    return localStorage.getItem(localeStorageKey);
  } catch {
    return null;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
const locale = detectLocale(savedLocale(), navigator.languages);
render(
  () => (
    <I18nProvider locale={locale}>
      <AuthProvider>
        <SocketProvider>
          <VaultProvider>
            <App />
          </VaultProvider>
        </SocketProvider>
      </AuthProvider>
    </I18nProvider>
  ),
  root,
);
