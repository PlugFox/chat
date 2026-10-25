/**
 * Material Symbols (Outlined 400) from `../icons/`, rendered as inline SVG
 * paths (no innerHTML). Decorative (`aria-hidden`) unless `label` is set.
 * Add icons with `bun scripts/add-icon.ts <name>`.
 */
import { For, type JSX } from "solid-js";
import styles from "./Icon.module.css";

const files = import.meta.glob<string>("../icons/*.svg", { query: "?raw", import: "default", eager: true });

const icons = new Map(
  Object.entries(files).map(([path, svg]) => [
    path.replace(/^.*\/(.+)\.svg$/, "$1"),
    [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1] ?? ""),
  ]),
);

export function iconNames(): string[] {
  return [...icons.keys()];
}

export interface IconProps {
  name: string;
  size?: "sm" | "md" | "lg";
  /** Accessible name; without it the icon is decorative. */
  label?: string;
  /** Flip in right-to-left layouts (arrows, send). */
  mirrorInRtl?: boolean;
}

export function Icon(props: IconProps): JSX.Element {
  const paths = () => {
    const found = icons.get(props.name);
    if (!found) throw new Error(`Unknown icon "${props.name}": bun scripts/add-icon.ts ${props.name}`);
    return found;
  };
  return (
    <svg
      class={styles["icon"]}
      data-size={props.size ?? "md"}
      data-mirror={props.mirrorInRtl ? "" : undefined}
      viewBox="0 -960 960 960"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <For each={paths()}>{(d) => <path d={d} />}</For>
    </svg>
  );
}
