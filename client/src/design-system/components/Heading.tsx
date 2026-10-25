/** A heading. `level` is the document outline, `size` the look; they are independent. */
import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import styles from "./Heading.module.css";

export interface HeadingProps {
  level: 1 | 2 | 3 | 4;
  size?: "headline-lg" | "headline-md" | "headline-sm" | "title-lg" | "title-md";
  /** For headings that receive focus on navigation (route changes, dialogs). */
  focusable?: boolean;
  id?: string;
  children: JSX.Element;
}

const defaultSize = { 1: "headline-md", 2: "headline-sm", 3: "title-lg", 4: "title-md" } as const;

export function Heading(props: HeadingProps): JSX.Element {
  return (
    <Dynamic
      component={`h${props.level}`}
      id={props.id}
      class={styles["heading"]}
      data-size={props.size ?? defaultSize[props.level]}
      tabindex={props.focusable ? -1 : undefined}
    >
      {props.children}
    </Dynamic>
  );
}
