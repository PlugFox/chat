/**
 * The chats screen: the chat list and the open chat side by side from the
 * large breakpoint (75rem), one at a time below it, as `showing` says. It
 * fills the height under the shell's top bar so each pane scrolls on its own.
 */
import type { JSX } from "solid-js";
import styles from "./ChatLayout.module.css";

export interface ChatLayoutProps {
  list: JSX.Element;
  detail: JSX.Element;
  /** Which pane shows below the large breakpoint. */
  showing: "list" | "detail";
}

export function ChatLayout(props: ChatLayoutProps): JSX.Element {
  return (
    <div class={styles["layout"]} data-showing={props.showing}>
      <div class={styles["list"]}>{props.list}</div>
      <div class={styles["detail"]}>{props.detail}</div>
    </div>
  );
}
