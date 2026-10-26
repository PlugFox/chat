/**
 * Toasts of the app: `useToasts().show(text)` puts one up for a few seconds
 * (D-089: what the server refused adds nothing to the chat and says so here).
 */
import { createContext, createSignal, type JSX, useContext } from "solid-js";
import { type Toast, Toaster } from "../design-system/components";
import { useI18n } from "../i18n/i18n";

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
