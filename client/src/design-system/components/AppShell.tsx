/**
 * The application frame: a navigation sidebar and the main region. From the
 * expanded breakpoint (52.5rem) the sidebar is always visible, as a rail of
 * icons until 90rem (`NavLink` follows the same width); below it is an
 * off-canvas drawer opened by the menu button, `inert` while closed, closed by
 * Esc, the scrim or choosing a link. Focus moves to the first link on open and
 * back to the menu button on close. A screen with `data-fill-shell` gets exactly
 * the height the visual viewport leaves, for browsers that keep the layout
 * size under a virtual keyboard.
 */
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import styles from "./AppShell.module.css";
import { IconButton } from "./IconButton";
import { SkipLink } from "./SkipLink";

export interface AppShellProps {
  brand: JSX.Element;
  /** Usually a list of `NavLink`s. */
  nav: JSX.Element;
  /** Status line above the content (connection state), if any. */
  status?: JSX.Element;
  labels: { nav: string; open: string; close: string; skip: string };
  children: JSX.Element;
}

const EXPANDED = "(width >= 52.5rem)";

export function AppShell(props: AppShellProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [expanded, setExpanded] = createSignal(true);
  let menuButton: HTMLButtonElement | undefined;
  let drawer: HTMLElement | undefined;
  let shell: HTMLDivElement | undefined;

  onMount(() => {
    const viewport = window.visualViewport;
    if (viewport) {
      const fit = () => {
        shell?.style.setProperty("--shell-viewport", `${viewport.height}px`);
        // Such a browser also moves the page up to show the field: the shell has made room.
        if (shell?.querySelector("[data-fill-shell]")) window.scrollTo(0, 0);
      };
      fit();
      viewport.addEventListener("resize", fit);
      onCleanup(() => viewport.removeEventListener("resize", fit));
    }
    const query = window.matchMedia(EXPANDED);
    const update = () => {
      setExpanded(query.matches);
      if (query.matches) setOpen(false);
    };
    update();
    query.addEventListener("change", update);
    onCleanup(() => query.removeEventListener("change", update));
  });

  const show = () => {
    setOpen(true);
    drawer?.querySelector<HTMLElement>("a")?.focus();
  };
  const hide = () => {
    setOpen(false);
    menuButton?.focus();
  };

  return (
    <div ref={shell} class={styles["shell"]} data-open={open() ? "" : undefined}>
      <SkipLink target="main">{props.labels.skip}</SkipLink>
      <header class={styles["topbar"]}>
        <div class={styles["menu"]}>
          <IconButton ref={menuButton} icon="menu" label={props.labels.open} aria-expanded={open()} onClick={show} />
        </div>
        <div class={styles["brand"]}>{props.brand}</div>
      </header>
      <Show when={open()}>
        <div class={styles["scrim"]} aria-hidden="true" onClick={hide} />
      </Show>
      <nav
        ref={drawer}
        class={styles["sidebar"]}
        aria-label={props.labels.nav}
        inert={!expanded() && !open()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open()) hide();
        }}
        onClick={(e) => {
          if (!expanded() && (e.target as Element).closest("a")) hide();
        }}
      >
        <div class={styles["sidebar-header"]}>
          <div class={styles["brand"]}>{props.brand}</div>
          <Show when={!expanded()}>
            <IconButton icon="close" label={props.labels.close} onClick={hide} />
          </Show>
        </div>
        {props.nav}
      </nav>
      <main id="main" class={styles["main"]} tabindex="-1">
        <Show when={props.status}>
          <div class={styles["status"]}>{props.status}</div>
        </Show>
        {props.children}
      </main>
    </div>
  );
}
