/**
 * An inline message. `info`/`success`/`warning` are announced politely
 * (`role="status"`), `danger` interrupts (`role="alert"`).
 */
import type { JSX } from "solid-js";
import styles from "./Banner.module.css";
import { Icon } from "./Icon";

export interface BannerProps {
  tone?: "info" | "success" | "warning" | "danger";
  children: JSX.Element;
}

const icons = { info: "info", success: "check", warning: "warning", danger: "error" } as const;

export function Banner(props: BannerProps): JSX.Element {
  const tone = () => props.tone ?? "info";
  return (
    <div class={styles["banner"]} data-tone={tone()} role={tone() === "danger" ? "alert" : "status"}>
      <Icon name={icons[tone()]} />
      <div class={styles["body"]}>{props.children}</div>
    </div>
  );
}
