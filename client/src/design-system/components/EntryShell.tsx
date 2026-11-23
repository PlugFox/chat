/**
 * The frame for screens before sign-in: the brand and one centered column in
 * the `main` landmark. No navigation: nothing behind it is reachable yet.
 */
import type { JSX } from "solid-js";
import styles from "./EntryShell.module.css";

export function EntryShell(props: { brand: string; children: JSX.Element }): JSX.Element {
  return (
    <div class={styles["shell"]}>
      <header class={styles["brand"]}>{props.brand}</header>
      <main id="main" class={styles["main"]} tabindex="-1">
        {props.children}
      </main>
    </div>
  );
}
