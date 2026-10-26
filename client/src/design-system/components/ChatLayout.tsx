/**
 * A list and its open item side by side from the large breakpoint (75rem),
 * one at a time below it, as `showing` says: the chats, the notes. It fills
 * the height under the shell's top bar so each pane scrolls on its own.
 * While the item shows alone, the list and its `h1` are hidden, so the
 * screen gets a visually hidden `h1` (`title`) above the item's `h2`.
 */
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import styles from "./ChatLayout.module.css";

const SIDE_BY_SIDE = "(width >= 75rem)";

export interface ChatLayoutProps {
  /** The screen's name: the list's heading. */
  title: string;
  list: JSX.Element;
  detail: JSX.Element;
  /** Which pane shows below the large breakpoint. */
  showing: "list" | "detail";
}

export function ChatLayout(props: ChatLayoutProps): JSX.Element {
  const [wide, setWide] = createSignal(true);
  onMount(() => {
    const query = window.matchMedia(SIDE_BY_SIDE);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    onCleanup(() => query.removeEventListener("change", update));
  });
  return (
    <div class={styles["layout"]} data-showing={props.showing}>
      <Show when={!wide() && props.showing === "detail"}>
        <h1 class={styles["title"]}>{props.title}</h1>
      </Show>
      <div class={styles["list"]}>{props.list}</div>
      <div class={styles["detail"]}>{props.detail}</div>
    </div>
  );
}
