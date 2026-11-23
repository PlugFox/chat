/** Running text and labels. */
import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import styles from "./Text.module.css";

export interface TextProps {
  as?: "p" | "span" | "div";
  variant?: "body-lg" | "body-md" | "body-sm" | "label-lg" | "label-md";
  tone?: "default" | "muted";
  /** Limit the line length to a comfortable measure. */
  measure?: boolean;
  id?: string;
  children: JSX.Element;
}

export function Text(props: TextProps): JSX.Element {
  return (
    <Dynamic
      component={props.as ?? "p"}
      id={props.id}
      class={styles["text"]}
      data-variant={props.variant ?? "body-md"}
      data-tone={props.tone ?? "default"}
      data-measure={props.measure ? "" : undefined}
    >
      {props.children}
    </Dynamic>
  );
}
