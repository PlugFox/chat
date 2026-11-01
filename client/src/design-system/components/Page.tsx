/**
 * A screen inside the shell: the page heading (`h1`, focused after navigation
 * so screen readers announce the new page), optional actions, the content.
 */
import { type JSX, onMount, Show } from "solid-js";
import { Heading } from "./Heading";
import styles from "./Page.module.css";

export interface PageProps {
  title: string;
  actions?: JSX.Element;
  /** Narrow column for forms and settings. */
  narrow?: boolean;
  /** The content is still loading (`aria-busy`). */
  busy?: boolean;
  children: JSX.Element;
}

export function Page(props: PageProps): JSX.Element {
  let header: HTMLElement | undefined;
  onMount(() => {
    // Only after in-app navigation: on first load focus stays at the top for the skip link.
    if (
      document.activeElement &&
      document.activeElement !== document.body &&
      !document.activeElement.matches('main, a[href="#main"]')
    ) {
      header?.querySelector<HTMLElement>("h1")?.focus();
    }
  });
  return (
    <div class={styles["page"]} data-narrow={props.narrow ? "" : undefined} aria-busy={props.busy ? "true" : undefined}>
      <header ref={header} class={styles["header"]}>
        <Heading level={1} focusable>
          {props.title}
        </Heading>
        <Show when={props.actions}>
          <div class={styles["actions"]}>{props.actions}</div>
        </Show>
      </header>
      <div class={styles["content"]}>{props.children}</div>
    </div>
  );
}
