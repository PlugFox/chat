/**
 * A 48×48 button with only an icon. `label` is required: it is the
 * accessible name. `IconLink` looks the same and goes to a page. `size="sm"`
 * draws a small icon among content and takes the room of the icon alone; its
 * target is still 48×48, over what is around it, so one stands alone: two side
 * by side would take each other's taps.
 */
import { A } from "@solidjs/router";
import { type JSX, splitProps } from "solid-js";
import { Icon } from "./Icon";
import styles from "./IconButton.module.css";

export interface IconButtonProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "style" | "children"> {
  icon: string;
  label: string;
  variant?: "ghost" | "secondary" | "primary";
  size?: "md" | "sm";
  mirrorInRtl?: boolean;
}

export function IconButton(props: IconButtonProps): JSX.Element {
  const [own, rest] = splitProps(props, ["icon", "label", "variant", "size", "mirrorInRtl", "type"]);
  return (
    <button
      {...rest}
      type={own.type ?? "button"}
      class={styles["button"]}
      data-variant={own.variant ?? "ghost"}
      data-size={own.size === "sm" ? "sm" : undefined}
      aria-label={own.label}
      title={own.label}
    >
      <Icon name={own.icon} size={own.size === "sm" ? "xs" : "md"} mirrorInRtl={own.mirrorInRtl ?? false} />
    </button>
  );
}

export interface IconLinkProps {
  icon: string;
  label: string;
  href: string;
  variant?: "ghost" | "secondary" | "primary";
  size?: "md" | "sm";
  mirrorInRtl?: boolean;
}

export function IconLink(props: IconLinkProps): JSX.Element {
  return (
    <A
      href={props.href}
      class={styles["button"]}
      data-variant={props.variant ?? "ghost"}
      data-size={props.size === "sm" ? "sm" : undefined}
      aria-label={props.label}
      title={props.label}
    >
      <Icon name={props.icon} size={props.size === "sm" ? "xs" : "md"} mirrorInRtl={props.mirrorInRtl ?? false} />
    </A>
  );
}
