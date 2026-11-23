/**
 * A button: at least 48×48 (`--size-target-min`), label always visible.
 * `primary` for the one main action of a view, `secondary` for the rest,
 * `danger` for destructive actions, `ghost` inside toolbars and lists.
 */
import { type JSX, Show, splitProps } from "solid-js";
import styles from "./Button.module.css";
import { Icon } from "./Icon";

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "style"> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  /** `md` is 48px tall, `lg` 56px. */
  size?: "md" | "lg";
  /** Leading icon name. */
  icon?: string;
  /** Stretch to the container width. */
  block?: boolean;
}

export function Button(props: ButtonProps): JSX.Element {
  const [own, rest] = splitProps(props, ["variant", "size", "icon", "block", "children", "type"]);
  return (
    <button
      {...rest}
      type={own.type ?? "button"}
      class={styles["button"]}
      data-variant={own.variant ?? "secondary"}
      data-size={own.size ?? "md"}
      data-block={own.block ? "" : undefined}
    >
      <Show when={own.icon}>{(name) => <Icon name={name()} size="sm" />}</Show>
      <span>{own.children}</span>
    </button>
  );
}
