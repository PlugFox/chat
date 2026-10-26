/**
 * The messages of a chat, virtualized (virtua): only the rows near the
 * viewport are in the DOM, each measured as it renders. It opens at the
 * end and keeps following the end while the user is there, so a streaming
 * reply stays in view; scrolled up, it stays put. Given a `target`, it
 * opens there instead and keeps it centered while the rows around it load
 * and change size, until the user scrolls. `onRange` reports the indexes in
 * view, for fetching what they need.
 */
import { createEffect, createMemo, type JSX, on, onMount } from "solid-js";
import { VList, type VListHandle } from "virtua/solid";
import styles from "./MessageList.module.css";

export interface MessageListProps {
  count: number;
  label: string;
  /** Changes whenever a row may have grown (streaming text). */
  revision?: number;
  /** The index to open at, centered. */
  target?: number | undefined;
  onRange?: (first: number, last: number) => void;
  children: (index: number) => JSX.Element;
}

/** Within this many pixels of the end counts as at the end. */
const END_SLACK = 32;

export function MessageList(props: MessageListProps): JSX.Element {
  let handle: VListHandle | undefined;
  let following = props.target === undefined;
  /** The target is held until the user moves the list. */
  let holding = props.target !== undefined;
  const indexes = createMemo(() => Array.from({ length: props.count }, (_, i) => i));

  const report = () => {
    if (!handle || props.count === 0) return;
    const first = handle.findItemIndex(handle.scrollOffset);
    const last = handle.findItemIndex(handle.scrollOffset + handle.viewportSize);
    props.onRange?.(first, last);
  };
  const atEnd = (offset: number) => !!handle && offset + handle.viewportSize >= handle.scrollSize - END_SLACK;
  const toEnd = () => {
    if (handle && props.count > 0) handle.scrollToIndex(props.count - 1, { align: "end" });
  };
  const toTarget = () => {
    const target = props.target;
    if (handle && target !== undefined && target < props.count) handle.scrollToIndex(target, { align: "center" });
  };
  const place = () => {
    if (holding) toTarget();
    else if (following) toEnd();
  };
  const release = () => {
    holding = false;
  };

  onMount(() => {
    place();
    report();
  });
  createEffect(
    on(
      () => [props.count, props.revision] as const,
      () => {
        place();
        report();
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => props.target,
      (target) => {
        if (target === undefined) return;
        holding = true;
        following = false;
        place();
        report();
      },
      { defer: true },
    ),
  );

  return (
    <VList
      ref={(h) => {
        handle = h;
      }}
      class={styles["list"]}
      data={indexes()}
      role="region"
      aria-label={props.label}
      tabindex={0}
      onScroll={(offset) => {
        if (!holding) following = atEnd(offset);
        report();
      }}
      onResize={() => {
        // A viewport that grew (a header got shorter) scrolls before its new
        // size is known, which reads as leaving the end: check it again.
        if (!holding) following ||= atEnd(handle?.scrollOffset ?? 0);
        place();
      }}
      onWheel={release}
      onTouchStart={release}
      onPointerDown={release}
      onKeyDown={release}
    >
      {(index) => props.children(index)}
    </VList>
  );
}
