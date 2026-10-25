/** A 48×48 button with only an icon. `label` is required: it is the accessible name. */
import { type JSX, splitProps } from "solid-js";
import { Icon } from "./Icon";
import styles from "./IconButton.module.css";

export interface IconButtonProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "style" | "children"> {
  icon: string;
  label: string;
  variant?: "ghost" | "secondary" | "primary";
  mirrorInRtl?: boolean;
}

export function IconButton(props: IconButtonProps): JSX.Element {
  const [own, rest] = splitProps(props, ["icon", "label", "variant", "mirrorInRtl", "type"]);
  return (
    <button
      {...rest}
      type={own.type ?? "button"}
      class={styles["button"]}
      data-variant={own.variant ?? "ghost"}
      aria-label={own.label}
      title={own.label}
    >
      <Icon name={own.icon} mirrorInRtl={own.mirrorInRtl ?? false} />
    </button>
  );
}
