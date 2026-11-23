/** What an empty list shows: an icon, one sentence, optionally the action that fills it. */
import { type JSX, Show } from "solid-js";
import styles from "./EmptyState.module.css";
import { Icon } from "./Icon";

export function EmptyState(props: { icon: string; children: JSX.Element; action?: JSX.Element }): JSX.Element {
  return (
    <div class={styles["empty"]}>
      <span class={styles["icon"]}>
        <Icon name={props.icon} size="lg" />
      </span>
      <p class={styles["text"]}>{props.children}</p>
      <Show when={props.action}>{props.action}</Show>
    </div>
  );
}
