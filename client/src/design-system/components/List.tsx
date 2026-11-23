/**
 * Rows of things with a title, details and actions (sessions, sign-in
 * methods, activity). A real `ul`/`li`, so screen readers announce the count.
 * Actions sit at the end of each row and wrap under it on narrow screens.
 */
import { type JSX, Show } from "solid-js";
import styles from "./List.module.css";

export function List(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <ul class={styles["list"]} aria-label={props.label}>
      {props.children}
    </ul>
  );
}

export interface ListItemProps {
  title: string;
  /** A short marker after the title, e.g. "This device". */
  badge?: string | undefined;
  /** Secondary lines, muted. */
  details?: string[];
  actions?: JSX.Element;
}

export function ListItem(props: ListItemProps): JSX.Element {
  return (
    <li class={styles["item"]}>
      <div class={styles["body"]}>
        <div class={styles["heading"]}>
          <span class={styles["title"]}>{props.title}</span>
          <Show when={props.badge}>
            <span class={styles["badge"]}>{props.badge}</span>
          </Show>
        </div>
        <Show when={props.details?.length}>
          <ul class={styles["details"]}>
            {props.details?.map((line) => (
              <li>{line}</li>
            ))}
          </ul>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class={styles["actions"]}>{props.actions}</div>
      </Show>
    </li>
  );
}
