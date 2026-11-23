/** A titled group inside a page (settings groups, UI kit sections); `flat` drops the card, for narrow panes. */
import { createUniqueId, type JSX } from "solid-js";
import { Heading } from "./Heading";
import styles from "./Section.module.css";

export function Section(props: { title: string; flat?: boolean; children: JSX.Element }): JSX.Element {
  const id = createUniqueId();
  return (
    <section class={styles["section"]} data-flat={props.flat ? "" : undefined} aria-labelledby={id}>
      <Heading level={2} size={props.flat ? "title-md" : "title-lg"} id={id}>
        {props.title}
      </Heading>
      {props.children}
    </section>
  );
}
