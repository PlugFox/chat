/**
 * Words someone else wrote, set apart and named: a model's reason in a
 * permission dialog. A `<figure>` whose caption says whose words they are, so
 * nothing reads them as the app's own.
 */
import type { JSX } from "solid-js";
import styles from "./Quote.module.css";

export interface QuoteProps {
  /** Whose words these are ("The agent's reason"). */
  label: string;
  children: JSX.Element;
}

export function Quote(props: QuoteProps): JSX.Element {
  return (
    <figure class={styles["quote"]}>
      <figcaption class={styles["label"]}>{props.label}</figcaption>
      <blockquote class={styles["text"]}>{props.children}</blockquote>
    </figure>
  );
}
