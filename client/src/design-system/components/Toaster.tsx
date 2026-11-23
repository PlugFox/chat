/**
 * Short notices that do not belong to any place on the screen, such as a
 * message the server refused (D-089). They stack at the bottom, are
 * announced politely (`danger` assertively) and stay until dismissed or
 * until the caller removes them.
 */
import { For, type JSX } from "solid-js";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import styles from "./Toaster.module.css";

export interface Toast {
  id: number;
  text: string;
  tone?: "info" | "danger";
}

export interface ToasterProps {
  toasts: readonly Toast[];
  onDismiss: (id: number) => void;
  dismissLabel: string;
}

export function Toaster(props: ToasterProps): JSX.Element {
  return (
    <div class={styles["toaster"]}>
      <For each={props.toasts}>
        {(toast) => (
          <div
            class={styles["toast"]}
            data-tone={toast.tone ?? "info"}
            role={toast.tone === "danger" ? "alert" : "status"}
          >
            <Icon name={toast.tone === "danger" ? "error" : "info"} />
            <p class={styles["text"]}>{toast.text}</p>
            <IconButton icon="close" label={props.dismissLabel} onClick={() => props.onDismiss(toast.id)} />
          </div>
        )}
      </For>
    </div>
  );
}
