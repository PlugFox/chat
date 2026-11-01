/**
 * One pane of a split screen: a header with an optional back button, the
 * heading and actions, then a body that scrolls (`scroll`) or that a child
 * fills and scrolls itself, with an optional footer pinned under it. `bar`
 * spends no height on the header: one line cut with an ellipsis, the whole
 * title in `tooltip`, and below the expanded breakpoint it sits in the shell's
 * top bar beside the menu button, over the brand. It stays in this pane's
 * reading order, so screen readers and the keyboard meet it where they did.
 */
import { type JSX, onMount, Show } from "solid-js";
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
  /** One line, in the shell's top bar on a phone. */
  bar?: boolean;
  /** The whole title on hover, when `bar` may cut it. */
  tooltip?: string | undefined;
  children: JSX.Element;
}

export function Pane(props: PaneProps): JSX.Element {
  let header: HTMLElement | undefined;
  onMount(() => {
    // As a page heading does (unless the skip link has the focus or just gave it to the content): after in-app navigation, a screen's first pane takes the focus.
    if (
      props.level === 1 &&
      document.activeElement &&
      document.activeElement !== document.body &&
      !document.activeElement.matches('main, a[href="#main"]')
    ) {
      header?.querySelector<HTMLElement>("h1")?.focus();
    }
  });
  return (
    <section class={styles["pane"]} data-bar={props.bar ? "" : undefined}>
      <header ref={header} class={styles["header"]}>
        <Show when={props.back}>
          <div class={styles["back"]}>{props.back}</div>
        </Show>
        <div class={styles["title"]} title={props.tooltip}>
          <Heading level={props.level} size={props.bar ? "title-md" : "title-lg"} focusable>
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
