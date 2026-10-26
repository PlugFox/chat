/**
 * The messages of a chat, virtualized (virtua): only the rows near the
 * viewport are in the DOM, each measured as it renders. It opens at the
 * end and keeps following the end while the user is there, so a streaming
 * reply stays in view; scrolled up, it stays put. `onRange` reports the
 * indexes in view, for fetching what they need.
 */
import { createEffect, createMemo, type JSX, on, onMount } from "solid-js";
import { VList, type VListHandle } from "virtua/solid";
import styles from "./MessageList.module.css";

export interface MessageListProps {
  count: number;
  label: string;
  /** Changes whenever a row may have grown (streaming text). */
  revision?: number;
  onRange?: (first: number, last: number) => void;
  children: (index: number) => JSX.Element;
}

/** Within this many pixels of the end counts as at the end. */
const END_SLACK = 32;

export function MessageList(props: MessageListProps): JSX.Element {
  let handle: VListHandle | undefined;
  let following = true;
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

  onMount(() => {
    toEnd();
    report();
  });
  createEffect(
    on(
      () => [props.count, props.revision] as const,
      () => {
        if (following) toEnd();
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
        following = atEnd(offset);
        report();
      }}
      onResize={() => {
        // A viewport that grew (a header got shorter) scrolls before its new
        // size is known, which reads as leaving the end: check it again.
        following ||= atEnd(handle?.scrollOffset ?? 0);
        if (following) toEnd();
      }}
    >
      {(index) => props.children(index)}
    </VList>
  );
}
