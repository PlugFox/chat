/**
 * The files of a message being written: a row of chips, each with the
 * image's preview or its file's icon, the name and a size, and a button that
 * removes it. With `onOpen`, the chip's preview and name are a button that
 * opens the file's settings. A chip still being prepared says so. The row
 * scrolls sideways when the chips do not fit.
 */
import { For, type JSX, Show } from "solid-js";
import styles from "./Attachments.module.css";
import { FileIcon } from "./FileIcon";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { VisuallyHidden } from "./VisuallyHidden";

export interface AttachmentItem {
  id: string;
  name: string;
  /** A muted line under the name: the size, "compressed". */
  meta?: string | undefined;
  /** An image's preview (a blob URL); without it the file's icon shows. */
  preview?: string | undefined;
  /** The `FileIcon` kind and extension. */
  kind: string;
  extension?: string | undefined;
  /** Still being prepared: no preview yet, and it cannot be removed. */
  busy?: boolean;
}

export interface AttachmentsProps {
  /** Names the list for screen readers ("Attached files"). */
  label: string;
  items: AttachmentItem[];
  /** The remove button's name; the file's name follows it. */
  removeLabel: string;
  /** Names a chip still being prepared. */
  busyLabel: string;
  /** The message is being sent: nothing can be removed. */
  locked?: boolean;
  onRemove: (id: string) => void;
  /** Opens a file's settings. */
  onOpen?: ((id: string) => void) | undefined;
  /** Follows the file's name and size in the settings button's name. */
  openLabel?: string | undefined;
}

export function Attachments(props: AttachmentsProps): JSX.Element {
  const content = (item: AttachmentItem) => (
    <>
      <Show when={item.preview} fallback={<FileIcon kind={item.kind} extension={item.extension} />}>
        {(src) => <img class={styles["preview"]} src={src()} alt="" />}
      </Show>
      <span class={styles["text"]}>
        <span class={styles["name"]}>{item.name}</span>
        <Show when={item.busy} fallback={<span class={styles["meta"]}>{item.meta}</span>}>
          <span class={styles["meta"]}>
            <span class={styles["spinner"]}>
              <Icon name="progress_activity" size="sm" />
            </span>
            {props.busyLabel}
          </span>
        </Show>
      </span>
    </>
  );
  return (
    <ul class={styles["list"]} aria-label={props.label}>
      <For each={props.items}>
        {(item) => (
          <li class={styles["chip"]} data-busy={item.busy ? "" : undefined}>
            <Show
              when={props.onOpen && !item.busy && !props.locked}
              fallback={<span class={styles["summary"]}>{content(item)}</span>}
            >
              <button type="button" class={styles["summary"]} onClick={() => props.onOpen?.(item.id)}>
                {content(item)}
                <VisuallyHidden>{props.openLabel}</VisuallyHidden>
              </button>
            </Show>
            <IconButton
              icon="close"
              label={`${props.removeLabel}: ${item.name}`}
              disabled={item.busy || props.locked}
              onClick={() => props.onRemove(item.id)}
            />
          </li>
        )}
      </For>
    </ul>
  );
}
