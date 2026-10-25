/** Content for screen readers only. */
import type { JSX } from "solid-js";
import styles from "./VisuallyHidden.module.css";

export function VisuallyHidden(props: { children: JSX.Element }): JSX.Element {
  return <span class={styles["hidden"]}>{props.children}</span>;
}
