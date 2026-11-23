/** Flex layout with token gaps; use it instead of custom flex CSS. */
import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import styles from "./Stack.module.css";

export interface StackProps {
  as?: "div" | "section" | "ul" | "ol" | "li" | "form" | "header" | "footer";
  direction?: "column" | "row";
  gap?: "none" | "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
  align?: "start" | "center" | "end" | "stretch" | "baseline";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
  /** Grow to fill the parent stack. */
  grow?: boolean;
  /** For `as="form"`: what a submit button outside it names in `form`. */
  id?: string;
  /** For `as="form"`. */
  onSubmit?: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
  "aria-labelledby"?: string;
  children: JSX.Element;
}

export function Stack(props: StackProps): JSX.Element {
  return (
    <Dynamic
      component={props.as ?? "div"}
      class={styles["stack"]}
      data-direction={props.direction ?? "column"}
      data-gap={props.gap ?? "md"}
      data-align={props.align ?? "stretch"}
      data-justify={props.justify ?? "start"}
      data-wrap={props.wrap ? "" : undefined}
      data-grow={props.grow ? "" : undefined}
      id={props.id}
      aria-labelledby={props["aria-labelledby"]}
      onSubmit={props.onSubmit}
      novalidate={props.as === "form" ? true : undefined}
    >
      {props.children}
    </Dynamic>
  );
}
