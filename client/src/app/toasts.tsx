/**
 * Toasts of the app: `useToasts().show(text)` puts one up for a few seconds
 * (D-089: what the server refused adds nothing to the chat and says so here).
 * The server's `notice` events, about work that ended on its own, show here
 * too (docs/protocol.md, "Notices").
 */
import { createContext, createSignal, type JSX, onCleanup, useContext } from "solid-js";
import { type Toast, Toaster } from "../design-system/components";
import { useI18n } from "../i18n/i18n";
import type { MessageKey } from "../i18n/messages/en";
import type { NoticeCode } from "../protocol/generated/protocol";
import { useSocket } from "../transport/context";

/** What each notice says; a code this build does not know shows nothing. */
const notices: Record<NoticeCode, MessageKey> = {
  "file.undescribed": "notice.file.undescribed",
};

export interface Toasts {
  show: (text: string, tone?: Toast["tone"]) => void;
}

/** Long enough to read two lines; the close button ends it sooner. */
const SHOWN_MS = 8_000;

const Context = createContext<Toasts>();

export function ToastProvider(props: { children: JSX.Element }): JSX.Element {
  const { t } = useI18n();
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let next = 1;
  const dismiss = (id: number) => setToasts((all) => all.filter((toast) => toast.id !== id));
  const show = (text: string, tone: Toast["tone"] = "info") => {
    const id = next++;
    setToasts((all) => [...all.filter((toast) => toast.text !== text), { id, text, tone }]);
    setTimeout(() => dismiss(id), SHOWN_MS);
  };
  const unlisten = useSocket().onEvent((type, payload) => {
    if (type !== "notice") return;
    const key = notices[payload.code];
    if (key) show(t(key));
  });
  onCleanup(unlisten);
  return (
    <Context.Provider value={{ show }}>
      {props.children}
      <Toaster toasts={toasts()} onDismiss={dismiss} dismissLabel={t("common.close")} />
    </Context.Provider>
  );
}

export function useToasts(): Toasts {
  const context = useContext(Context);
  if (!context) throw new Error("useToasts outside ToastProvider");
  return context;
}
