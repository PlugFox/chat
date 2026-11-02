/** A navigation entry: icon and label, 48px tall; the current page gets `aria-current`. */
import { A } from "@solidjs/router";
import type { JSX } from "solid-js";
import { Icon } from "./Icon";
import styles from "./NavLink.module.css";

export interface NavLinkProps {
  href: string;
  icon: string;
  /** Match the path exactly (for `/`). */
  end?: boolean;
  /** Also current on other paths of its section (`/chats/…` for `/`). */
  active?: boolean;
  children: JSX.Element;
}

export function NavLink(props: NavLinkProps): JSX.Element {
  return (
    <A
      href={props.href}
      end={props.end ?? false}
      title={typeof props.children === "string" ? props.children : undefined}
      class={styles["link"]}
      activeClass={styles["active"] ?? ""}
      // The router marks the exact path; `active` marks the rest of the section.
      classList={props.active ? { [styles["active"] ?? ""]: true } : {}}
    >
      <Icon name={props.icon} />
      <span class={styles["label"]}>{props.children}</span>
    </A>
  );
}

/** The list that holds `NavLink`s. */
export function NavList(props: { children: JSX.Element }): JSX.Element {
  return <div class={styles["list"]}>{props.children}</div>;
}
