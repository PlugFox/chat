/** "Skip to content": the first focusable element; visible on focus only. */
import type { JSX } from "solid-js";
import styles from "./SkipLink.module.css";

export function SkipLink(props: { target: string; children: JSX.Element }): JSX.Element {
  return (
    <a
      class={styles["link"]}
      href={`#${props.target}`}
      onClick={(e) => {
        // Hash links would fight the router; move focus instead.
        e.preventDefault();
        document.getElementById(props.target)?.focus();
      }}
    >
      {props.children}
    </a>
  );
}
