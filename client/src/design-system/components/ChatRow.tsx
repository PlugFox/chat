/**
 * A chat in the list: a link with its title and a muted line (when it last
 * changed, a turn running), then its actions. `ChatRows` holds them in a
 * `ul`; with `reorder` each row gets a drag handle that moves it by pointer
 * (mouse, touch, pen) or by the arrow keys, for pinned chats (D-080).
 */
import { A } from "@solidjs/router";
import { createSignal, For, type JSX, Show } from "solid-js";
import styles from "./ChatRow.module.css";
import { Icon } from "./Icon";

export interface ChatRowProps {
  href: string;
  title: string;
  /** The title is a placeholder (untitled, unreadable): shown muted. */
  placeholder?: boolean;
  detail?: string;
  /** The open chat. */
  current?: boolean;
  /** Icon before the title, such as a pin; decorative, say it in `detail` too if it matters. */
  icon?: string;
  /** A turn is running: a pulsing dot, named by `busyLabel`. */
  busy?: boolean;
  busyLabel?: string;
  /** The drag handle `ChatRows` passes when reordering. */
  handle?: JSX.Element | undefined;
  actions?: JSX.Element;
}

export function ChatRow(props: ChatRowProps): JSX.Element {
  return (
    <div class={styles["row"]} data-current={props.current ? "" : undefined}>
      {props.handle}
      <A href={props.href} class={styles["link"]} aria-current={props.current ? "page" : undefined}>
        <span class={styles["heading"]}>
          <Show when={props.icon}>{(name) => <Icon name={name()} size="sm" />}</Show>
          <span class={styles["title"]} data-placeholder={props.placeholder ? "" : undefined}>
            {props.title}
          </span>
          <Show when={props.busy}>
            <span class={styles["busy"]} role="img" aria-label={props.busyLabel} />
          </Show>
        </span>
        <Show when={props.detail}>
          <span class={styles["detail"]}>{props.detail}</span>
        </Show>
      </A>
      <Show when={props.actions}>
        <div class={styles["actions"]}>{props.actions}</div>
      </Show>
    </div>
  );
}

export interface ChatRowsProps<T> {
  items: readonly T[];
  key: (item: T) => string;
  label: string;
  /** Reordering by a handle on each row; `to` is the new index. */
  reorder?:
    | {
        handleLabel: (item: T) => string;
        onMove: (item: T, to: number) => void;
      }
    | undefined;
  /** The row; `handle` is the drag handle when reordering. */
  children: (item: T, handle: JSX.Element | undefined) => JSX.Element;
}

interface Drag {
  key: string;
  from: number;
  /** Midpoints of the rows when the drag started. */
  middles: number[];
  to: number;
}

export function ChatRows<T>(props: ChatRowsProps<T>): JSX.Element {
  const [drag, setDrag] = createSignal<Drag | null>(null);
  let list: HTMLUListElement | undefined;

  const target = (drag: Drag, y: number) => {
    let to = 0;
    for (const [i, middle] of drag.middles.entries()) if (i !== drag.from && y > middle) to += 1;
    return to;
  };

  const handle = (item: T, index: () => number) => {
    const reorder = props.reorder;
    if (!reorder) return undefined;
    const key = props.key(item);
    const move = (to: number) => {
      if (to < 0 || to >= props.items.length || to === index()) return;
      reorder.onMove(item, to);
      // The row moves under the focus: keep the focus on its handle.
      queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-handle="${CSS.escape(key)}"]`)?.focus());
    };
    return (
      <button
        type="button"
        class={styles["handle"]}
        data-handle={key}
        aria-label={reorder.handleLabel(item)}
        title={reorder.handleLabel(item)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            move(index() - 1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            move(index() + 1);
          } else if (e.key === "Escape") {
            setDrag(null);
          }
        }}
        onPointerDown={(e) => {
          if (!list) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const rows = [...list.children].map((li) => li.getBoundingClientRect());
          setDrag({ key, from: index(), to: index(), middles: rows.map((r) => r.top + r.height / 2) });
        }}
        onPointerMove={(e) => {
          const d = drag();
          if (d?.key === key) setDrag({ ...d, to: target(d, e.clientY) });
        }}
        onPointerUp={() => {
          const d = drag();
          setDrag(null);
          if (d?.key === key && d.to !== d.from) reorder.onMove(item, d.to);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <Icon name="drag_indicator" />
      </button>
    );
  };

  /** Where the dragged row would land, marked on the row it lands before or after. */
  const drop = (index: number): "before" | "after" | undefined => {
    const d = drag();
    if (!d || d.to === d.from) return undefined;
    if (index === d.to) return d.to < d.from ? "before" : "after";
    return undefined;
  };

  return (
    <ul ref={list} class={styles["rows"]} aria-label={props.label}>
      <For each={props.items}>
        {(item, index) => (
          <li
            class={styles["item"]}
            data-dragging={drag()?.key === props.key(item) ? "" : undefined}
            data-drop={drop(index())}
          >
            {props.children(item, handle(item, index))}
          </li>
        )}
      </For>
    </ul>
  );
}
