/** A titled group inside a page (settings groups, UI kit sections). */
import { createUniqueId, type JSX } from "solid-js";
import { Heading } from "./Heading";
import styles from "./Section.module.css";

export function Section(props: { title: string; children: JSX.Element }): JSX.Element {
  const id = createUniqueId();
  return (
    <section class={styles["section"]} aria-labelledby={id}>
      <Heading level={2} size="title-lg" id={id}>
        {props.title}
      </Heading>
      {props.children}
    </section>
  );
}
