/**
 * One pane of a split screen: a header with an optional back button, the
 * heading and actions, then a body that scrolls (`scroll`) or that a child
 * fills and scrolls itself, with an optional footer pinned under it.
 */
import { type JSX, Show } from "solid-js";
import { Heading } from "./Heading";
import styles from "./Pane.module.css";

export interface PaneProps {
  title: JSX.Element;
  level: 1 | 2;
  /** Shown before the heading below the large breakpoint, where only one pane shows: a back button. */
  back?: JSX.Element;
  actions?: JSX.Element;
  /** The body scrolls; without it the child fills the body and scrolls itself. */
  scroll?: boolean;
  footer?: JSX.Element;
  children: JSX.Element;
}

export function Pane(props: PaneProps): JSX.Element {
  return (
    <section class={styles["pane"]}>
      <header class={styles["header"]}>
        <Show when={props.back}>
          <div class={styles["back"]}>{props.back}</div>
        </Show>
        <div class={styles["title"]}>
          <Heading level={props.level} size="title-lg" focusable>
            {props.title}
          </Heading>
        </div>
        <Show when={props.actions}>
          <div class={styles["actions"]}>{props.actions}</div>
        </Show>
      </header>
      <div class={styles["body"]} data-scroll={props.scroll ? "" : undefined}>
        {props.children}
      </div>
      <Show when={props.footer}>
        <div class={styles["footer"]}>{props.footer}</div>
      </Show>
    </section>
  );
}
